'use strict';
const { crud } = require('../../lib/crud');
const { HttpError } = require('../../lib/http');
const { validate } = require('../../lib/validate');
const { audit } = require('../../services/audit');
const { leadDedupeKey, normalizeWa } = require('../../lib/leads');
const orchestrator = require('../../engine/orchestrator');
const integrations = require('../../services/integrations');
const search = require('../../services/search');
const ai = require('../../services/ai');

const S = (o = {}) => ({ type: 'string', ...o });
const WA = S({ max: 20, pattern: /^\+?[0-9][0-9\s-]{6,18}$/, patternMsg: 'nomor WhatsApp hanya angka (contoh 0812xxxxxxx)' });
const UNIT = { type: 'uuid', ref: 'business_units' };

const LEAD_SCHEMA = {
  business_name: S({ required: true, min: 2, max: 120 }), contact_name: S({ max: 120 }), category: S({ max: 80 }), whatsapp: WA, address: S({ max: 250 }),
  website: { type: 'url' }, has_website: { type: 'bool' }, source: S({ max: 60, default: 'manual' }), source_url: { type: 'url' }, evidence: S({ max: 1500 }),
  status: S({ values: ['baru', 'dihubungi', 'tertarik', 'penawaran', 'negosiasi', 'menang', 'kalah', 'tidak_cocok'] }),
  potential_value: { type: 'number', min: 0, max: 1e12 }, priority: { type: 'int', min: 1, max: 10 }, notes: S({ max: 1000 }), verified: { type: 'bool' }, business_unit_id: UNIT
};
const CUSTOMER_SCHEMA = {
  name: S({ required: true, min: 2, max: 120 }), business_name: S({ max: 120 }), category: S({ max: 80 }), whatsapp: WA,
  email: S({ max: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMsg: 'format email tidak valid' }), address: S({ max: 250 }), website: { type: 'url' }, notes: S({ max: 1000 }), business_unit_id: UNIT
};

