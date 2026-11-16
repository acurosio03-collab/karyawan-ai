'use strict';
// Registry tools. Semua akses AI ke data/layanan lewat sini: validasi input, cek izin agen, log eksekusi.
const crypto = require('crypto');
const { validate, describeSchema } = require('../lib/validate');
const { HttpError } = require('../lib/http');
const { evaluate } = require('./calculator');
const { buildSite } = require('./site');
const search = require('../services/search');
const finance = require('../services/finance');
const integrations = require('../services/integrations');
const limits = require('../workflows/default').limits;

const DEFS = {};
const def = (d) => { DEFS[d.name] = d; };
const str = (o = {}) => ({ type: 'string', ...o });
const rnd = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const ymd = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const { norm, digits, domainOf, domainType } = require('../lib/leads');

async function unitIdByCode(db, ws, code) {
  if (!code) return null;
  const r = await db.one('select id from business_units where workspace_id=$1 and code=$2', [ws, code]);
  return r ? r.id : null;
}

// ---------- web_search ----------
def({ name: 'web_search', permission: 'read', description: 'Mencari informasi di web lewat API pencarian. Mengembalikan judul, URL, dan cuplikan.',
  input: { query: str({ required: true, min: 3, max: 200 }), max_results: { type: 'int', min: 1, max: 10, default: 6 } },
  output: 'results[{title,url,snippet}]',
  async run(ctx, i) { await integrations.assertEnabled(ctx.db, ctx.workspaceId, 'web_search'); return { results: await search.webSearch(i.query, i.max_results) }; } });

// ---------- db_query (hanya kueri bernama, baca saja, selalu dibatasi workspace) ----------
const QUERIES = {
  leads_summary: 'select status, count(*)::int as n from leads where workspace_id=$1 group by status order by n desc',
  leads_recent: 'select id, business_name, category, status, website, has_website, whatsapp, source_url, priority from leads where workspace_id=$1 order by created_at desc limit 20',
  customers_list: 'select id, name, business_name, category, whatsapp from customers where workspace_id=$1 order by created_at desc limit 30',
  customers_count: 'select count(*)::int as n from customers where workspace_id=$1',
  products_list: 'select id, name, sku, type, price::float as price from products where workspace_id=$1 and active order by name limit 60',
  orders_summary: 'select status, payment_status, count(*)::int as n, coalesce(sum(total),0)::float as total from orders where workspace_id=$1 group by 1,2',
  orders_recent: 'select id, order_no, status, payment_status, total::float as total, created_at from orders where workspace_id=$1 order by created_at desc limit 20',
  tasks_summary: 'select status, count(*)::int as n from tasks where workspace_id=$1 group by status',
  finance_summary: "select type, coalesce(sum(amount),0)::float as total from transactions where workspace_id=$1 group by type",
  agents_list: 'select name, title, department, status, skills from agents where workspace_id=$1 order by name',
  business_units: 'select code, name, description from business_units where workspace_id=$1 order by name'
};
def({ name: 'db_query', permission: 'read', description: 'Membaca data perusahaan lewat kueri bernama yang sudah disetujui: ' + Object.keys(QUERIES).join(', ') + '. Tidak ada SQL bebas.',
  input: { query_name: str({ required: true, values: Object.keys(QUERIES) }) }, output: 'rows[]',
  async run(ctx, i) { return { rows: await ctx.db.query(QUERIES[i.query_name], [ctx.workspaceId]) }; } });

// ---------- file_reader / file_generator ----------
def({ name: 'file_reader', permission: 'read', description: 'Membaca berkas yang tersimpan di workspace (hasil kerja sebelumnya) berdasarkan nama atau ID. Maks 20.000 karakter.',
  input: { file: str({ required: true, max: 200, desc: 'nama berkas atau ID' }) }, output: '{name,mime,content}',
  async run(ctx, i) {
    const f = await ctx.db.one('select id, name, mime, content from files where workspace_id=$1 and (id::text=$2 or name=$2) order by created_at desc limit 1', [ctx.workspaceId, i.file]);
    if (!f) throw new HttpError(404, 'Berkas tidak ditemukan');
    return { id: f.id, name: f.name, mime: f.mime, content: f.content.slice(0, 20000), truncated: f.content.length > 20000 };
  } });
