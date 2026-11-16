'use strict';
const { crud } = require('../../lib/crud');
const { HttpError } = require('../../lib/http');
const { validate } = require('../../lib/validate');
const { audit } = require('../../services/audit');
const { TEMPLATES } = require('../../agents/templates');
const tools = require('../../tools');
const memory = require('../../memory/memory');
const orchestrator = require('../../engine/orchestrator');

const S = (o = {}) => ({ type: 'string', ...o });
const AGENT_SCHEMA = {
  name: S({ required: true, min: 2, max: 80 }),
  avatar: S({ max: 8 }),
  title: S({ required: true, min: 2, max: 100 }),
  department: S({ max: 80 }),
  description: S({ max: 1000 }),
  goal: S({ max: 1000 }),
  system_prompt: S({ required: true, min: 20, max: 8000, trim: false }),
  skills: { type: 'array', max: 30, items: S({ max: 60 }) },
  tools: { type: 'array', max: 30, items: S({ max: 60, values: Object.keys(tools.DEFS) }) },
  permissions: { type: 'object', maxBytes: 4000 },
  provider: S({ values: ['openai', 'alt'] }),
  model: S({ max: 80 }),
  max_tokens_per_run: { type: 'int', min: 200, max: 16000 },
  monthly_token_limit: { type: 'int', min: 0, max: 1e12 },
  monthly_cost_limit_usd: { type: 'number', min: 0, max: 1e6 },
  status: S({ values: ['active', 'inactive'] }),
  role_key: S({ max: 30, pattern: /^[a-z][a-z0-9_]{1,29}$/, patternMsg: 'role_key: huruf kecil, angka, garis bawah' }),
  is_manager: { type: 'bool' },
  reports_to: { type: 'uuid', ref: 'agents' }
};