module.exports = (r) => {
  // ----- Unit bisnis -----
  const UNIT_SQL = `select u.id, u.code, u.name, u.description, u.services, u.active, u.created_at,
    (select count(*)::int from customers c where c.business_unit_id=u.id) as customers,
    (select count(*)::int from leads l where l.business_unit_id=u.id) as leads,
    (select count(*)::int from products p where p.business_unit_id=u.id and p.active) as products,
    (select count(*)::int from orders o where o.business_unit_id=u.id and o.status<>'draft') as orders,
    (select coalesce(sum(amount),0)::float from transactions x where x.business_unit_id=u.id and x.type='income') as income,
    (select coalesce(sum(amount),0)::float from transactions x where x.business_unit_id=u.id and x.type='expense') as expense,
    (select count(*)::int from tasks t where t.business_unit_id=u.id and t.status in ('queued','running','pending_deps','waiting_children','in_qa')) as active_tasks
    from business_units u where u.workspace_id=$1`;
  r.get('/business-units', async ({ db, workspaceId }) => ({ items: await db.query(UNIT_SQL + ' order by u.name', [workspaceId]) }));
  r.get('/business-units/:id', async ({ db, workspaceId, params }) => {
    const u = await db.one(UNIT_SQL + ' and u.id=$2', [workspaceId, params.id]);
    if (!u) throw new HttpError(404, 'Unit bisnis tidak ditemukan');
    const [products, orders, customers, tx] = await Promise.all([
      db.query('select id, name, type, price::float as price, active from products where business_unit_id=$1 order by name limit 50', [u.id]),
      db.query('select id, order_no, status, payment_status, total::float as total, created_at from orders where business_unit_id=$1 order by created_at desc limit 20', [u.id]),
      db.query('select id, name, business_name, whatsapp from customers where business_unit_id=$1 order by created_at desc limit 20', [u.id]),
      db.query('select id, type, category, amount::float as amount, description, occurred_at from transactions where business_unit_id=$1 order by occurred_at desc limit 20', [u.id])
    ]);
    return { unit: u, products, orders, customers, transactions: tx };
  });
  const UNIT_SCHEMA = { code: S({ required: true, min: 2, max: 30, pattern: /^[a-z][a-z0-9_-]+$/, patternMsg: 'kode: huruf kecil/angka/-/_' }), name: S({ required: true, min: 2, max: 100 }), description: S({ max: 500 }),
    services: { type: 'array', max: 30, items: S({ max: 80 }), jsonb: true }, active: { type: 'bool' } };
  crud(r, { path: '/business-units', table: 'business_units', schema: UNIT_SCHEMA, label: 'Unit bisnis', methods: ['create', 'update', 'delete'], minWrite: 'admin', minDelete: 'owner' });

  // ----- Prospek (CRM) -----
  crud(r, {
    path: '/leads', table: 'leads', schema: LEAD_SCHEMA, label: 'Prospek', orderBy: 'priority desc, created_at desc',
    search: ['business_name', 'contact_name', 'category', 'whatsapp'], filters: ['status', 'business_unit_id', 'category'], minWrite: 'manager',
    beforeCreate: async ({ db, workspaceId }, d) => {
      if (d.whatsapp) d.whatsapp = normalizeWa(d.whatsapp);
      const key = leadDedupeKey(d);
      const dup = await db.one('select id, business_name from leads where workspace_id=$1 and dedupe_key=$2', [workspaceId, key]);
      if (dup) throw new HttpError(409, `Prospek duplikat: sudah ada "${dup.business_name}"`, { code: 'DUPLICATE' });
      return { ...d, dedupe_key: key, verified: d.verified === undefined ? false : d.verified };
    }
  });
  r.get('/leads/:id/detail', async ({ db, workspaceId, params }) => {
    const lead = await db.one('select l.*, a.name as created_by_agent from leads l left join agents a on a.id=l.created_by_agent_id where l.id=$1 and l.workspace_id=$2', [params.id, workspaceId]);
    if (!lead) throw new HttpError(404, 'Prospek tidak ditemukan');
    const [comms, quotes, customer] = await Promise.all([
      db.query('select id, channel, direction, content, status, created_at from communications where lead_id=$1 order by created_at desc limit 100', [lead.id]),
      db.query('select id, number, total::float as total, status, created_at from quotations where lead_id=$1 order by created_at desc', [lead.id]),
      db.one('select id, name from customers where lead_id=$1 limit 1', [lead.id])
    ]);
    return { lead, communications: comms, quotations: quotes, customer };
  });
  r.post('/leads/:id/convert', { min: 'manager' }, async (ctx) => {
    return ctx.db.tx(async (t) => {
      const l = await t.one('select * from leads where id=$1 and workspace_id=$2 for update', [ctx.params.id, ctx.workspaceId]);
      if (!l) throw new HttpError(404, 'Prospek tidak ditemukan');
      if (await t.one('select 1 from customers where lead_id=$1', [l.id])) throw new HttpError(409, 'Prospek ini sudah dijadikan pelanggan');
      const c = await t.one('insert into customers (workspace_id, business_unit_id, name, business_name, category, whatsapp, address, website, notes, lead_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',
        [ctx.workspaceId, l.business_unit_id, l.contact_name || l.business_name, l.business_name, l.category, l.whatsapp, l.address, l.website, l.notes, l.id]);
      await t.exec("update leads set status='menang' where id=$1", [l.id]);
      await t.exec('update communications set customer_id=$2 where lead_id=$1', [l.id, c.id]);
      await audit({ ...ctx, db: t }, 'leads.convert', 'leads', l.id, { customer_id: c.id });
      ctx.status = 201;
      return c;
    });
  });

  // Perintahkan AI Business Researcher mencari prospek (butuh AI + Web Search tersambung; bila tidak, tugas akan berstatus blocked jujur)
  r.post('/leads/research', { min: 'manager' }, async (ctx) => {
    const b = validate({ category: S({ required: true, min: 3, max: 80 }), location: S({ required: true, min: 2, max: 80 }), count: { type: 'int', min: 1, max: 15, default: 5 }, only_no_website: { type: 'bool', default: true }, business_unit_id: UNIT }, ctx.body);
    const ag = await ctx.db.one("select id, name from agents where workspace_id=$1 and role_key='researcher' and status='active' order by created_at limit 1", [ctx.workspaceId]);
    if (!ag) throw new HttpError(409, 'Tidak ada AI Business Researcher aktif. Rekrut dari template di halaman AI Employees.');
    const desc = `Cari sampai ${b.count} calon pelanggan nyata untuk kategori "${b.category}" di "${b.location}"${b.only_no_website ? ', prioritaskan bisnis yang kemungkinan belum punya website sendiri' : ''}. ` +
      'Gunakan business_research/web_search, lalu simpan HANYA yang punya sumber nyata dengan save_lead (wajib source_url dan evidence). Jangan mengarang nomor WhatsApp atau alamat; jika tidak ditemukan, biarkan kosong. Laporkan jumlah tersimpan, duplikat, dan yang ditolak.';
    const t = await orchestrator.assignDirect(ctx.db, { workspaceId: ctx.workspaceId, userId: ctx.user.id, agentId: ag.id, title: `Riset prospek: ${b.category} di ${b.location}`, description: desc, businessUnitId: b.business_unit_id, priority: 6 });
    await audit(ctx, 'leads.research', 'tasks', t.id);
    ctx.status = 201;
    return { task: t, search_connected: search.isConnected() && (await integrations.isEnabled(ctx.db, ctx.workspaceId, 'web_search')), ai_connected: ai.isConnected('openai') || ai.isConnected('alt') };
  });

  // Pesan keluar ke prospek/pelanggan -> selalu lewat Approval Center
  const requestMessage = (kind) => r.post(`/${kind}/:id/request-message`, { min: 'manager' }, async (ctx) => {
    const b = validate({ channel: S({ required: true, values: ['whatsapp', 'email'] }), text: S({ required: true, min: 3, max: 4000, trim: false }), subject: S({ max: 200 }), to: S({ max: 200 }) }, ctx.body);
    const tbl = kind === 'leads' ? 'leads' : 'customers';
    const row = await ctx.db.one(`select id, ${kind === 'leads' ? 'business_name as name' : 'name'}, whatsapp${kind === 'customers' ? ', email' : ''} from ${tbl} where id=$1 and workspace_id=$2`, [ctx.params.id, ctx.workspaceId]);
    if (!row) throw new HttpError(404, 'Data tidak ditemukan');
    const to = b.to || (b.channel === 'whatsapp' ? row.whatsapp : row.email);
    if (!to) throw new HttpError(400, `Tidak ada ${b.channel === 'whatsapp' ? 'nomor WhatsApp' : 'email'} untuk dituju. Isi data kontaknya dahulu.`);
    const a = await ctx.db.one("insert into approvals (workspace_id, action_type, title, description, payload, requested_by_user_id) values ($1,'send_message',$2,$3,$4::jsonb,$5) returning id, status",
      [ctx.workspaceId, `Kirim ${b.channel} ke ${row.name}`, b.text.slice(0, 300), JSON.stringify({ channel: b.channel, to, text: b.text, subject: b.subject || null, [kind === 'leads' ? 'lead_id' : 'customer_id']: row.id }), ctx.user.id]);
    await audit(ctx, 'approvals.request', 'approvals', a.id, { type: 'send_message' });
    ctx.status = 201;
    return { approval_id: a.id, status: a.status, note: 'Menunggu persetujuan Anda di Approval Center.' };
  });
  requestMessage('leads'); requestMessage('customers');

  // ----- Pelanggan -----
  crud(r, { path: '/customers', table: 'customers', schema: CUSTOMER_SCHEMA, label: 'Pelanggan', search: ['name', 'business_name', 'whatsapp', 'email'], filters: ['business_unit_id', 'category'], minWrite: 'manager',
    beforeCreate: (c, d) => { if (d.whatsapp) d.whatsapp = normalizeWa(d.whatsapp); return d; } });
  r.get('/customers/:id/detail', async ({ db, workspaceId, params }) => {
    const c = await db.one('select * from customers where id=$1 and workspace_id=$2', [params.id, workspaceId]);
    if (!c) throw new HttpError(404, 'Pelanggan tidak ditemukan');
    const [comms, orders, quotes, mem] = await Promise.all([
      db.query('select id, channel, direction, content, status, created_at from communications where customer_id=$1 order by created_at desc limit 100', [c.id]),
      db.query('select id, order_no, status, payment_status, total::float as total, created_at from orders where customer_id=$1 order by created_at desc', [c.id]),
      db.query('select id, number, total::float as total, status, created_at from quotations where customer_id=$1 order by created_at desc', [c.id]),
      db.query("select id, content, importance, created_at from agent_memories where customer_id=$1 and scope='customer' order by created_at desc limit 30", [c.id])
    ]);
    return { customer: c, communications: comms, orders, quotations: quotes, memories: mem };
  });

  // Catatan riwayat komunikasi (internal/manual). Mengirim pesan sungguhan hanya lewat request-message + persetujuan.
  const COMM = { channel: S({ max: 30, default: 'catatan' }), direction: S({ values: ['in', 'out', 'internal'], default: 'internal' }), content: S({ required: true, min: 2, max: 4000 }) };
  for (const kind of ['leads', 'customers']) {
    const col = kind === 'leads' ? 'lead_id' : 'customer_id';
    r.post(`/${kind}/:id/communications`, { min: 'manager' }, async (ctx) => {
      const b = validate(COMM, ctx.body);
      if (!(await ctx.db.one(`select 1 from ${kind} where id=$1 and workspace_id=$2`, [ctx.params.id, ctx.workspaceId]))) throw new HttpError(404, 'Data tidak ditemukan');
      const row = await ctx.db.one(`insert into communications (workspace_id, ${col}, channel, direction, content, status) values ($1,$2,$3,$4,$5,'tercatat') returning *`, [ctx.workspaceId, ctx.params.id, b.channel, b.direction, b.content]);
      await audit(ctx, 'communications.create', 'communications', row.id);
      ctx.status = 201; return row;
    });
  }
};