def({ name: 'file_generator', permission: 'write', description: 'Menyimpan dokumen/berkas hasil kerja (markdown/teks/html/csv) ke workspace.',
  input: { name: str({ required: true, max: 120, pattern: /^[\w\-./ ]{1,120}$/, patternMsg: 'nama berkas hanya huruf/angka/_-./ spasi' }), content: str({ required: true, max: 200000, trim: false }), mime: str({ max: 60, default: 'text/markdown' }) },
  output: '{file_id,name,size}',
  async run(ctx, i) {
    if (i.name.includes('..')) throw new HttpError(400, 'Nama berkas tidak valid');
    const r = await ctx.db.one('insert into files (workspace_id, task_id, name, mime, content, size, created_by_agent_id) values ($1,$2,$3,$4,$5,$6,$7) returning id', [ctx.workspaceId, ctx.taskId || null, i.name, i.mime, i.content, Buffer.byteLength(i.content), ctx.agent ? ctx.agent.id : null]);
    return { file_id: r.id, name: i.name, size: Buffer.byteLength(i.content) };
  } });

// ---------- website_generator ----------
def({ name: 'website_generator', permission: 'write', description: 'Membuat proyek website statis (index.html, style.css, script.js) dari konten bisnis nyata. Kontak hanya dipakai bila diberikan.',
  input: { business_name: str({ required: true, max: 80 }), tagline: str({ max: 140 }), category: str({ max: 60 }), description: str({ max: 600 }),
    whatsapp: str({ max: 20, pattern: /^\+?[0-9]{8,15}$/, patternMsg: 'nomor WhatsApp hanya angka (8-15 digit)' }), address: str({ max: 200 }),
    services: { type: 'array', max: 8, items: { type: 'object', shape: { name: str({ required: true, max: 60 }), desc: str({ max: 200 }) } } },
    primary_color: str({ pattern: /^#[0-9a-fA-F]{6}$/ }), accent_color: str({ pattern: /^#[0-9a-fA-F]{6}$/ }) },
  output: '{files:[{file_id,name}]}',
  async run(ctx, i) {
    const files = buildSite(i); const out = [];
    for (const f of files) {
      const r = await ctx.db.one('insert into files (workspace_id, task_id, name, mime, content, size, created_by_agent_id) values ($1,$2,$3,$4,$5,$6,$7) returning id', [ctx.workspaceId, ctx.taskId || null, f.name, f.mime, f.content, Buffer.byteLength(f.content), ctx.agent ? ctx.agent.id : null]);
      out.push({ file_id: r.id, name: f.name });
    }
    return { files: out, note: 'Proyek disimpan sebagai berkas. Deploy ke pelanggan memerlukan persetujuan Owner (request_approval: deploy_website).' };
  } });

// ---------- calculator ----------
def({ name: 'calculator', permission: 'read', description: 'Menghitung ekspresi matematika (+ - * / % ^ ( ) sqrt abs round floor ceil min max). Tanpa pemisah ribuan.',
  input: { expression: str({ required: true, max: 200 }) }, output: '{result:number}',
  async run(ctx, i) { try { return { result: evaluate(i.expression) }; } catch (e) { throw new HttpError(400, 'Ekspresi tidak valid: ' + e.message); } } });

// ---------- business_research ----------
const PHONE_RE = /(?:\+62|62|0)\s?8[1-9][0-9][\s-]?[0-9]{3,4}[\s-]?[0-9]{2,5}/g;
def({ name: 'business_research', permission: 'read', description: 'Mencari kandidat bisnis lokal di web. Mengembalikan hasil mentah dengan klasifikasi domain; nomor telepon hanya yang tertulis di cuplikan sumber. Verifikasi lalu simpan lewat save_lead.',
  input: { category: str({ required: true, max: 80 }), location: str({ required: true, max: 80 }), extra: str({ max: 80 }), max_results: { type: 'int', min: 1, max: 10, default: 8 } },
  output: 'candidates[{title,url,domain,domain_type,likely_no_website,phones_in_snippet,snippet}]',
  async run(ctx, i) {
    await integrations.assertEnabled(ctx.db, ctx.workspaceId, 'web_search');
    const qs = [`${i.category} ${i.location} ${i.extra || ''}`.trim(), `${i.category} ${i.location} kontak whatsapp alamat`];
    const seen = new Map();
    for (const q of qs) {
      const rs = await search.webSearch(q, i.max_results);
      for (const r of rs) if (r.url && !seen.has(r.url)) seen.set(r.url, r);
    }
    const candidates = [...seen.values()].slice(0, i.max_results * 2).map((r) => {
      const d = domainOf(r.url); const t = domainType(d);
      const phones = [...new Set(((r.snippet || '').match(PHONE_RE) || []).map((x) => x.replace(/[\s-]/g, '')))];
      return { title: r.title, url: r.url, domain: d, domain_type: t, likely_no_website: t !== 'own_site', phones_in_snippet: phones, snippet: (r.snippet || '').slice(0, 300) };
    });
    return { candidates, note: 'likely_no_website hanyalah petunjuk (kemungkinan). Verifikasi manual sebelum menghubungi.' };
  } });

// ---------- save_lead ----------
def({ name: 'save_lead', permission: 'write', description: 'Menyimpan prospek nyata. Wajib source_url dan evidence (kutipan sumber). WhatsApp/alamat dibuang bila tidak ditemukan dalam evidence. Duplikat otomatis ditolak.',
  input: { business_name: str({ required: true, max: 120 }), contact_name: str({ max: 120 }), category: str({ max: 80 }), whatsapp: str({ max: 20 }), address: str({ max: 250 }),
    website: { type: 'url' }, source_url: { type: 'url', required: true }, evidence: str({ required: true, min: 10, max: 1500 }), notes: str({ max: 500 }),
    potential_value: { type: 'number', min: 0, max: 1e12 }, business_unit_code: str({ max: 30 }) },
  output: '{lead_id,duplicate,priority}',
  async run(ctx, i) {
    const dropped = [];
    let wa = i.whatsapp ? digits(i.whatsapp) : '';
    if (wa) {
      const tail = wa.replace(/^(62|0)/, '').slice(-8);
      if (!digits(i.evidence).includes(tail)) { dropped.push('whatsapp'); wa = ''; } else if (wa.startsWith('0')) wa = '62' + wa.slice(1);
    }
    let address = i.address || '';
    if (address) {
      const toks = norm(address).split(' ').filter((t) => t.length >= 4);
      const ev = norm(i.evidence);
      if (toks.length && toks.filter((t) => ev.includes(t)).length * 2 <= toks.length) { dropped.push('address'); address = ''; }
    }
    const srcDomain = domainOf(i.source_url); const srcType = domainType(srcDomain);
    const siteDomain = i.website ? domainOf(i.website) : '';
    const hasSite = siteDomain ? domainType(siteDomain) === 'own_site' : (srcType !== 'own_site' ? false : null);
    const key = wa ? 'wa:' + wa : (siteDomain && domainType(siteDomain) === 'own_site' ? 'd:' + siteDomain : 'n:' + norm(i.business_name));
    const unitId = await unitIdByCode(ctx.db, ctx.workspaceId, i.business_unit_code);
    const priority = Math.min(10, 4 + (hasSite === false ? 3 : 0) + (wa ? 2 : 0) + (i.potential_value ? 1 : 0));
    const notes = [i.notes, dropped.length ? `Dibuang karena tidak ada di bukti: ${dropped.join(', ')}` : '', hasSite === false ? 'Kemungkinan belum punya website (belum diverifikasi manual).' : ''].filter(Boolean).join(' | ');
    const row = await ctx.db.one(
      `insert into leads (workspace_id, business_unit_id, business_name, contact_name, category, whatsapp, address, website, has_website, source, source_url, evidence, potential_value, priority, notes, dedupe_key, created_by_agent_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ai_research',$10,$11,$12,$13,$14,$15,$16) on conflict (workspace_id, dedupe_key) do nothing returning id`,
      [ctx.workspaceId, unitId, i.business_name, i.contact_name || null, i.category || null, wa || null, address || null, i.website || null, hasSite, i.source_url, i.evidence, i.potential_value || null, priority, notes || null, key, ctx.agent ? ctx.agent.id : null]);
    if (!row) { const ex = await ctx.db.one('select id from leads where workspace_id=$1 and dedupe_key=$2', [ctx.workspaceId, key]); return { lead_id: ex && ex.id, duplicate: true }; }
    return { lead_id: row.id, duplicate: false, priority, dropped_fields: dropped };
  } });

// ---------- create_quotation_draft ----------
def({ name: 'create_quotation_draft', permission: 'write', description: 'Membuat DRAFT penawaran (belum terkirim). Harga dari product_id diambil dari database; total dihitung server.',
  input: { customer_id: { type: 'uuid' }, lead_id: { type: 'uuid' }, business_unit_code: str({ max: 30 }), notes: str({ max: 1000 }),
    items: { type: 'array', required: true, max: 30, items: { type: 'object', shape: { name: str({ max: 120 }), qty: { type: 'number', min: 0.01, max: 100000, default: 1 }, price: { type: 'number', min: 0, max: 1e11 }, product_id: { type: 'uuid' } } } } },
  output: '{quotation_id,number,total}',
  async run(ctx, i) {
    if (!i.customer_id && !i.lead_id) throw new HttpError(400, 'customer_id atau lead_id wajib');
    if (i.customer_id && !(await ctx.db.one('select 1 from customers where id=$1 and workspace_id=$2', [i.customer_id, ctx.workspaceId]))) throw new HttpError(404, 'Pelanggan tidak ditemukan');
    if (i.lead_id && !(await ctx.db.one('select 1 from leads where id=$1 and workspace_id=$2', [i.lead_id, ctx.workspaceId]))) throw new HttpError(404, 'Prospek tidak ditemukan');
    const items = [];
    for (const it of i.items) {
      if (it.product_id) {
        const p = await ctx.db.one('select name, price::float as price from products where id=$1 and workspace_id=$2 and active', [it.product_id, ctx.workspaceId]);
        if (!p) throw new HttpError(404, 'Produk tidak ditemukan: ' + it.product_id);
        items.push({ name: p.name, qty: it.qty, price: p.price, product_id: it.product_id });
      } else {
        if (!it.name || it.price === undefined) throw new HttpError(400, 'Item tanpa product_id wajib punya name dan price');
        items.push({ name: it.name, qty: it.qty, price: it.price });
      }
    }
    const total = items.reduce((s, x) => s + x.qty * x.price, 0);
    const number = `Q-${ymd()}-${rnd()}`;
    const unitId = await unitIdByCode(ctx.db, ctx.workspaceId, i.business_unit_code);
    const q = await ctx.db.one('insert into quotations (workspace_id, business_unit_id, customer_id, lead_id, number, items, total, notes, created_by_agent_id) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) returning id',
      [ctx.workspaceId, unitId, i.customer_id || null, i.lead_id || null, number, JSON.stringify(items), total, i.notes || null, ctx.agent ? ctx.agent.id : null]);
    return { quotation_id: q.id, number, total, status: 'draft', note: 'Draft belum terkirim. Ajukan request_approval (send_quotation) bila siap.' };
  } });

// ---------- create_invoice_draft ----------
def({ name: 'create_invoice_draft', permission: 'write', description: 'Membuat DRAFT invoice dari pesanan yang sudah ada (item & total diambil dari pesanan).',
  input: { order_id: { type: 'uuid', required: true }, due_days: { type: 'int', min: 1, max: 90, default: 14 }, notes: str({ max: 500 }) }, output: '{invoice_id,invoice_no,total}',
  async run(ctx, i) {
    const o = await ctx.db.one('select id, business_unit_id, customer_id from orders where id=$1 and workspace_id=$2', [i.order_id, ctx.workspaceId]);
    if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
    const ex = await ctx.db.one("select id, invoice_no, total::float as total from invoices where order_id=$1 and status <> 'void'", [o.id]);
    if (ex) return { invoice_id: ex.id, invoice_no: ex.invoice_no, total: ex.total, existing: true };
    const items = await ctx.db.query('select name, qty::float as qty, price::float as price from order_items where order_id=$1', [o.id]);
    if (!items.length) throw new HttpError(400, 'Pesanan tidak memiliki item');
    const total = items.reduce((s, x) => s + x.qty * x.price, 0); const no = `INV-${ymd()}-${rnd()}`;
    const inv = await ctx.db.one("insert into invoices (workspace_id, business_unit_id, order_id, customer_id, invoice_no, items, total, due_date, notes, created_by_agent_id) values ($1,$2,$3,$4,$5,$6::jsonb,$7, current_date + $8::int,$9,$10) returning id",
      [ctx.workspaceId, o.business_unit_id, o.id, o.customer_id, no, JSON.stringify(items), total, i.due_days, i.notes || null, ctx.agent ? ctx.agent.id : null]);
    return { invoice_id: inv.id, invoice_no: no, total, status: 'draft' };
  } });

// ---------- request_approval ----------
const ACTIONS = ['send_message', 'send_quotation', 'issue_invoice', 'deploy_website', 'purchase_service', 'make_payment', 'change_important_data', 'accept_order'];
def({ name: 'request_approval', permission: 'write', description: 'Mengajukan tindakan penting ke Owner (kirim pesan/penawaran, terbitkan invoice, deploy, beli layanan, pembayaran, ubah data penting, terima pesanan). Tindakan BELUM dilakukan sampai Owner menyetujui.',
  input: { action_type: str({ required: true, values: ACTIONS }), title: str({ required: true, max: 160 }), description: str({ max: 1500 }),
    payload: { type: 'object', default: {}, maxBytes: 8000, desc: 'mis. {quotation_id}, {invoice_id}, {order_id}, {channel:"whatsapp|email", to, text, lead_id|customer_id}' } },
  output: '{approval_id,status}',
  async run(ctx, i) {
    const a = await ctx.db.one('insert into approvals (workspace_id, action_type, title, description, payload, requested_by_agent_id, task_id) values ($1,$2,$3,$4,$5::jsonb,$6,$7) returning id',
      [ctx.workspaceId, i.action_type, i.title, i.description || null, JSON.stringify(i.payload || {}), ctx.agent ? ctx.agent.id : null, ctx.taskId || null]);
    const p = i.payload || {};
    if (i.action_type === 'send_quotation' && p.quotation_id) await ctx.db.exec("update quotations set status='pending_approval' where id=$1 and workspace_id=$2 and status='draft'", [p.quotation_id, ctx.workspaceId]).catch(() => {});
    if (i.action_type === 'issue_invoice' && p.invoice_id) await ctx.db.exec("update invoices set status='pending_approval' where id=$1 and workspace_id=$2 and status='draft'", [p.invoice_id, ctx.workspaceId]).catch(() => {});
    return { approval_id: a.id, status: 'pending', note: 'Menunggu persetujuan Owner. Tindakan BELUM dilakukan.' };
  } });

// ---------- send_agent_message ----------
def({ name: 'send_agent_message', permission: 'write', description: 'Mengirim pesan internal ke karyawan AI lain (berdasarkan nama atau role_key).',
  input: { to: str({ required: true, max: 80 }), content: str({ required: true, max: 2000 }) }, output: '{sent:true}',
  async run(ctx, i) {
    const t = await ctx.db.one("select id from agents where workspace_id=$1 and status='active' and (lower(name)=lower($2) or role_key=$2) limit 1", [ctx.workspaceId, i.to]);
    if (!t) throw new HttpError(404, 'Karyawan tujuan tidak ditemukan');
    await ctx.db.exec("insert into agent_messages (workspace_id, task_id, from_agent_id, to_agent_id, kind, content) values ($1,$2,$3,$4,'message',$5)", [ctx.workspaceId, ctx.taskId || null, ctx.agent ? ctx.agent.id : null, t.id, i.content]);
    return { sent: true };
  } });

// ---------- report_generator ----------
def({ name: 'report_generator', permission: 'write', description: 'Membuat laporan markdown dari data nyata (tugas, prospek, pesanan, keuangan) untuk periode tertentu dan menyimpannya sebagai berkas.',
  input: { title: str({ required: true, max: 120 }), period: str({ values: ['day', 'week', 'month'], default: 'week' }), business_unit_code: str({ max: 30 }) }, output: '{file_id,markdown}',
  async run(ctx, i) {
    const days = { day: 1, week: 7, month: 30 }[i.period]; const ws = ctx.workspaceId;
    const unitId = await unitIdByCode(ctx.db, ws, i.business_unit_code); const since = new Date(Date.now() - days * 86400000);
    const [t, l, o, c] = await Promise.all([
      ctx.db.query('select status, count(*)::int n from tasks where workspace_id=$1 and created_at>=$2 group by 1', [ws, since]),
      ctx.db.one('select count(*)::int n from leads where workspace_id=$1 and created_at>=$2 and ($3::uuid is null or business_unit_id=$3)', [ws, since, unitId]),
      ctx.db.one("select count(*)::int n, coalesce(sum(total),0)::float total from orders where workspace_id=$1 and created_at>=$2 and status not in ('draft','cancelled') and ($3::uuid is null or business_unit_id=$3)", [ws, since, unitId]),
      ctx.db.one('select count(*)::int n from customers where workspace_id=$1 and created_at>=$2 and ($3::uuid is null or business_unit_id=$3)', [ws, since, unitId])]);
    const f = await finance.summary(ctx.db, ws, { days, unitId });
    const fmt = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');
    const md = `# ${i.title}\n\nPeriode: ${days} hari terakhir (per ${new Date().toISOString().slice(0, 10)})\n\n## Tugas\n${t.length ? t.map((x) => `- ${x.status}: ${x.n}`).join('\n') : '- Tidak ada tugas pada periode ini'}\n\n## Penjualan\n- Prospek baru: ${l.n}\n- Pelanggan baru: ${c.n}\n- Pesanan: ${o.n} (nilai ${fmt(o.total)})\n\n## Keuangan (transaksi tercatat)\n- Pemasukan: ${fmt(f.income)}\n- Pengeluaran: ${fmt(f.expense)}\n- Biaya API: USD ${f.apiCostUsd.toFixed(4)}${f.apiCostIdr !== null ? ` (≈ ${fmt(f.apiCostIdr)})` : ' (belum dikonversi ke Rupiah)'}\n- Keuntungan bersih: ${fmt(f.net)}\n\n_Seluruh angka bersumber dari database; tidak ada proyeksi._\n`;
    const r = await ctx.db.one('insert into files (workspace_id, task_id, name, mime, content, size, created_by_agent_id) values ($1,$2,$3,$4,$5,$6,$7) returning id',
      [ws, ctx.taskId || null, `laporan/${ymd()}-${rnd()}.md`, 'text/markdown', md, Buffer.byteLength(md), ctx.agent ? ctx.agent.id : null]);
    return { file_id: r.id, markdown: md };
  } });

// ================= Registry API =================
const listDefs = () => Object.values(DEFS).map((d) => ({ name: d.name, description: d.description, permission: d.permission, input_schema: describeSchema(d.input), output_schema: { returns: d.output } }));

async function seedTools(db, workspaceId) {
  for (const d of listDefs()) {
    await db.exec('insert into tools (workspace_id, name, description, permission, input_schema, output_schema) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb) on conflict (workspace_id, name) do update set description=excluded.description, permission=excluded.permission, input_schema=excluded.input_schema, output_schema=excluded.output_schema',
      [workspaceId, d.name, d.description, d.permission, JSON.stringify(d.input_schema), JSON.stringify(d.output_schema)]);
  }
}

const clip = (o, n = 6000) => { const s = JSON.stringify(o); return s.length > n ? { truncated: true, preview: s.slice(0, n) } : o; };

// Eksekusi satu tool atas nama agen. Tidak melempar error ke AI - mengembalikan {error} agar AI bisa melaporkan jujur.
async function runTool(ctx, name, rawInput) {
  const started = Date.now(); let status = 'success', error = null, output = null;
  const log = () => ctx.db.exec('insert into tool_logs (workspace_id, tool_name, agent_id, task_id, run_id, input, output, status, error, duration_ms) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)',
    [ctx.workspaceId, name, ctx.agent ? ctx.agent.id : null, ctx.taskId || null, ctx.runId || null, JSON.stringify(clip(rawInput || {}, 4000)), JSON.stringify(clip(output || {}, 4000)), status, error, Date.now() - started]).catch(() => {});
  try {
    const d = DEFS[name];
    if (!d) throw Object.assign(new HttpError(404, 'Tool tidak dikenal: ' + name), { denied: true });
    if (!ctx.agent || !(ctx.agent.tools || []).includes(name)) throw Object.assign(new HttpError(403, `Karyawan ini tidak diizinkan memakai tool ${name}`), { denied: true });
    const row = await ctx.db.one('select status from tools where workspace_id=$1 and name=$2', [ctx.workspaceId, name]);
    if (row && row.status !== 'active') throw Object.assign(new HttpError(403, `Tool ${name} sedang dinonaktifkan`), { denied: true });
    const input = validate(d.input, rawInput || {});
    output = await Promise.race([d.run(ctx, input), new Promise((_, rej) => setTimeout(() => rej(new HttpError(504, 'Tool melewati batas waktu')), 25000))]);
    await log();
    return clip(output);
  } catch (e) {
    status = e.denied ? 'denied' : 'error'; error = String(e.message || e).slice(0, 400);
    output = { error };
    await log();
    return { error: (e.code === 'NOT_CONNECTED' ? 'NOT CONNECTED: ' : '') + error };
  }
}
module.exports = { DEFS, QUERIES, listDefs, seedTools, runTool, ACTIONS };
