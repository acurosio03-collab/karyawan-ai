'use strict';
const { HttpError } = require('../../lib/http');
const { validate } = require('../../lib/validate');
const { audit } = require('../../services/audit');
const orchestrator = require('../../engine/orchestrator');
const queue = require('../../engine/queue');
const { dbLimit } = require('../../security/ratelimit');
const integrations = require('../../services/integrations');
const search = require('../../services/search');

const S = (o = {}) => ({ type: 'string', ...o });

module.exports = (r) => {
  r.get('/tasks', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['t.workspace_id=$1'];
    const eq = (col, v) => { p.push(v); where.push(`${col}=$${p.length}`); };
    if (query.status) { if (query.status === 'active') where.push("t.status in ('queued','running','pending_deps','waiting_children','in_qa')"); else eq('t.status', query.status); }
    if (query.kind) eq('t.kind', query.kind);
    if (query.agent_id) eq('t.assigned_agent_id', query.agent_id);
    if (query.root_id) eq('t.root_task_id', query.root_id);
    if (query.parent === 'none') where.push('t.parent_task_id is null and t.kind<>\'qa\'');
    if (query.q) { p.push('%' + String(query.q).slice(0, 80) + '%'); where.push(`t.title ilike $${p.length}`); }
    const limit = Math.min(Number(query.limit) || 100, 300);
    const rows = await db.query(
      `select t.id, t.title, t.kind, t.status, t.priority, t.depth, t.parent_task_id, t.root_task_id, t.assigned_agent_id, a.name as agent_name, a.avatar as agent_avatar, t.error, t.attempts, t.max_attempts,
              t.qa_status, t.created_at, t.started_at, t.finished_at, t.scheduled_for, t.result->>'summary' as summary,
              (select count(*)::int from tasks c where c.parent_task_id=t.id) as child_count,
              (select count(*)::int from tasks c where c.parent_task_id=t.id and c.status='done') as child_done
       from tasks t left join agents a on a.id=t.assigned_agent_id where ${where.join(' and ')} order by t.created_at desc limit ${limit}`, p);
    const counts = await db.query('select status, count(*)::int as n from tasks where workspace_id=$1 group by status', [ws]);
    return { items: rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  });

  r.get('/tasks/:id', async ({ db, workspaceId: ws, params }) => {
    const t = await db.one(`select t.*, a.name as agent_name, a.avatar as agent_avatar, u.name as created_by_name, ca.name as created_by_agent_name, bu.name as unit_name
      from tasks t left join agents a on a.id=t.assigned_agent_id left join users u on u.id=t.created_by_user_id left join agents ca on ca.id=t.created_by_agent_id left join business_units bu on bu.id=t.business_unit_id
      where t.id=$1 and t.workspace_id=$2`, [params.id, ws]);
    if (!t) throw new HttpError(404, 'Tugas tidak ditemukan');
    const [children, deps, runs, messages, toolLogs, files, approvals, qa] = await Promise.all([
      db.query('select t.id, t.title, t.kind, t.status, t.qa_status, t.priority, t.result->>\'summary\' as summary, t.error, a.name as agent_name, a.avatar as agent_avatar from tasks t left join agents a on a.id=t.assigned_agent_id where t.parent_task_id=$1 order by t.created_at', [t.id]),
      db.query('select d.depends_on_task_id as id, x.title, x.status from task_dependencies d join tasks x on x.id=d.depends_on_task_id where d.task_id=$1', [t.id]),
      db.query('select r.id, r.phase, r.status, r.model, r.steps, r.prompt_tokens, r.completion_tokens, r.cost_usd::float as cost_usd, r.duration_ms, r.error, r.started_at, a.name as agent_name from agent_runs r join agents a on a.id=r.agent_id where r.task_id in (select id from tasks where id=$1 or root_task_id=$1) order by r.started_at', [t.id]),
      db.query('select m.id, m.kind, m.content, m.created_at, fa.name as from_agent, ta.name as to_agent, u.name as from_user from agent_messages m left join agents fa on fa.id=m.from_agent_id left join agents ta on ta.id=m.to_agent_id left join users u on u.id=m.from_user_id where m.task_id=$1 order by m.created_at', [t.id]),
      db.query('select l.id, l.tool_name, l.status, l.error, l.duration_ms, l.created_at, l.input, l.output, a.name as agent_name from tool_logs l left join agents a on a.id=l.agent_id where l.task_id=$1 order by l.created_at', [t.id]),
      db.query('select id, name, mime, size, created_at from files where task_id=$1 order by created_at', [t.id]),
      db.query('select id, action_type, title, status, created_at from approvals where task_id=$1 order by created_at', [t.id]),
      db.query("select t.id, t.status, t.qa_status, t.result from tasks t where t.kind='qa' and t.input->>'target_task_id'=$1::text order by t.created_at desc limit 3", [t.id])
    ]);
    const { locked_by, ...task } = t;
    return { task, children, dependencies: deps, runs, messages, tool_logs: toolLogs, files, approvals, qa_reviews: qa };
  });

  // Owner memberi target ke AI CEO (atau langsung ke satu karyawan bila agent_id diisi)
  r.post('/tasks', { min: 'manager' }, async (ctx) => {
    const b = validate({ title: S({ required: true, min: 3, max: 160 }), description: S({ max: 6000 }), agent_id: { type: 'uuid' }, business_unit_id: { type: 'uuid' }, priority: { type: 'int', min: 1, max: 10, default: 5 } }, ctx.body);
    if (b.business_unit_id && !(await ctx.db.one('select 1 from business_units where id=$1 and workspace_id=$2', [b.business_unit_id, ctx.workspaceId]))) throw new HttpError(400, 'Unit bisnis tidak ditemukan');
    const args = { workspaceId: ctx.workspaceId, userId: ctx.user.id, title: b.title, description: b.description, businessUnitId: b.business_unit_id, priority: b.priority };
    const t = b.agent_id ? await orchestrator.assignDirect(ctx.db, { ...args, agentId: b.agent_id }) : await orchestrator.createGoal(ctx.db, args);
    await audit(ctx, b.agent_id ? 'tasks.assign' : 'tasks.goal', 'tasks', t.id);
    ctx.status = 201;
    return t;
  });

  const act = (path, min, fn, auditAction) => r.post(path, { min }, async (ctx) => {
    const out = await fn(ctx);
    await audit(ctx, auditAction, 'tasks', ctx.params.id);
    return out === undefined ? { ok: true } : out;
  });
  act('/tasks/:id/cancel', 'manager', async (c) => ({ cancelled: await orchestrator.cancelTask(c.db, c.workspaceId, c.params.id) }), 'tasks.cancel');
  act('/tasks/:id/retry', 'manager', (c) => orchestrator.retryTask(c.db, c.workspaceId, c.params.id), 'tasks.retry');
  act('/tasks/:id/accept', 'manager', (c) => orchestrator.ownerAccept(c.db, c.workspaceId, c.params.id), 'tasks.accept');
  act('/tasks/:id/revise', 'manager', (c) => {
    const b = validate({ feedback: S({ required: true, min: 3, max: 2000 }) }, c.body);
    return orchestrator.ownerRevise(c.db, c.workspaceId, c.params.id, b.feedback);
  }, 'tasks.revise');
  r.delete('/tasks/:id', { min: 'admin' }, async (ctx) => {
    const n = await ctx.db.exec("delete from tasks where id=$1 and workspace_id=$2 and status in ('done','failed','cancelled','blocked')", [ctx.params.id, ctx.workspaceId]);
    if (!n) throw new HttpError(409, 'Hanya tugas selesai/gagal/dibatalkan/terblokir yang dapat dihapus');
    await audit(ctx, 'tasks.delete', 'tasks', ctx.params.id);
    return { ok: true };
  });

  // ----- Worker: memproses antrean (dipanggil tombol "Jalankan antrean" / mode otomatis / cron) -----
  r.post('/worker/tick', { min: 'manager' }, async (ctx) => {
    await dbLimit(ctx.db, 'tick:' + ctx.workspaceId, 40, 60);
    const out = await queue.tick(ctx.db, { workspaceId: ctx.workspaceId, budgetMs: 45000, maxTasks: 3 });
    return out;
  });
  r.get('/worker/status', async ({ db, workspaceId: ws }) => {
    const q = await db.one(`select count(*) filter (where status='queued')::int as queued, count(*) filter (where status='running')::int as running,
      count(*) filter (where status='pending_deps')::int as waiting_deps, count(*) filter (where status='waiting_children')::int as waiting_children,
      count(*) filter (where status='in_qa')::int as in_qa, count(*) filter (where status='blocked')::int as blocked, count(*) filter (where status='failed' and finished_at > now() - interval '1 day')::int as failed_24h,
      count(*) filter (where status='queued' and scheduled_for > now())::int as delayed from tasks where workspace_id=$1`, [ws]);
    return { ...q, ai_connected: integrations.configured('openai') || integrations.configured('alt_ai'), search_connected: search.isConnected(), cron_secret_set: !!process.env.CRON_SECRET };
  });

  // ----- Komunikasi antar-AI -----
  r.get('/messages', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['m.workspace_id=$1'];
    if (query.agent_id) { p.push(query.agent_id); where.push(`(m.from_agent_id=$${p.length} or m.to_agent_id=$${p.length})`); }
    if (query.kind) { p.push(query.kind); where.push(`m.kind=$${p.length}`); }
    if (query.task_id) { p.push(query.task_id); where.push(`m.task_id=$${p.length}`); }
    const limit = Math.min(Number(query.limit) || 100, 300);
    return { items: await db.query(`select m.id, m.kind, m.content, m.created_at, m.task_id, t.title as task_title, fa.id as from_agent_id, fa.name as from_agent, fa.avatar as from_avatar, ta.id as to_agent_id, ta.name as to_agent, ta.avatar as to_avatar, u.name as from_user
      from agent_messages m left join agents fa on fa.id=m.from_agent_id left join agents ta on ta.id=m.to_agent_id left join users u on u.id=m.from_user_id left join tasks t on t.id=m.task_id
      where ${where.join(' and ')} order by m.created_at desc limit ${limit}`, p) };
  });
  // Pesan Owner ke karyawan = tugas langsung (benar-benar dikerjakan), tercatat sebagai pesan 'owner'
  r.post('/messages', { min: 'manager' }, async (ctx) => {
    const b = validate({ to_agent_id: { type: 'uuid', required: true }, content: S({ required: true, min: 3, max: 4000 }) }, ctx.body);
    const t = await orchestrator.assignDirect(ctx.db, { workspaceId: ctx.workspaceId, userId: ctx.user.id, agentId: b.to_agent_id, title: b.content.slice(0, 120), description: b.content, priority: 6 });
    await audit(ctx, 'messages.owner', 'tasks', t.id);
    ctx.status = 201;
    return { task: t };
  });

  // ----- Berkas hasil kerja AI -----
  r.get('/files', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['f.workspace_id=$1'];
    if (query.q) { p.push('%' + String(query.q).slice(0, 80) + '%'); where.push(`f.name ilike $${p.length}`); }
    return { items: await db.query(`select f.id, f.name, f.mime, f.size, f.task_id, f.created_at, a.name as agent_name from files f left join agents a on a.id=f.created_by_agent_id where ${where.join(' and ')} order by f.created_at desc limit 200`, p) };
  });
  r.get('/files/:id', async ({ db, workspaceId: ws, params }) => {
    const f = await db.one('select id, name, mime, size, content, task_id, created_at from files where id=$1 and workspace_id=$2', [params.id, ws]);
    if (!f) throw new HttpError(404, 'Berkas tidak ditemukan');
    return f;
  });
  r.delete('/files/:id', { min: 'admin' }, async (ctx) => {
    const n = await ctx.db.exec('delete from files where id=$1 and workspace_id=$2', [ctx.params.id, ctx.workspaceId]);
    if (!n) throw new HttpError(404, 'Berkas tidak ditemukan');
    await audit(ctx, 'files.delete', 'files', ctx.params.id);
    return { ok: true };
  });
};
