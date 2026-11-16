'use strict';
const crypto = require('crypto');
const { crud } = require('../../lib/crud');
const { HttpError } = require('../../lib/http');
const { validate } = require('../../lib/validate');
const { audit } = require('../../services/audit');
const tools = require('../../tools');

const S = (o = {}) => ({ type: 'string', ...o });
const rnd = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const ymd = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const toolCtx = (c) => ({ db: c.db, workspaceId: c.workspaceId, agent: null, taskId: null });
const ITEM = { product_id: { type: 'uuid' }, name: S({ max: 120 }), qty: { type: 'number', min: 0.01, max: 100000, default: 1 }, price: { type: 'number', min: 0, max: 1e11 } };

const PRODUCT_SCHEMA = {
  name: S({ required: true, min: 2, max: 120 }), sku: S({ max: 60 }), description: S({ max: 1000 }), type: S({ max: 40, default: 'jasa' }),
  price: { type: 'number', min: 0, max: 1e11, default: 0 }, cost: { type: 'number', min: 0, max: 1e11, default: 0 }, active: { type: 'bool' }, business_unit_id: { type: 'uuid', ref: 'business_units' }
};

// Hitung item pesanan: harga dari produk (database) bila product_id diberikan
async function resolveItems(db, ws, raw) {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Minimal satu item');
  if (raw.length > 50) throw new HttpError(400, 'Maksimal 50 item');
  const items = [];
  for (const x of raw) {
    const it = validate(ITEM, x);
    if (it.product_id) {
      const p = await db.one('select name, price::float as price from products where id=$1 and workspace_id=$2', [it.product_id, ws]);
      if (!p) throw new HttpError(404, 'Produk tidak ditemukan');
      items.push({ product_id: it.product_id, name: it.name || p.name, qty: it.qty, price: it.price !== undefined ? it.price : p.price });
    } else {
      if (!it.name || it.price === undefined) throw new HttpError(400, 'Item tanpa produk wajib memiliki nama dan harga');
      items.push({ product_id: null, name: it.name, qty: it.qty, price: it.price });
    }
  }
  return items;
}
const sum = (items) => Math.round(items.reduce((s, x) => s + x.qty * x.price, 0) * 100) / 100;

async function insertOrder(t, ws, { customer_id, business_unit_id, notes, status }, items) {
  const o = await t.one('insert into orders (workspace_id, business_unit_id, customer_id, order_no, status, total, notes) values ($1,$2,$3,$4,$5,$6,$7) returning *',
    [ws, business_unit_id || null, customer_id || null, `ORD-${ymd()}-${rnd()}`, status, sum(items), notes || null]);
  for (const it of items) await t.exec('insert into order_items (order_id, product_id, name, qty, price) values ($1,$2,$3,$4,$5)', [o.id, it.product_id, it.name, it.qty, it.price]);
  return o;
}

