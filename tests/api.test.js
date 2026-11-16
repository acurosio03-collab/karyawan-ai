'use strict';
// Uji integrasi end-to-end terhadap PostgreSQL ASLI. Dijalankan bila TEST_DATABASE_URL diisi (akan MENGHAPUS isi schema public database itu!).
// Panggilan AI diganti skrip tetap (mock) KHUSUS pada uji alur orkestrasi; selebihnya semua jalur memakai database sungguhan.
const { TEST_DB_URL } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');

if (!TEST_DB_URL) { test('integrasi API (dilewati: TEST_DATABASE_URL belum diisi)', { skip: true }, () => {}); return; }
process.env.DATABASE_URL = TEST_DB_URL;

const { db } = require('../lib/db');
const setup = require('../services/setup');
const ai = require('../services/ai');
const queue = require('../engine/queue');
const tools = require('../tools');
const { createServer } = require('../scripts/dev');
const auth = require('../security/auth');

let server, base;
function client() {
  const c = { cookie: '', csrf: '' };
  c.req = async (method, path, body, { csrf = true, headers = {} } = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (c.cookie) h.Cookie = c.cookie;
    if (csrf && c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
    const r = await fetch(base + '/api' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0];
    const json = await r.json().catch(() => null);
    if (json && json.csrf_token) c.csrf = json.csrf_token;
    return { status: r.status, body: json };
  };
  for (const m of ['get', 'post', 'patch', 'delete']) c[m] = (p, b, o) => c.req(m.toUpperCase(), p, b, o);
  return c;
}
const owner = client();
let ws1; const ids = {};

test.before(async () => {
  await db.query('drop schema public cascade'); await db.query('create schema public');
  const m = await setup.migrate(); assert.ok(m.ran.includes('001_init'));
  server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); await db.close(); });

