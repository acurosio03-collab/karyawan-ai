'use strict';
const { crud } = require('../../lib/crud');
const { HttpError } = require('../../lib/http');
const { validate } = require('../../lib/validate');
const { audit } = require('../../services/audit');
const approvals = require('../../services/approvals');
const integrations = require('../../services/integrations');
const tools = require('../../tools');
const auth = require('../../security/auth');
const { dbLimit } = require('../../security/ratelimit');
const { health } = require('../../lib/db');

const S = (o = {}) => ({ type: 'string', ...o });

module.exports = (r) => {
  // ================= Approval Center =================
  r.get('/approvals', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['a.workspace_id=$1'];
    if (query.status === 'open') where.push("a.status in ('pending','review')");
    else if (query.status) { p.push(query.status); where.push(`a.status=$${p.length}`); }
    if (query.action_type) { p.push(query.action_type); where.push(`a.action_type=$${p.length}`); }
    return { items: await db.query(`select a.id, a.action_type, a.title, a.description, a.payload, a.status, a.created_at, a.decided_at, a.decision_note, a.executed_at, a.execution_result, a.task_id,
      ag.name as requested_by_agent, ru.name as requested_by_user, du.name as decided_by_name
      from approvals a left join agents ag on ag.id=a.requested_by_agent_id left join users ru on ru.id=a.requested_by_user_id left join users du on du.id=a.decided_by
      where ${where.join(' and ')} order by (a.status in ('pending','review')) desc, a.created_at desc limit 200`, p) };
  });
  r.post('/approvals/:id/decide', { min: 'admin' }, async (ctx) => {
    const b = validate({ decision: S({ required: true, values: ['approve', 'reject', 'review'] }), note: S({ max: 500 }) }, ctx.body);
    return approvals.decide(ctx.db, { workspaceId: ctx.workspaceId, id: ctx.params.id, userId: ctx.user.id, decision: b.decision, note: b.note });
  });

  // ================= Automation =================
  const SCHEDULE = {
    name: S({ required: true, min: 2, max: 100 }), title: S({ required: true, min: 3, max: 160 }), description: S({ max: 4000 }),
    agent_id: { type: 'uuid', required: true, ref: 'agents' }, business_unit_id: { type: 'uuid', ref: 'business_units' },
    frequency: S({ values: ['once', 'minutes', 'hourly', 'daily', 'weekly'], default: 'daily' }), interval_minutes: { type: 'int', min: 5, max: 10080 },
    next_run_at: { type: 'date' }, priority: { type: 'int', min: 1, max: 10 }, max_attempts: { type: 'int', min: 1, max: 10 }, enabled: { type: 'bool' }
  };
  crud(r, {
    path: '/schedules', table: 'schedules', schema: SCHEDULE, label: 'Jadwal', methods: ['get', 'create', 'update', 'delete'], minWrite: 'manager', minDelete: 'manager',
    beforeCreate: (c, d) => {
      if (d.frequency === 'minutes' && !d.interval_minutes) throw new HttpError(400, 'interval_minutes wajib untuk frekuensi per-menit');
      return { ...d, next_run_at: d.next_run_at || new Date().toISOString() };
    },
    beforeUpdate: (c, d) => {
      if (d.frequency === 'minutes' && d.interval_minutes === undefined) throw new HttpError(400, 'Sertakan interval_minutes untuk frekuensi per-menit');
      if (d.enabled === true && !d.next_run_at) d.next_run_at = new Date().toISOString();
      return d;
    }
  });
  r.get('/schedules', async ({ db, workspaceId: ws }) => ({
    items: await db.query(`select s.*, a.name as agent_name, a.avatar as agent_avatar, bu.name as unit_name,
      (select t.status from tasks t where t.schedule_id=s.id order by t.created_at desc limit 1) as last_task_status,
      (select t.id from tasks t where t.schedule_id=s.id order by t.created_at desc limit 1) as last_task_id
      from schedules s left join agents a on a.id=s.agent_id left join business_units bu on bu.id=s.business_unit_id where s.workspace_id=$1 order by s.enabled desc, s.next_run_at nulls last`, [ws])
  }));
  r.post('/schedules/:id/run-now', { min: 'manager' }, async (ctx) => {
    const row = await ctx.db.one('update schedules set next_run_at=now(), enabled=true where id=$1 and workspace_id=$2 returning id', [ctx.params.id, ctx.workspaceId]);
    if (!row) throw new HttpError(404, 'Jadwal tidak ditemukan');
    await audit(ctx, 'schedules.run_now', 'schedules', row.id);
    return { ok: true, note: 'Jadwal akan dibuat menjadi tugas pada putaran worker berikutnya (klik Jalankan antrean).' };
  });
  r.get('/automation/monitor', async ({ db, workspaceId: ws }) => {
    const [q, recent, stale, due] = await Promise.all([
      db.one(`select count(*) filter (where status='queued')::int as queued, count(*) filter (where status='running')::int as running, count(*) filter (where status='blocked')::int as blocked,
        count(*) filter (where status='failed' and finished_at > now() - interval '1 day')::int as failed_24h, count(*) filter (where status='done' and finished_at > now() - interval '1 day')::int as done_24h from tasks where workspace_id=$1`, [ws]),
      db.query(`select t.id, t.title, t.status, t.attempts, t.max_attempts, t.error, t.created_at, t.finished_at, s.name as schedule_name, a.name as agent_name
        from tasks t left join schedules s on s.id=t.schedule_id left join agents a on a.id=t.assigned_agent_id where t.workspace_id=$1 and t.parent_task_id is null and t.kind<>'qa' order by t.created_at desc limit 20`, [ws]),
      db.one("select count(*)::int as n from tasks where workspace_id=$1 and status='running' and locked_at < now() - ((timeout_seconds + 90) * interval '1 second')", [ws]),
      db.one('select count(*)::int as n from schedules where workspace_id=$1 and enabled and next_run_at <= now()', [ws])
    ]);
    return { queue: q, recent, stale_running: stale.n, schedules_due: due.n, cron: { secret_set: !!process.env.CRON_SECRET, vercel_cron_path: '/api/cron', vercel_default_schedule: '0 1 * * * (sekali sehari, batas paket Hobby)' } };
  });

  // ================= Integrasi API =================
  r.get('/integrations', async ({ db, workspaceId: ws }) => {
    const rows = await db.query('select kind, enabled, settings, last_test_at, last_status, last_error from integrations where workspace_id=$1', [ws]);
    const by = Object.fromEntries(rows.map((x) => [x.kind, x]));
    const items = Object.entries(integrations.KINDS).map(([kind, k]) => {
      const row = by[kind] || {};
      return { kind, label: k.label, help: k.help, unsupported: !!k.unsupported, env: k.env.map((n) => ({ name: n, set: !!process.env[n] })), configured: integrations.configured(kind),
        enabled: row.enabled === undefined ? true : row.enabled, settings: row.settings || {}, last_test_at: row.last_test_at || null, last_status: row.last_status || null, last_error: row.last_error || null,
        status: k.unsupported ? 'UNSUPPORTED' : !integrations.configured(kind) ? 'NOT CONNECTED' : (row.enabled === false ? 'DISABLED' : row.last_status === 'ok' ? 'CONNECTED' : row.last_status === 'error' ? 'ERROR' : 'CONFIGURED') };
    });
    return { items };
  });
  r.post('/integrations/:kind/test', { min: 'admin' }, async (ctx) => {
    const kind = ctx.params.kind;
    if (!integrations.KINDS[kind]) throw new HttpError(404, 'Integrasi tidak dikenal');
    await dbLimit(ctx.db, 'itest:' + ctx.workspaceId, 20, 60);
    const res = await integrations.test(kind);
    await ctx.db.exec(`insert into integrations (workspace_id, kind, last_test_at, last_status, last_error) values ($1,$2,now(),$3,$4)
      on conflict (workspace_id, kind) do update set last_test_at=now(), last_status=excluded.last_status, last_error=excluded.last_error`, [ctx.workspaceId, kind, res.ok ? 'ok' : 'error', res.ok ? null : String(res.error || '').slice(0, 300)]);
    await audit(ctx, 'integrations.test', 'integrations', kind, { ok: res.ok });
    return res;
  });
  r.patch('/integrations/:kind', { min: 'admin' }, async (ctx) => {
    const kind = ctx.params.kind;
    if (!integrations.KINDS[kind]) throw new HttpError(404, 'Integrasi tidak dikenal');
    const b = validate({ enabled: { type: 'bool' }, settings: { type: 'object', maxBytes: 2000 } }, ctx.body, { partial: true });
    if (b.settings) {
      const s = validate({ daily_call_limit: { type: 'int', min: 0, max: 1e6 }, note: S({ max: 300 }) }, b.settings, { partial: true });
      b.settings = s;
    }
    await ctx.db.exec(`insert into integrations (workspace_id, kind, enabled, settings) values ($1,$2,coalesce($3,true),coalesce($4::jsonb,'{}'::jsonb))
      on conflict (workspace_id, kind) do update set enabled=coalesce($3, integrations.enabled), settings=coalesce($4::jsonb, integrations.settings)`, [ctx.workspaceId, kind, b.enabled === undefined ? null : b.enabled, b.settings ? JSON.stringify(b.settings) : null]);
    await audit(ctx, 'integrations.update', 'integrations', kind, { enabled: b.enabled });
    return { ok: true };
  });

  // ================= Tools AI =================
  r.get('/tools', async ({ db, workspaceId: ws }) => {
    const st = await db.query(`select t.name, t.status, count(l.id)::int as calls, count(l.id) filter (where l.status='error')::int as errors, count(l.id) filter (where l.status='denied')::int as denied, max(l.created_at) as last_used
      from tools t left join tool_logs l on l.workspace_id=t.workspace_id and l.tool_name=t.name where t.workspace_id=$1 group by t.name, t.status`, [ws]);
    const by = Object.fromEntries(st.map((x) => [x.name, x]));
    const users = await db.query('select unnest(tools) as name, count(*)::int as n from agents where workspace_id=$1 group by 1', [ws]);
    const uses = Object.fromEntries(users.map((u) => [u.name, u.n]));
    return { items: tools.listDefs().map((d) => ({ ...d, status: (by[d.name] && by[d.name].status) || 'active', calls: by[d.name] ? by[d.name].calls : 0, errors: by[d.name] ? by[d.name].errors : 0, denied: by[d.name] ? by[d.name].denied : 0,
      last_used: by[d.name] ? by[d.name].last_used : null, agents_with_access: uses[d.name] || 0 })) };
  });
  r.patch('/tools/:name', { min: 'admin' }, async (ctx) => {
    const b = validate({ status: S({ required: true, values: ['active', 'disabled'] }) }, ctx.body);
    if (!tools.DEFS[ctx.params.name]) throw new HttpError(404, 'Tool tidak dikenal');
    await tools.seedTools(ctx.db, ctx.workspaceId);
    await ctx.db.exec('update tools set status=$3 where workspace_id=$1 and name=$2', [ctx.workspaceId, ctx.params.name, b.status]);
    await audit(ctx, 'tools.status', 'tools', ctx.params.name, b);
    return { ok: true };
  });
  r.get('/tool-logs', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['l.workspace_id=$1'];
    if (query.tool) { p.push(query.tool); where.push(`l.tool_name=$${p.length}`); }
    if (query.status) { p.push(query.status); where.push(`l.status=$${p.length}`); }
    return { items: await db.query(`select l.id, l.tool_name, l.status, l.error, l.duration_ms, l.created_at, l.input, l.output, l.task_id, a.name as agent_name from tool_logs l left join agents a on a.id=l.agent_id where ${where.join(' and ')} order by l.created_at desc limit 100`, p) };
  });

  // ================= Pengaturan, pengguna, audit =================
  r.get('/settings', async ({ db, workspaceId: ws, user }) => {
    const w = await db.one('select id, name, slug, settings, created_at from workspaces where id=$1', [ws]);
    const h = user.role === 'viewer' || user.role === 'manager' ? null : await health();
    return { workspace: w, database: h, notes: { secrets: 'API key tidak pernah disimpan atau dikirim ke browser. Isi di Vercel → Settings → Environment Variables.' } };
  });
  r.patch('/settings', { min: 'admin' }, async (ctx) => {
    const b = validate({ name: S({ min: 2, max: 80 }), owner_name: S({ max: 80 }), usd_idr_rate: { type: 'number', min: 0, max: 1e6 }, currency: S({ max: 8 }) }, ctx.body, { partial: true });
    const { name, ...rest } = b;
    const row = await ctx.db.one("update workspaces set name=coalesce($2,name), settings = settings || $3::jsonb where id=$1 returning id, name, settings", [ctx.workspaceId, name || null, JSON.stringify(rest)]);
    await audit(ctx, 'settings.update', 'workspaces', ctx.workspaceId, Object.keys(b));
    return row;
  });

  r.get('/users', { min: 'admin' }, async ({ db, workspaceId: ws }) => ({ items: await db.query('select id, name, email, role, active, last_login_at, created_at from users where workspace_id=$1 order by created_at', [ws]) }));
  r.post('/users', { min: 'admin' }, async (ctx) => {
    const b = validate({ name: S({ required: true, min: 2, max: 80 }), email: S({ required: true, max: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMsg: 'format email tidak valid' }), password: S({ required: true, max: 200, trim: false }), role: S({ required: true, values: ['admin', 'manager', 'viewer'] }) }, ctx.body);
    if (b.role === 'admin' && ctx.user.role !== 'owner') throw new HttpError(403, 'Hanya Owner yang dapat membuat Admin');
    auth.checkPasswordStrength(b.password);
    const u = await ctx.db.one('insert into users (workspace_id, email, name, password_hash, role) values ($1,$2,$3,$4,$5) returning id, name, email, role, active', [ctx.workspaceId, b.email.toLowerCase(), b.name, auth.hashPassword(b.password), b.role]);
    await audit(ctx, 'users.create', 'users', u.id, { role: b.role });
    ctx.status = 201; return u;
  });
  r.patch('/users/:id', { min: 'admin' }, async (ctx) => {
    const b = validate({ name: S({ min: 2, max: 80 }), role: S({ values: ['admin', 'manager', 'viewer'] }), active: { type: 'bool' }, password: S({ max: 200, trim: false }) }, ctx.body, { partial: true });
    const t = await ctx.db.one('select id, role from users where id=$1 and workspace_id=$2', [ctx.params.id, ctx.workspaceId]);
    if (!t) throw new HttpError(404, 'Pengguna tidak ditemukan');
    if (t.role === 'owner') throw new HttpError(403, 'Akun Owner tidak dapat diubah dari sini');
    if (t.id === ctx.user.id && b.active === false) throw new HttpError(400, 'Tidak dapat menonaktifkan akun sendiri');
    if ((t.role === 'admin' || b.role === 'admin') && ctx.user.role !== 'owner') throw new HttpError(403, 'Hanya Owner yang dapat mengubah Admin');
    let hash = null;
    if (b.password) { auth.checkPasswordStrength(b.password); hash = auth.hashPassword(b.password); }
    const row = await ctx.db.one('update users set name=coalesce($3,name), role=coalesce($4,role), active=coalesce($5,active), password_hash=coalesce($6,password_hash) where id=$1 and workspace_id=$2 returning id, name, email, role, active',
      [t.id, ctx.workspaceId, b.name || null, b.role || null, b.active === undefined ? null : b.active, hash]);
    if (hash || b.active === false) await ctx.db.exec('delete from sessions where user_id=$1', [t.id]);
    await audit(ctx, 'users.update', 'users', t.id, { fields: Object.keys(b).filter((k) => k !== 'password'), password_reset: !!hash });
    return row;
  });

  r.get('/audit', { min: 'admin' }, async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['l.workspace_id=$1'];
    if (query.action) { p.push(query.action + '%'); where.push(`l.action like $${p.length}`); }
    return { items: await db.query(`select l.id, l.action, l.entity, l.entity_id, l.details, l.ip, l.created_at, u.name as user_name, a.name as agent_name from audit_logs l left join users u on u.id=l.user_id left join agents a on a.id=l.agent_id where ${where.join(' and ')} order by l.created_at desc limit 200`, p) };
  });
};