module.exports = (r) => {
  crud(r, { path: '/products', table: 'products', schema: PRODUCT_SCHEMA, label: 'Produk', orderBy: 'name asc', search: ['name', 'sku'], filters: ['business_unit_id', 'type', 'active'], minWrite: 'manager', minDelete: 'admin' });

  // ----- Pesanan -----
  r.get('/orders', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['o.workspace_id=$1'];
    for (const f of ['status', 'payment_status', 'business_unit_id', 'customer_id']) if (query[f]) { p.push(query[f]); where.push(`o.${f}=$${p.length}`); }
    if (query.q) { p.push('%' + String(query.q).slice(0, 80) + '%'); where.push(`(o.order_no ilike $${p.length} or c.name ilike $${p.length})`); }
    return { items: await db.query(`select o.id, o.order_no, o.status, o.payment_status, o.total::float as total, o.paid_amount::float as paid_amount, o.created_at, o.business_unit_id, bu.name as unit_name, c.id as customer_id, c.name as customer_name
      from orders o left join customers c on c.id=o.customer_id left join business_units bu on bu.id=o.business_unit_id where ${where.join(' and ')} order by o.created_at desc limit 300`, p) };
  });
  r.get('/orders/:id', async ({ db, workspaceId: ws, params }) => {
    const o = await db.one('select o.*, o.total::float as total_n, o.paid_amount::float as paid_n, c.name as customer_name, bu.name as unit_name from orders o left join customers c on c.id=o.customer_id left join business_units bu on bu.id=o.business_unit_id where o.id=$1 and o.workspace_id=$2', [params.id, ws]);
    if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
    const [items, invoices, tx] = await Promise.all([
      db.query('select id, product_id, name, qty::float as qty, price::float as price from order_items where order_id=$1 order by name', [o.id]),
      db.query('select id, invoice_no, status, total::float as total, due_date, issued_at from invoices where order_id=$1 order by created_at desc', [o.id]),
      db.query('select id, type, category, amount::float as amount, description, source, occurred_at from transactions where order_id=$1 order by occurred_at desc', [o.id])
    ]);
    const { total_n, paid_n, ...order } = o; order.total = total_n; order.paid_amount = paid_n;
    return { order, items, invoices, transactions: tx };
  });
  r.post('/orders', { min: 'manager' }, async (ctx) => {
    const b = validate({ customer_id: { type: 'uuid' }, business_unit_id: { type: 'uuid' }, notes: S({ max: 1000 }), status: S({ values: ['draft', 'confirmed'], default: 'confirmed' }), items: { type: 'array', required: true, max: 50 } }, ctx.body);
    if (b.customer_id && !(await ctx.db.one('select 1 from customers where id=$1 and workspace_id=$2', [b.customer_id, ctx.workspaceId]))) throw new HttpError(400, 'Pelanggan tidak ditemukan');
    if (b.business_unit_id && !(await ctx.db.one('select 1 from business_units where id=$1 and workspace_id=$2', [b.business_unit_id, ctx.workspaceId]))) throw new HttpError(400, 'Unit bisnis tidak ditemukan');
    const items = await resolveItems(ctx.db, ctx.workspaceId, b.items);
    const o = await ctx.db.tx((t) => insertOrder(t, ctx.workspaceId, b, items));
    await audit(ctx, 'orders.create', 'orders', o.id, { total: o.total });
    ctx.status = 201; return o;
  });
  r.patch('/orders/:id', { min: 'manager' }, async (ctx) => {
    const b = validate({ status: S({ values: ['draft', 'confirmed', 'in_progress', 'completed', 'cancelled'] }), notes: S({ max: 1000 }) }, ctx.body, { partial: true });
    if (!Object.keys(b).length) throw new HttpError(400, 'Tidak ada perubahan');
    const o = await ctx.db.one('select status, paid_amount::float as paid from orders where id=$1 and workspace_id=$2', [ctx.params.id, ctx.workspaceId]);
    if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
    if (b.status === 'cancelled' && o.paid > 0) throw new HttpError(409, 'Pesanan sudah ada pembayaran. Lakukan refund terlebih dahulu sebelum membatalkan.');
    const row = await ctx.db.one('update orders set status=coalesce($3,status), notes=coalesce($4,notes) where id=$1 and workspace_id=$2 returning *', [ctx.params.id, ctx.workspaceId, b.status || null, b.notes === undefined ? null : b.notes]);
    await audit(ctx, 'orders.update', 'orders', ctx.params.id, b);
    return row;
  });
  r.delete('/orders/:id', { min: 'admin' }, async (ctx) => {
    const n = await ctx.db.exec("delete from orders where id=$1 and workspace_id=$2 and status in ('draft','cancelled') and paid_amount=0", [ctx.params.id, ctx.workspaceId]);
    if (!n) throw new HttpError(409, 'Hanya pesanan draft/dibatalkan tanpa pembayaran yang dapat dihapus');
    await audit(ctx, 'orders.delete', 'orders', ctx.params.id);
    return { ok: true };
  });

  // Pembayaran nyata -> transaksi income (satu-satunya jalur pendapatan dari pesanan)
  r.post('/orders/:id/payments', { min: 'admin' }, async (ctx) => {
    const b = validate({ amount: { type: 'number', required: true, min: 0.01, max: 1e11 }, note: S({ max: 300 }), occurred_at: { type: 'date' } }, ctx.body);
    return ctx.db.tx(async (t) => {
      const o = await t.one('select * from orders where id=$1 and workspace_id=$2 for update', [ctx.params.id, ctx.workspaceId]);
      if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
      if (['draft', 'cancelled'].includes(o.status)) throw new HttpError(409, 'Pesanan draft/dibatalkan tidak dapat dibayar');
      const total = Number(o.total), paid = Number(o.paid_amount), remaining = Math.round((total - paid) * 100) / 100;
      if (b.amount > remaining + 0.001) throw new HttpError(400, `Pembayaran melebihi sisa tagihan (sisa ${remaining})`);
      await t.exec("insert into transactions (workspace_id, business_unit_id, type, category, amount, description, order_id, source, occurred_at, created_by) values ($1,$2,'income','penjualan',$3,$4,$5,'order_payment',coalesce($6::timestamptz, now()),$7)",
        [ctx.workspaceId, o.business_unit_id, b.amount, b.note || `Pembayaran ${o.order_no}`, o.id, b.occurred_at || null, ctx.user.id]);
      const newPaid = paid + b.amount; const status = newPaid + 0.001 >= total ? 'paid' : 'partial';
      const row = await t.one('update orders set paid_amount=$3, payment_status=$4 where id=$1 and workspace_id=$2 returning *', [o.id, ctx.workspaceId, newPaid, status]);
      if (status === 'paid') await t.exec("update invoices set status='paid' where order_id=$1 and status='issued'", [o.id]);
      await audit({ ...ctx, db: t }, 'orders.payment', 'orders', o.id, { amount: b.amount });
      return row;
    });
  });
  r.post('/orders/:id/refund', { min: 'admin' }, async (ctx) => {
    const b = validate({ amount: { type: 'number', required: true, min: 0.01, max: 1e11 }, note: S({ max: 300 }) }, ctx.body);
    return ctx.db.tx(async (t) => {
      const o = await t.one('select * from orders where id=$1 and workspace_id=$2 for update', [ctx.params.id, ctx.workspaceId]);
      if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
      const paid = Number(o.paid_amount);
      if (b.amount > paid + 0.001) throw new HttpError(400, `Refund melebihi total terbayar (${paid})`);
      await t.exec("insert into transactions (workspace_id, business_unit_id, type, category, amount, description, order_id, source, created_by) values ($1,$2,'expense','refund',$3,$4,$5,'order_refund',$6)",
        [ctx.workspaceId, o.business_unit_id, b.amount, b.note || `Refund ${o.order_no}`, o.id, ctx.user.id]);
      const newPaid = Math.max(0, paid - b.amount);
      const row = await t.one('update orders set paid_amount=$3, payment_status=$4 where id=$1 and workspace_id=$2 returning *', [o.id, ctx.workspaceId, newPaid, newPaid <= 0 ? 'refunded' : 'partial']);
      await audit({ ...ctx, db: t }, 'orders.refund', 'orders', o.id, { amount: b.amount });
      return row;
    });
  });

  // ----- Invoice -----
  r.get('/invoices', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['i.workspace_id=$1'];
    if (query.status) { p.push(query.status); where.push(`i.status=$${p.length}`); }
    return { items: await db.query(`select i.id, i.invoice_no, i.status, i.total::float as total, i.due_date, i.issued_at, i.created_at, i.order_id, o.order_no, c.name as customer_name, bu.name as unit_name
      from invoices i left join orders o on o.id=i.order_id left join customers c on c.id=i.customer_id left join business_units bu on bu.id=i.business_unit_id where ${where.join(' and ')} order by i.created_at desc limit 300`, p) };
  });
  r.get('/invoices/:id', async ({ db, workspaceId: ws, params }) => {
    const i = await db.one('select i.*, i.total::float as total_n, c.name as customer_name, c.business_name, c.address as customer_address, c.whatsapp as customer_whatsapp, o.order_no, bu.name as unit_name from invoices i left join customers c on c.id=i.customer_id left join orders o on o.id=i.order_id left join business_units bu on bu.id=i.business_unit_id where i.id=$1 and i.workspace_id=$2', [params.id, ws]);
    if (!i) throw new HttpError(404, 'Invoice tidak ditemukan');
    const w = await db.one('select name from workspaces where id=$1', [ws]);
    i.total = i.total_n; delete i.total_n;
    return { invoice: i, company: w.name };
  });
  r.post('/orders/:id/invoice', { min: 'manager' }, async (ctx) => {
    const b = validate({ due_days: { type: 'int', min: 1, max: 90, default: 14 }, notes: S({ max: 500 }) }, ctx.body);
    const out = await tools.DEFS.create_invoice_draft.run(toolCtx(ctx), { ...b, order_id: ctx.params.id });
    await audit(ctx, 'invoices.draft', 'invoices', out.invoice_id);
    ctx.status = out.existing ? 200 : 201; return out;
  });
  const approvalFor = async (ctx, type, title, desc, payload) => {
    const dup = await ctx.db.one("select id from approvals where workspace_id=$1 and action_type=$2 and status in ('pending','review') and payload @> $3::jsonb", [ctx.workspaceId, type, JSON.stringify(payload)]);
    if (dup) throw new HttpError(409, 'Sudah ada permintaan persetujuan yang menunggu untuk data ini');
    const a = await ctx.db.one('insert into approvals (workspace_id, action_type, title, description, payload, requested_by_user_id) values ($1,$2,$3,$4,$5::jsonb,$6) returning id, status', [ctx.workspaceId, type, title, desc || null, JSON.stringify(payload), ctx.user.id]);
    await audit(ctx, 'approvals.request', 'approvals', a.id, { type });
    return a;
  };
  r.post('/invoices/:id/request-issue', { min: 'manager' }, async (ctx) => {
    const i = await ctx.db.one('select id, invoice_no, status, total::float as total from invoices where id=$1 and workspace_id=$2', [ctx.params.id, ctx.workspaceId]);
    if (!i) throw new HttpError(404, 'Invoice tidak ditemukan');
    if (i.status !== 'draft') throw new HttpError(409, 'Hanya invoice draft yang dapat diajukan');
    const a = await approvalFor(ctx, 'issue_invoice', `Terbitkan invoice ${i.invoice_no}`, `Total Rp ${Math.round(i.total).toLocaleString('id-ID')}`, { invoice_id: i.id });
    await ctx.db.exec("update invoices set status='pending_approval' where id=$1", [i.id]);
    ctx.status = 201; return { approval_id: a.id, status: a.status };
  });
  r.post('/invoices/:id/void', { min: 'admin' }, async (ctx) => {
    const n = await ctx.db.exec("update invoices set status='void' where id=$1 and workspace_id=$2 and status in ('draft','pending_approval','issued')", [ctx.params.id, ctx.workspaceId]);
    if (!n) throw new HttpError(409, 'Invoice tidak ditemukan atau sudah dibayar/dibatalkan');
    await audit(ctx, 'invoices.void', 'invoices', ctx.params.id);
    return { ok: true };
  });

  // ----- Penawaran -----
  r.get('/quotations', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['q.workspace_id=$1'];
    if (query.status) { p.push(query.status); where.push(`q.status=$${p.length}`); }
    return { items: await db.query(`select q.id, q.number, q.status, q.total::float as total, q.items, q.notes, q.created_at, q.customer_id, q.lead_id, c.name as customer_name, l.business_name as lead_name, a.name as agent_name, bu.name as unit_name
      from quotations q left join customers c on c.id=q.customer_id left join leads l on l.id=q.lead_id left join agents a on a.id=q.created_by_agent_id left join business_units bu on bu.id=q.business_unit_id where ${where.join(' and ')} order by q.created_at desc limit 300`, p) };
  });
  r.post('/quotations', { min: 'manager' }, async (ctx) => {
    const b = validate({ customer_id: { type: 'uuid' }, lead_id: { type: 'uuid' }, business_unit_code: S({ max: 30 }), notes: S({ max: 1000 }), items: { type: 'array', required: true, max: 30, items: { type: 'object', shape: ITEM } } }, ctx.body);
    const out = await tools.DEFS.create_quotation_draft.run(toolCtx(ctx), b);
    await audit(ctx, 'quotations.draft', 'quotations', out.quotation_id);
    ctx.status = 201; return out;
  });
  r.post('/quotations/:id/request-send', { min: 'manager' }, async (ctx) => {
    const b = validate({ channel: S({ required: true, values: ['whatsapp', 'email'] }), to: S({ max: 200 }), subject: S({ max: 200 }), text: S({ required: true, min: 3, max: 4000, trim: false }) }, ctx.body);
    const q = await ctx.db.one('select q.id, q.number, q.status, q.total::float as total, c.whatsapp as cw, c.email as ce, l.whatsapp as lw from quotations q left join customers c on c.id=q.customer_id left join leads l on l.id=q.lead_id where q.id=$1 and q.workspace_id=$2', [ctx.params.id, ctx.workspaceId]);
    if (!q) throw new HttpError(404, 'Penawaran tidak ditemukan');
    if (q.status !== 'draft') throw new HttpError(409, 'Hanya penawaran draft yang dapat diajukan untuk dikirim');
    const to = b.to || (b.channel === 'whatsapp' ? (q.cw || q.lw) : q.ce);
    if (!to) throw new HttpError(400, 'Tidak ada tujuan pengiriman. Isi kontak pelanggan/prospek atau isi kolom tujuan.');
    const a = await approvalFor(ctx, 'send_quotation', `Kirim penawaran ${q.number}`, `Total Rp ${Math.round(q.total).toLocaleString('id-ID')} via ${b.channel}`, { quotation_id: q.id, channel: b.channel, to, subject: b.subject || null, text: b.text });
    await ctx.db.exec("update quotations set status='pending_approval' where id=$1", [q.id]);
    ctx.status = 201; return { approval_id: a.id, status: a.status };
  });
  r.patch('/quotations/:id', { min: 'manager' }, async (ctx) => {
    const b = validate({ status: S({ required: true, values: ['accepted', 'rejected'] }) }, ctx.body);
    const row = await ctx.db.one("update quotations set status=$3 where id=$1 and workspace_id=$2 and status in ('draft','sent') returning *", [ctx.params.id, ctx.workspaceId, b.status]);
    if (!row) throw new HttpError(409, 'Penawaran tidak ditemukan atau statusnya tidak dapat diubah');
    await audit(ctx, 'quotations.' + b.status, 'quotations', row.id);
    return row;
  });
  r.post('/quotations/:id/convert', { min: 'manager' }, async (ctx) => {
    return ctx.db.tx(async (t) => {
      const q = await t.one('select * from quotations where id=$1 and workspace_id=$2 for update', [ctx.params.id, ctx.workspaceId]);
      if (!q) throw new HttpError(404, 'Penawaran tidak ditemukan');
      if (q.status === 'rejected') throw new HttpError(409, 'Penawaran sudah ditolak');
      if (!q.customer_id) throw new HttpError(409, 'Penawaran ini untuk prospek. Jadikan prospek sebagai pelanggan terlebih dahulu.');
      const items = (q.items || []).map((x) => ({ product_id: x.product_id || null, name: x.name, qty: Number(x.qty), price: Number(x.price) }));
      if (!items.length) throw new HttpError(400, 'Penawaran tidak memiliki item');
      const o = await insertOrder(t, ctx.workspaceId, { customer_id: q.customer_id, business_unit_id: q.business_unit_id, notes: `Dari penawaran ${q.number}`, status: 'confirmed' }, items);
      await t.exec("update quotations set status='accepted' where id=$1", [q.id]);
      await audit({ ...ctx, db: t }, 'quotations.convert', 'quotations', q.id, { order_id: o.id });
      ctx.status = 201; return o;
    });
  });
};