test('health & status sebelum setup: publik, tanpa rahasia', async () => {
  const c = client();
  const h = await c.get('/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.database.connected, true);
  assert.equal(h.body.database.hasOwner, false);
  assert.ok(!JSON.stringify(h.body).includes(process.env.SESSION_SECRET));
  assert.equal((await c.get('/dashboard')).status, 401);
});

test('setup Owner: butuh kunci, kata sandi kuat, hanya sekali', async () => {
  const c = client();
  const body = { workspace_name: 'GERDEV', name: 'Gerdy Hendraman', email: 'owner@gerdev.test', password: 'Sandi12345!x' };
  assert.equal((await c.post('/setup/owner', { ...body, setup_key: 'salah' })).status, 403);
  assert.equal((await c.post('/setup/owner', { ...body, password: 'pendek1', setup_key: process.env.SESSION_SECRET })).status, 400);
  const ok = await owner.post('/setup/owner', { ...body, setup_key: process.env.SESSION_SECRET });
  assert.equal(ok.status, 201); assert.equal(ok.body.user.role, 'owner'); assert.ok(owner.cookie.startsWith('gw_session='));
  assert.equal((await c.post('/setup/owner', { ...body, setup_key: process.env.SESSION_SECRET })).status, 409);
  const me = await owner.get('/auth/me');
  assert.equal(me.body.user.email, 'owner@gerdev.test'); ws1 = me.body.workspace.id;
});

test('login/logout, CSRF, dan kredensial salah', async () => {
  const c = client();
  assert.equal((await c.post('/auth/login', { email: 'owner@gerdev.test', password: 'salah-salah1' })).status, 401);
  const ok = await c.post('/auth/login', { email: 'OWNER@gerdev.test', password: 'Sandi12345!x' });
  assert.equal(ok.status, 200);
  assert.equal((await c.post('/agents/recruit', { template_key: 'ceo' }, { csrf: false })).status, 403, 'tanpa CSRF harus ditolak');
  assert.equal((await c.post('/auth/logout', {})).status, 200);
  assert.equal((await c.get('/auth/me')).status, 401, 'sesi harus mati setelah logout');
});

test('seed awal: 12 karyawan AI, 4 unit bisnis, tools, tanpa data palsu', async () => {
  const a = await owner.get('/agents'); assert.equal(a.body.items.length, 12);
  const keys = a.body.items.map((x) => x.role_key).sort();
  for (const k of ['ceo', 'ops_manager', 'researcher', 'sales_manager', 'qa']) assert.ok(keys.includes(k), k);
  assert.equal(new Set(a.body.items.map((x) => x.system_prompt)).size, 12, 'system prompt harus berbeda');
  ids.ceo = a.body.items.find((x) => x.role_key === 'ceo').id;
  const u = await owner.get('/business-units'); assert.equal(u.body.items.length, 4);
  ids.unit = u.body.items.find((x) => x.code === 'agency').id;
  const t = await owner.get('/tools'); assert.ok(t.body.items.length >= 12);
  const d = (await owner.get('/dashboard')).body;
  assert.equal(d.agents.total, 12); assert.equal(d.agents.active, 12);
  assert.equal(d.finance.revenue, 0); assert.equal(d.customers.total, 0); assert.equal(d.orders.total, 0); assert.equal(d.leads.total, 0);
  assert.equal(d.series.length, 14);
});

test('CRUD karyawan AI: tambah, edit, validasi, nonaktifkan, evaluasi, rekrut template', async () => {
  const bad = await owner.post('/agents', { name: 'X' });
  assert.equal(bad.status, 400); assert.ok(bad.body.errors.title);
  const bad2 = await owner.post('/agents', { name: 'Tester', title: 'QA Tambahan', system_prompt: 'Anda adalah tester yang teliti dan jujur.', tools: ['tool_palsu'] });
  assert.equal(bad2.status, 400);
  const ok = await owner.post('/agents', { name: 'AI Tester', title: 'Tester', department: 'Operasional', system_prompt: 'Anda adalah tester yang teliti dan jujur.', skills: ['uji', 'qa'], tools: ['calculator', 'db_query'], max_tokens_per_run: 1500 });
  assert.equal(ok.status, 201); ids.tester = ok.body.id; assert.deepEqual(ok.body.tools, ['calculator', 'db_query']);
  assert.equal((await owner.post('/agents', { name: 'AI Tester', title: 'Dup', system_prompt: 'Anda adalah tester yang teliti dan jujur.' })).status, 409);
  const up = await owner.patch('/agents/' + ids.tester, { title: 'Senior Tester', status: 'inactive' });
  assert.equal(up.body.title, 'Senior Tester'); assert.equal(up.body.status, 'inactive');
  const ev = await owner.post(`/agents/${ids.tester}/evaluate`, {}); assert.equal(ev.body.score, null); assert.equal(ev.body.rating, 'Belum cukup data');
  const ov = await owner.get(`/agents/${ids.tester}/overview`); assert.equal(ov.body.stats.runs.runs, 0);
  const rec = await owner.post('/agents/recruit', { template_key: 'sales_agent', name: 'AI Sales Agent' });
  assert.equal(rec.status, 201); assert.equal(rec.body.name, 'AI Sales Agent 2');
  assert.equal((await owner.delete('/agents/' + rec.body.id)).status, 200);
});

test('alur Owner → CEO → Manager → Worker → QA → Owner (AI diganti skrip tetap)', async () => {
  const researcher = (await owner.get('/agents?role_key=researcher')).body.items[0];
  const calls = [];
  const origChat = ai.chatJSON;
  const reply = (obj) => ({ parsed: obj, raw: JSON.stringify(obj), model: 'gpt-4o-mini', provider: 'openai', promptTokens: 100, completionTokens: 50, cost: { usd: 0.0001, estimated: true } });
  ai.chatJSON = async ({ messages }) => {
    const sys = messages[0].content; const ctx = JSON.parse(messages[messages.length - 1].content.startsWith('{"hasil_tool"') ? messages[1].content : messages[messages.length - 1].content.startsWith('{"error"') ? messages[1].content : messages[1].content);
    calls.push(sys.slice(0, 60));
    const who = /Anda (AI [A-Za-z\/ ]+?) GERDEV|Anda adalah (AI [A-Za-z\/ ]+?) /.exec(sys); void who;
    const phase = ctx.tugas.jenis === 'qa' ? 'qa' : (ctx.children ? 'synthesize' : 'work');
    if (phase === 'qa') return reply({ action: 'final', summary: 'Hasil sesuai tugas', output: 'QA lolos', verdict: 'pass', issues: [] });
    if (phase === 'synthesize') return reply({ action: 'final', summary: 'Ringkasan akhir target', output: 'Laporan akhir: semua subtugas selesai.' });
    if (ctx.tugas.jenis === 'goal' && ctx.karyawan_tersedia) {
      return reply({ action: 'delegate', summary: 'Membagi pekerjaan', subtasks: [
        { title: 'Hitung estimasi harga', description: 'Hitung 3 x 1500000 memakai calculator', assignee: researcher.name, priority: 5 },
        { title: 'Susun ringkasan', description: 'Ringkas hasil perhitungan', assignee: 'ops_manager', depends_on: [0], priority: 4 }] });
    }
    if (!ctx.hasil_dependensi && /Hitung estimasi/.test(ctx.tugas.judul) && !messages.some((m) => m.content.includes('hasil_tool'))) {
      return reply({ action: 'tool', tool: 'calculator', input: { expression: '3*1500000' } });
    }
    return reply({ action: 'final', summary: 'Selesai: ' + ctx.tugas.judul, output: 'Output untuk ' + ctx.tugas.judul, memory: ['Estimasi 3 paket = 4.500.000'] });
  };
  try {
    // peran researcher perlu tool calculator untuk uji tool-call: tambahkan lewat API
    await owner.patch('/agents/' + researcher.id, { tools: [...researcher.tools, 'calculator'] });
    const g = await owner.post('/tasks', { title: 'Targetkan estimasi paket website', description: 'Siapkan estimasi harga 3 paket', business_unit_id: ids.unit });
    assert.equal(g.status, 201); ids.goal = g.body.id;
    let guard = 0;
    while (guard++ < 12) {
      const r = await queue.tick(db, { workspaceId: ws1, budgetMs: 120000, maxTasks: 5 });
      if (!r.processed.length) break;
    }
    const det = (await owner.get('/tasks/' + ids.goal)).body;
    assert.equal(det.task.status, 'review', 'target akar menunggu tinjauan Owner; status=' + det.task.status + ' err=' + det.task.error);
    assert.equal(det.task.qa_status, 'pass');
    assert.equal(det.children.length, 2); assert.ok(det.children.every((c) => c.status === 'done'), JSON.stringify(det.children.map((c) => [c.title, c.status, c.error])));
    assert.ok(det.runs.length >= 5, 'riwayat eksekusi tercatat: ' + det.runs.length);
    const toolLog = (await owner.get('/tool-logs?tool=calculator')).body.items;
    assert.equal(toolLog.length, 1); assert.equal(toolLog[0].output.result, 4500000);
    // dependensi: subtugas ke-2 menunggu yang ke-1
    const deps = await db.query('select count(*)::int n from task_dependencies');
    assert.equal(deps[0].n, 1);
    const usage = (await owner.get('/usage')).body; assert.ok(usage.totals.calls >= 5); assert.ok(usage.totals.cost_usd > 0);
    const msgs = (await owner.get('/messages?task_id=' + ids.goal)).body.items; assert.ok(msgs.length >= 1);
    const accept = await owner.post(`/tasks/${ids.goal}/accept`, {}); assert.equal(accept.status, 200);
    assert.equal((await owner.get('/tasks/' + ids.goal)).body.task.status, 'done');
    const mem = (await owner.get('/memories?q=estimasi paket')).body.items; assert.ok(mem.length >= 1, 'memori ditemukan lewat pencarian relevansi');
    const d = (await owner.get('/dashboard')).body; assert.ok(d.tasks.done >= 3); assert.ok(d.activity.length > 0);
    const ev = (await owner.post(`/agents/${researcher.id}/evaluate`, {})).body; assert.ok(ev.basis >= 1, 'evaluasi memakai data nyata'); assert.ok(ev.score === null ? ev.rating === 'Belum cukup data' : ev.score > 0);
  } finally { ai.chatJSON = origChat; }
});

test('tanpa API AI: tugas berstatus blocked (NOT CONNECTED), tidak ada hasil palsu', async () => {
  const t = await owner.post('/tasks', { title: 'Tugas tanpa API', agent_id: (await owner.get('/agents?role_key=researcher')).body.items[0].id });
  const r = await queue.tick(db, { workspaceId: ws1, budgetMs: 120000, maxTasks: 3 });
  assert.equal(r.processed[0].outcome, 'blocked');
  const det = (await owner.get('/tasks/' + t.body.id)).body.task;
  assert.equal(det.status, 'blocked'); assert.match(det.error, /NOT CONNECTED/);
  assert.equal(det.result, null);
  const retry = await owner.post(`/tasks/${t.body.id}/retry`, {}); assert.equal(retry.status, 200);
  await owner.post(`/tasks/${t.body.id}/cancel`, {});
  assert.equal((await owner.get('/tasks/' + t.body.id)).body.task.status, 'cancelled');
});

test('CRM: prospek, duplikat, riwayat komunikasi, konversi, pesan lewat persetujuan', async () => {
  const l = await owner.post('/leads', { business_name: 'Warung Bu Siti', category: 'Kuliner', whatsapp: '0812-3456-7890', source: 'manual', business_unit_id: ids.unit });
  assert.equal(l.status, 201); assert.equal(l.body.whatsapp, '6281234567890'); ids.lead = l.body.id;
  const dup = await owner.post('/leads', { business_name: 'Nama Lain', whatsapp: '081234567890' });
  assert.equal(dup.status, 409);
  assert.equal((await owner.post(`/leads/${ids.lead}/communications`, { content: 'Telepon pertama, minta dikirim penawaran' })).status, 201);
  const det = (await owner.get(`/leads/${ids.lead}/detail`)).body; assert.equal(det.communications.length, 1);
  const rq = await owner.post(`/leads/${ids.lead}/request-message`, { channel: 'whatsapp', text: 'Halo Bu Siti, kami dari GERDEV...' });
  assert.equal(rq.status, 201);
  const conv = await owner.post(`/leads/${ids.lead}/convert`, {}); assert.equal(conv.status, 201); ids.customer = conv.body.id;
  assert.equal((await owner.post(`/leads/${ids.lead}/convert`, {})).status, 409);
  assert.equal((await owner.get('/leads/' + ids.lead)).body.status, 'menang');
  assert.equal((await owner.get('/dashboard')).body.customers.total, 1);
  ids.approvalMsg = rq.body.approval_id;
});

test('Approval Center: approve mencatat keputusan; kirim tanpa provider = tidak dipalsukan', async () => {
  const list = (await owner.get('/approvals?status=open')).body.items; assert.equal(list.length, 1);
  const rv = await owner.post(`/approvals/${ids.approvalMsg}/decide`, { decision: 'review', note: 'cek teks' }); assert.equal(rv.body.status, 'review');
  const ap = await owner.post(`/approvals/${ids.approvalMsg}/decide`, { decision: 'approve' });
  assert.equal(ap.body.status, 'approved'); assert.equal(ap.body.execution_result.executed, false); assert.match(ap.body.execution_result.note, /NOT CONNECTED/);
  assert.equal((await owner.post(`/approvals/${ids.approvalMsg}/decide`, { decision: 'reject' })).status, 409, 'tidak bisa diputuskan dua kali');
  const comm = await db.query("select status from communications where lead_id=$1 and direction='out'", [ids.lead]);
  assert.match(comm[0].status, /gagal/);
  const audit = (await owner.get('/audit?action=approval')).body.items; assert.ok(audit.length >= 2);
});

test('tool AI: izin agen, validasi, save_lead tanpa bukti membuang WhatsApp, request_approval', async () => {
  const agent = await db.one("select * from agents where workspace_id=$1 and role_key='researcher'", [ws1]);
  const c = { db, workspaceId: ws1, agent };
  const denied = await tools.runTool({ ...c, agent: { ...agent, tools: [] } }, 'calculator', { expression: '1+1' });
  assert.match(denied.error, /tidak diizinkan/);
  assert.match((await tools.runTool(c, 'calculator', { expression: 'process.exit(1)' })).error, /tidak valid|Karakter|Ekspresi/);
  assert.match((await tools.runTool(c, 'save_lead', { business_name: 'X' })).error, /wajib/);
  const nr = await tools.runTool(c, 'web_search', { query: 'toko roti cirebon' });
  assert.match(nr.error, /NOT CONNECTED/);
  const ok = await tools.runTool(c, 'save_lead', { business_name: 'Toko Roti Sari', category: 'Kuliner', whatsapp: '081299998888', address: 'Jl. Karangan 99 Cirebon', source_url: 'https://www.instagram.com/rotisari', evidence: 'Profil Instagram Toko Roti Sari, Cirebon. Pesan lewat DM.' });
  assert.equal(ok.duplicate, false); assert.deepEqual(ok.dropped_fields.sort(), ['address', 'whatsapp']);
  const row = await db.one("select whatsapp, address, has_website, source_url from leads where id=$1", [ok.lead_id]);
  assert.equal(row.whatsapp, null); assert.equal(row.address, null); assert.equal(row.has_website, false);
  const dup = await tools.runTool(c, 'save_lead', { business_name: 'Toko Roti Sari', source_url: 'https://www.instagram.com/rotisari', evidence: 'Profil Instagram Toko Roti Sari, Cirebon.' });
  assert.equal(dup.duplicate, true);
  const ra = await tools.runTool({ ...c, agent: { ...agent, tools: [...agent.tools, 'request_approval'] } }, 'request_approval', { action_type: 'deploy_website', title: 'Deploy website Toko Roti' });
  assert.equal(ra.status, 'pending');
});

test('Penjualan & keuangan: produk, pesanan, pembayaran → transaksi nyata → dashboard', async () => {
  const p = await owner.post('/products', { name: 'Website UMKM', type: 'jasa', price: 1500000, cost: 200000, business_unit_id: ids.unit }); assert.equal(p.status, 201); ids.product = p.body.id;
  assert.equal((await owner.post('/products', { name: 'Minus', price: -5 })).status, 400);
  const o = await owner.post('/orders', { customer_id: ids.customer, business_unit_id: ids.unit, items: [{ product_id: ids.product, qty: 2 }, { name: 'Domain .com', qty: 1, price: 150000 }] });
  assert.equal(o.status, 201); assert.equal(Number(o.body.total), 3150000); ids.order = o.body.id;
  assert.equal((await owner.get('/finance/summary')).body.income, 0, 'pesanan belum dibayar = belum omzet');
  const over = await owner.post(`/orders/${ids.order}/payments`, { amount: 9999999 }); assert.equal(over.status, 400);
  const pay1 = await owner.post(`/orders/${ids.order}/payments`, { amount: 1000000 }); assert.equal(pay1.body.payment_status, 'partial');
  const inv = await owner.post(`/orders/${ids.order}/invoice`, {}); assert.equal(inv.status, 201, JSON.stringify(inv.body)); assert.equal(inv.body.total, 3150000);
  const ri = await owner.post(`/invoices/${inv.body.invoice_id}/request-issue`, {}); assert.equal(ri.status, 201);
  assert.equal((await owner.post(`/invoices/${inv.body.invoice_id}/request-issue`, {})).status, 409);
  await owner.post(`/approvals/${ri.body.approval_id}/decide`, { decision: 'approve' });
  assert.equal((await owner.get('/invoices/' + inv.body.invoice_id)).body.invoice.status, 'issued');
  const pay2 = await owner.post(`/orders/${ids.order}/payments`, { amount: 2150000 }); assert.equal(pay2.body.payment_status, 'paid');
  assert.equal((await owner.get('/invoices/' + inv.body.invoice_id)).body.invoice.status, 'paid');
  const exp = await owner.post('/transactions', { type: 'expense', category: 'operasional', amount: 250000, description: 'Domain & hosting' }); assert.equal(exp.status, 201);
  const sum = (await owner.get('/finance/summary')).body;
  assert.equal(sum.income, 3150000); assert.equal(sum.expense, 250000);
  const d = (await owner.get('/dashboard')).body;
  assert.equal(d.finance.revenue, 3150000); assert.equal(d.finance.expense, 250000); assert.ok(d.finance.api_cost_usd > 0);
  assert.equal(d.finance.api_cost_idr, null, 'biaya API tidak dikonversi bila kurs belum diisi');
  const set = await owner.patch('/settings', { usd_idr_rate: 16000 }); assert.equal(set.status, 200);
  const d2 = (await owner.get('/dashboard')).body; assert.ok(d2.finance.api_cost_idr > 0);
  assert.ok(Math.abs(d2.finance.net - (3150000 - 250000 - d2.finance.api_cost_idr)) < 0.01);
  const ser = (await owner.get('/finance/series?period=day')).body; assert.equal(ser.items.length, 30); assert.equal(ser.items.at(-1).income, 3150000);
  const wk = (await owner.get('/finance/series?period=week')).body; assert.equal(wk.items.length, 12);
  const mo = (await owner.get('/finance/series?period=month')).body; assert.equal(mo.items.length, 12);
  const bu = (await owner.get('/finance/by-unit')).body.items.find((x) => x.code === 'agency'); assert.equal(bu.income, 3150000);
  const rep = await owner.post('/finance/report', { period: 'week' }); assert.equal(rep.status, 201); assert.match(rep.body.markdown, /Pemasukan: Rp 3\.150\.000/);
  assert.equal((await owner.delete('/transactions/' + (await owner.get('/transactions?source=order_payment')).body.items[0].id)).status, 409, 'transaksi pembayaran tidak boleh dihapus langsung');
  const rf = await owner.post(`/orders/${ids.order}/refund`, { amount: 150000, note: 'Domain batal' }); assert.equal(rf.body.payment_status, 'partial');
  assert.equal((await owner.get('/finance/summary')).body.expense, 400000);
});

test('penawaran: draft → persetujuan kirim → konversi ke pesanan', async () => {
  const q = await owner.post('/quotations', { customer_id: ids.customer, business_unit_code: 'agency', items: [{ product_id: ids.product, qty: 1 }] });
  assert.equal(q.status, 201); assert.equal(q.body.total, 1500000);
  const rq = await owner.post(`/quotations/${q.body.quotation_id}/request-send`, { channel: 'whatsapp', text: 'Berikut penawaran Anda' });
  assert.equal(rq.status, 201);
  const rej = await owner.post(`/approvals/${rq.body.approval_id}/decide`, { decision: 'reject', note: 'revisi dulu' }); assert.equal(rej.body.status, 'rejected');
  assert.equal((await owner.get('/quotations')).body.items[0].status, 'draft', 'ditolak → kembali draft');
  const cv = await owner.post(`/quotations/${q.body.quotation_id}/convert`, {}); assert.equal(cv.status, 201);
});

test('Otomasi: jadwal membuat tugas tanpa ganda; monitor', async () => {
  const sch = await owner.post('/schedules', { name: 'Laporan harian', title: 'Susun laporan harian', agent_id: ids.ceo, frequency: 'daily' });
  assert.equal(sch.status, 201);
  assert.equal((await owner.post('/schedules', { name: 'x', title: 'xxx', agent_id: ids.ceo, frequency: 'minutes' })).status, 400);
  const [a, b] = await Promise.all([queue.tick(db, { workspaceId: ws1, budgetMs: 20000, maxTasks: 0 }), queue.tick(db, { workspaceId: ws1, budgetMs: 20000, maxTasks: 0 })]);
  assert.equal(a.schedulesCreated + b.schedulesCreated, 1, 'dua worker bersamaan hanya membuat satu tugas');
  const mon = (await owner.get('/automation/monitor')).body; assert.ok(mon.queue.queued >= 1);
  const list = (await owner.get('/schedules')).body.items; assert.equal(list[0].run_count, 1); assert.ok(new Date(list[0].next_run_at) > new Date());
});

test('Integrasi: status NOT CONNECTED jujur, toggle, tes koneksi, batas penggunaan', async () => {
  const it = (await owner.get('/integrations')).body.items;
  assert.equal(it.length, 7);
  assert.equal(it.find((x) => x.kind === 'openai').status, 'NOT CONNECTED');
  assert.equal(it.find((x) => x.kind === 'database').status, 'CONFIGURED');
  assert.ok(!JSON.stringify(it).includes(TEST_DB_URL), 'nilai env tidak boleh dikirim ke browser');
  const t = (await owner.post('/integrations/openai/test', {})).body; assert.equal(t.ok, false); assert.match(t.error, /NOT CONNECTED/);
  assert.equal((await owner.patch('/integrations/web_search', { enabled: false, settings: { daily_call_limit: 5 } })).status, 200);
  assert.equal((await owner.get('/integrations')).body.items.find((x) => x.kind === 'web_search').enabled, false);
  const dt = (await owner.post('/integrations/database/test', {})).body; assert.equal(dt.ok, true);
});

test('RBAC & isolasi workspace', async () => {
  const w2 = await db.one("insert into workspaces (name, slug) values ('Lain','lain') returning id");
  await db.exec("insert into users (workspace_id, email, name, password_hash, role) values ($1,'viewer@gerdev.test','V',$2,'viewer')", [ws1, auth.hashPassword('Viewer12345!')]);
  await db.exec("insert into users (workspace_id, email, name, password_hash, role) values ($1,'other@lain.test','O',$2,'owner')", [w2.id, auth.hashPassword('Other12345!')]);
  await db.tx((t) => setup.seedWorkspace(t, w2.id));
  const v = client(); assert.equal((await v.post('/auth/login', { email: 'viewer@gerdev.test', password: 'Viewer12345!' })).status, 200);
  assert.equal((await v.get('/agents')).status, 200);
  assert.equal((await v.post('/tasks', { title: 'abc' })).status, 403);
  assert.equal((await v.post('/leads', { business_name: 'zz' })).status, 403);
  assert.equal((await v.get('/users')).status, 403);
  const o2 = client(); assert.equal((await o2.post('/auth/login', { email: 'other@lain.test', password: 'Other12345!' })).status, 200);
  const a2 = (await o2.get('/agents')).body.items; assert.equal(a2.length, 12);
  assert.ok(!a2.some((x) => x.id === ids.ceo), 'agen workspace lain tidak terlihat');
  assert.equal((await o2.get('/tasks/' + ids.goal)).status, 404);
  assert.equal((await o2.get('/customers/' + ids.customer)).status, 404);
  assert.equal((await o2.get('/orders/' + ids.order)).status, 404);
  assert.equal((await o2.get('/leads')).body.items.length, 0);
  assert.equal((await o2.post('/tasks', { title: 'lintas workspace', agent_id: ids.ceo })).status, 404);
  assert.equal((await o2.post('/agents', { name: 'Lintas', title: 'x', system_prompt: 'Anda adalah agen lintas workspace.', reports_to: ids.ceo })).status, 400, 'referensi lintas workspace ditolak');
  assert.equal((await o2.patch('/agents/' + ids.ceo, { title: 'dibajak' })).status, 404);
  assert.equal((await o2.delete('/products/' + ids.product)).status, 404);
  assert.equal((await o2.post(`/orders/${ids.order}/payments`, { amount: 1 })).status, 404);
  assert.equal((await o2.post(`/approvals/${ids.approvalMsg}/decide`, { decision: 'approve' })).status, 409);
  assert.equal((await o2.get('/dashboard')).body.finance.revenue, 0);
});

test('rate limit login & validasi body', async () => {
  const c = client(); let last;
  for (let i = 0; i < 10; i++) last = await c.post('/auth/login', { email: 'brute@gerdev.test', password: 'salahsalah1' });
  assert.equal(last.status, 429);
  assert.equal((await owner.post('/leads', 'bukan-json-objek')).status, 400);
  assert.equal((await owner.get('/endpoint-tidak-ada')).status, 404);
});