module.exports = (r) => {
  crud(r, {
    path: '/agents', table: 'agents', schema: AGENT_SCHEMA, label: 'Karyawan AI', orderBy: 'is_manager desc, created_at asc',
    search: ['name', 'title', 'department'], filters: ['status', 'department', 'role_key'], touch: true,
    methods: ['list', 'get', 'create', 'update', 'delete'], minWrite: 'manager', minDelete: 'admin',
    beforeUpdate: async ({ params }, data) => {
      if (data.reports_to && data.reports_to === params.id) throw new HttpError(400, 'Karyawan tidak boleh melapor ke dirinya sendiri');
      return data;
    }
  });

  r.get('/tools-catalog', async () => ({ items: tools.listDefs().map((t) => ({ name: t.name, description: t.description, permission: t.permission })) }));

  // ----- Template & rekrut -----
  r.get('/agent-templates', async ({ db, workspaceId }) => {
    const have = new Set((await db.query('select template_key from agents where workspace_id=$1 and template_key is not null', [workspaceId])).map((x) => x.template_key));
    return { items: TEMPLATES.map((t) => ({ key: t.key, name: t.name, avatar: t.avatar, title: t.title, department: t.department, description: t.description, goal: t.goal, skills: t.skills, tools: t.tools, is_manager: t.is_manager, hired: have.has(t.key) })) };
  });

  r.post('/agents/recruit', { min: 'manager' }, async (ctx) => {
    const b = validate({ template_key: S({ required: true, max: 40 }), name: S({ max: 80 }) }, ctx.body);
    const t = TEMPLATES.find((x) => x.key === b.template_key);
    if (!t) throw new HttpError(404, 'Template tidak ditemukan');
    const base = b.name || t.name;
    let name = base; let n = 1;
    while (await ctx.db.one('select 1 from agents where workspace_id=$1 and lower(name)=lower($2)', [ctx.workspaceId, name])) name = `${base} ${++n}`;
    let reportsTo = null;
    if (t.reports_to) { const m = await ctx.db.one("select id from agents where workspace_id=$1 and role_key=$2 order by created_at limit 1", [ctx.workspaceId, t.reports_to]); reportsTo = m && m.id; }
    const row = await ctx.db.one(
      `insert into agents (workspace_id, name, avatar, title, department, description, goal, system_prompt, skills, tools, permissions, role_key, is_manager, template_key, reports_to)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15) returning *`,
      [ctx.workspaceId, name, t.avatar, t.title, t.department, t.description, t.goal, t.system_prompt, t.skills, t.tools, JSON.stringify({ delegate: !!t.is_manager }), t.role_key, t.is_manager, t.key, reportsTo]);
    await ctx.db.exec('insert into departments (workspace_id, name) values ($1,$2) on conflict do nothing', [ctx.workspaceId, t.department]);
    await audit(ctx, 'agents.recruit', 'agents', row.id, { template: t.key });
    ctx.status = 201;
    return row;
  });

  // ----- Ikhtisar & evaluasi kinerja (dihitung dari data nyata) -----
  async function stats(db, ws, id) {
    const [runs, month, tasks, qa] = await Promise.all([
      db.one(`select count(*)::int as runs, count(*) filter (where status='succeeded')::int as succeeded, count(*) filter (where status in ('failed','timeout'))::int as failed,
              coalesce(sum(prompt_tokens+completion_tokens),0)::float as tokens, coalesce(sum(cost_usd),0)::float as cost_usd, coalesce(avg(duration_ms),0)::float as avg_ms
              from agent_runs where agent_id=$1 and workspace_id=$2`, [id, ws]),
      db.one("select coalesce(sum(prompt_tokens+completion_tokens),0)::float as tokens, coalesce(sum(cost_usd),0)::float as cost_usd from api_usage where agent_id=$1 and workspace_id=$2 and created_at >= date_trunc('month', now())", [id, ws]),
      db.query('select status, count(*)::int as n from tasks where assigned_agent_id=$1 and workspace_id=$2 group by status', [id, ws]),
      db.one("select count(*) filter (where qa_status='pass')::int as pass, count(*) filter (where qa_status='fail')::int as fail from tasks where assigned_agent_id=$1 and workspace_id=$2 and kind<>'qa'", [id, ws])
    ]);
    const byStatus = Object.fromEntries(tasks.map((t) => [t.status, t.n]));
    return { runs, month, tasks: byStatus, qa };
  }
  function evaluate(st) {
    const parts = []; const advice = [];
    if (st.runs.runs >= 1) parts.push({ key: 'run_success', label: 'Keberhasilan eksekusi', weight: 40, value: st.runs.succeeded / st.runs.runs });
    const done = st.tasks.done || 0, failed = (st.tasks.failed || 0) + (st.tasks.blocked || 0);
    if (done + failed >= 1) parts.push({ key: 'task_completion', label: 'Penyelesaian tugas', weight: 30, value: done / (done + failed) });
    if (st.qa.pass + st.qa.fail >= 1) parts.push({ key: 'qa_pass', label: 'Lolos pemeriksaan QA', weight: 30, value: st.qa.pass / (st.qa.pass + st.qa.fail) });
    if (st.runs.runs < 3 || !parts.length) return { score: null, rating: 'Belum cukup data', parts, advice: ['Minimal 3 eksekusi diperlukan untuk evaluasi yang bermakna.'], basis: st.runs.runs };
    const wsum = parts.reduce((s, p) => s + p.weight, 0);
    const score = Math.round(parts.reduce((s, p) => s + p.value * p.weight, 0) / wsum * 100);
    if (st.runs.failed / st.runs.runs > 0.3) advice.push('Banyak eksekusi gagal/timeout: periksa system prompt, tools yang diizinkan, dan koneksi API.');
    if (st.qa.fail > st.qa.pass && st.qa.fail > 0) advice.push('Hasil sering ditolak QA: perjelas system prompt dan batasan agar tidak mengarang data.');
    if (st.runs.avg_ms > 40000) advice.push('Rata-rata waktu eksekusi tinggi: kecilkan lingkup tugas atau turunkan batas token.');
    if (!advice.length) advice.push('Kinerja sesuai harapan. Pertahankan konfigurasi saat ini.');
    return { score, rating: score >= 85 ? 'Sangat baik' : score >= 70 ? 'Baik' : score >= 50 ? 'Cukup' : 'Perlu perbaikan', parts: parts.map((p) => ({ ...p, value: Math.round(p.value * 100) })), advice, basis: st.runs.runs };
  }

  r.get('/agents/:id/overview', async ({ db, workspaceId: ws, params }) => {
    const agent = await db.one('select * from agents where id=$1 and workspace_id=$2', [params.id, ws]);
    if (!agent) throw new HttpError(404, 'Karyawan tidak ditemukan');
    const [st, tasks, runs, mem, boss, reports] = await Promise.all([
      stats(db, ws, agent.id),
      db.query('select id, title, kind, status, priority, qa_status, created_at, finished_at, error from tasks where assigned_agent_id=$1 and workspace_id=$2 order by created_at desc limit 30', [agent.id, ws]),
      db.query('select id, task_id, phase, status, model, prompt_tokens, completion_tokens, cost_usd::float as cost_usd, duration_ms, error, started_at from agent_runs where agent_id=$1 and workspace_id=$2 order by started_at desc limit 30', [agent.id, ws]),
      db.query("select id, scope, content, importance, expires_at, created_at from agent_memories where agent_id=$1 and workspace_id=$2 and (expires_at is null or expires_at>now()) order by created_at desc limit 50", [agent.id, ws]),
      agent.reports_to ? db.one('select id, name from agents where id=$1', [agent.reports_to]) : null,
      db.query('select id, name, avatar, title from agents where reports_to=$1 and workspace_id=$2 order by name', [agent.id, ws])
    ]);
    return { agent, stats: st, evaluation: evaluate(st), tasks, runs, memories: mem, reports_to: boss, direct_reports: reports };
  });

  r.post('/agents/:id/evaluate', { min: 'manager' }, async (ctx) => {
    const a = await ctx.db.one('select id, name from agents where id=$1 and workspace_id=$2', [ctx.params.id, ctx.workspaceId]);
    if (!a) throw new HttpError(404, 'Karyawan tidak ditemukan');
    const ev = evaluate(await stats(ctx.db, ctx.workspaceId, a.id));
    await audit(ctx, 'agents.evaluate', 'agents', a.id, { score: ev.score });
    return ev;
  });

  r.post('/agents/:id/tasks', { min: 'manager' }, async (ctx) => {
    const b = validate({ title: S({ required: true, min: 3, max: 160 }), description: S({ max: 4000 }), business_unit_id: { type: 'uuid', ref: 'business_units' }, priority: { type: 'int', min: 1, max: 10, default: 5 } }, ctx.body);
    if (b.business_unit_id && !(await ctx.db.one('select 1 from business_units where id=$1 and workspace_id=$2', [b.business_unit_id, ctx.workspaceId]))) throw new HttpError(400, 'Unit bisnis tidak ditemukan');
    const t = await orchestrator.assignDirect(ctx.db, { workspaceId: ctx.workspaceId, userId: ctx.user.id, agentId: ctx.params.id, title: b.title, description: b.description, businessUnitId: b.business_unit_id, priority: b.priority });
    await audit(ctx, 'tasks.assign', 'tasks', t.id, { agent_id: ctx.params.id });
    ctx.status = 201;
    return t;
  });

  // ----- Departemen -----
  r.get('/departments', async ({ db, workspaceId: ws }) => ({
    items: await db.query(`select d.id, d.name, d.description, d.created_at,
      (select count(*)::int from agents a where a.workspace_id=d.workspace_id and a.department=d.name) as agent_count,
      (select count(*)::int from agents a where a.workspace_id=d.workspace_id and a.department=d.name and a.status='active') as active_count,
      coalesce((select json_agg(json_build_object('id',a.id,'name',a.name,'avatar',a.avatar,'title',a.title,'status',a.status) order by a.name) from agents a where a.workspace_id=d.workspace_id and a.department=d.name),'[]'::json) as agents
      from departments d where d.workspace_id=$1 order by d.name`, [ws])
  }));
  const DEPT = { name: S({ required: true, min: 2, max: 80 }), description: S({ max: 500 }) };
  r.post('/departments', { min: 'admin' }, async (ctx) => {
    const b = validate(DEPT, ctx.body);
    const row = await ctx.db.one('insert into departments (workspace_id, name, description) values ($1,$2,$3) returning *', [ctx.workspaceId, b.name, b.description || null]);
    await audit(ctx, 'departments.create', 'departments', row.id);
    ctx.status = 201; return row;
  });
  r.patch('/departments/:id', { min: 'admin' }, async (ctx) => {
    const b = validate(DEPT, ctx.body, { partial: true });
    return ctx.db.tx(async (t) => {
      const old = await t.one('select * from departments where id=$1 and workspace_id=$2 for update', [ctx.params.id, ctx.workspaceId]);
      if (!old) throw new HttpError(404, 'Departemen tidak ditemukan');
      const name = b.name || old.name;
      const row = await t.one('update departments set name=$3, description=$4 where id=$1 and workspace_id=$2 returning *', [old.id, ctx.workspaceId, name, b.description !== undefined ? (b.description || null) : old.description]);
      if (name !== old.name) await t.exec('update agents set department=$3 where workspace_id=$1 and department=$2', [ctx.workspaceId, old.name, name]);
      await audit({ ...ctx, db: t }, 'departments.update', 'departments', old.id);
      return row;
    });
  });
  r.delete('/departments/:id', { min: 'admin' }, async (ctx) => {
    const d = await ctx.db.one('select name from departments where id=$1 and workspace_id=$2', [ctx.params.id, ctx.workspaceId]);
    if (!d) throw new HttpError(404, 'Departemen tidak ditemukan');
    const n = await ctx.db.one('select count(*)::int as n from agents where workspace_id=$1 and department=$2', [ctx.workspaceId, d.name]);
    if (n.n > 0) throw new HttpError(409, `Departemen masih memiliki ${n.n} karyawan. Pindahkan dahulu.`);
    await ctx.db.exec('delete from departments where id=$1 and workspace_id=$2', [ctx.params.id, ctx.workspaceId]);
    await audit(ctx, 'departments.delete', 'departments', ctx.params.id);
    return { ok: true };
  });

  // ----- Memori (pencarian berdasarkan relevansi) -----
  r.get('/memories', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ["workspace_id=$1", "(expires_at is null or expires_at > now())"];
    for (const f of ['scope', 'agent_id', 'business_unit_id', 'customer_id', 'task_id']) if (query[f]) { p.push(query[f]); where.push(`${f}=$${p.length}`); }
    const limit = Math.min(Number(query.limit) || 100, 300);
    const tsq = query.q ? memory.toTsQuery(query.q) : '';
    let order = 'importance desc, created_at desc'; let rank = '0 as rank';
    if (tsq) { p.push(tsq); where.push(`tsv @@ to_tsquery('simple', $${p.length})`); rank = `ts_rank(tsv, to_tsquery('simple', $${p.length})) as rank`; order = 'rank desc, importance desc'; }
    return { items: await db.query(`select id, scope, agent_id, business_unit_id, customer_id, task_id, content, importance, expires_at, created_at, ${rank} from agent_memories where ${where.join(' and ')} order by ${order} limit ${limit}`, p) };
  });
  r.post('/memories', { min: 'manager' }, async (ctx) => {
    const b = validate({ scope: S({ required: true, values: memory.SCOPES }), content: S({ required: true, min: 3, max: 2000 }), importance: { type: 'int', min: 1, max: 10, default: 5 },
      agent_id: { type: 'uuid', ref: 'agents' }, business_unit_id: { type: 'uuid', ref: 'business_units' }, customer_id: { type: 'uuid', ref: 'customers' }, task_id: { type: 'uuid', ref: 'tasks' }, ttl_hours: { type: 'int', min: 1, max: 24 * 365 } }, ctx.body);
    for (const [k, t] of [['agent_id', 'agents'], ['business_unit_id', 'business_units'], ['customer_id', 'customers'], ['task_id', 'tasks']]) {
      if (b[k] && !(await ctx.db.one(`select 1 from ${t} where id=$1 and workspace_id=$2`, [b[k], ctx.workspaceId]))) throw new HttpError(400, `Referensi ${k} tidak ditemukan`);
    }
    if (['agent_short', 'agent_long'].includes(b.scope) && !b.agent_id) throw new HttpError(400, 'Memori karyawan wajib memilih karyawan');
    if (b.scope === 'business' && !b.business_unit_id) throw new HttpError(400, 'Memori bisnis wajib memilih unit bisnis');
    if (b.scope === 'customer' && !b.customer_id) throw new HttpError(400, 'Memori pelanggan wajib memilih pelanggan');
    if (b.scope === 'task' && !b.task_id) throw new HttpError(400, 'Memori tugas wajib memilih tugas');
    const row = await memory.remember(ctx.db, { workspaceId: ctx.workspaceId, scope: b.scope, content: b.content, agentId: b.agent_id, businessUnitId: b.business_unit_id, taskId: b.task_id, customerId: b.customer_id, importance: b.importance, ttlHours: b.ttl_hours });
    await audit(ctx, 'memories.create', 'agent_memories', row.id, { scope: b.scope });
    ctx.status = 201; return row;
  });
  r.delete('/memories/:id', { min: 'manager' }, async (ctx) => {
    const n = await ctx.db.exec('delete from agent_memories where id=$1 and workspace_id=$2', [ctx.params.id, ctx.workspaceId]);
    if (!n) throw new HttpError(404, 'Memori tidak ditemukan');
    await audit(ctx, 'memories.delete', 'agent_memories', ctx.params.id);
    return { ok: true };
  });
};
