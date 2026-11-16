'use strict';
/* Halaman 9 Business Units, 10 CRM. */
const unitOpts = async (blank = '— tidak ada —') => { const u = await G.api.get('/business-units'); return { raw: u.items, opts: [['', blank], ...u.items.map((x) => [x.id, x.name])] }; };
G.unitOpts = unitOpts;

/* ---------- Unit bisnis ---------- */
G.route('/units', {
  id: 'units', title: 'Unit Bisnis',
  async render(view, p, alive) {
    const r = await G.api.get('/business-units'); if (!alive()) return;
    const form = (u) => G.formModal({ title: u ? 'Ubah unit bisnis' : 'Unit bisnis baru', values: u || { active: true }, submitLabel: 'Simpan',
      fields: [{ name: 'code', label: 'Kode (huruf kecil, angka, - _)', required: true }, { name: 'name', label: 'Nama', required: true }, { name: 'description', label: 'Deskripsi', type: 'textarea', rows: 2 }, { name: 'services', label: 'Layanan / produk utama', type: 'tags', full: true }, { name: 'active', label: 'Aktif', type: 'checkbox' }],
      onSubmit: async (v) => { if (u) await G.api.patch('/business-units/' + u.id, v); else await G.api.post('/business-units', v); G.toast('Unit bisnis disimpan'); G.render(); } });
    view.innerHTML = html`${G.pagehead('Unit Bisnis', 'Setiap unit punya pelanggan, produk, pesanan, transaksi, dan laporan sendiri.', html`<button class="btn pri" data-act="add" ${G.can('admin') ? '' : raw('disabled')}>＋ Unit bisnis</button>`)}
      <div class="grid g2">${r.items.map((u) => html`<div class="card"><h3>${u.name} ${G.badge(u.active ? 'active' : 'inactive')} <span class="sp"></span><span class="mono mute">${u.code}</span></h3>
        <div class="small mute">${u.description || ''}</div><div class="tags" style="margin:8px 0">${(u.services || []).map((s) => html`<span>${s}</span>`)}</div>
        <div class="grid g4 keep2" style="gap:8px;margin:10px 0"><div><div class="mute small">Prospek</div><b>${u.leads}</b></div><div><div class="mute small">Pelanggan</div><b>${u.customers}</b></div><div><div class="mute small">Produk</div><b>${u.products}</b></div><div><div class="mute small">Pesanan</div><b>${u.orders}</b></div></div>
        <div class="row sb small"><span>Omzet <b class="em">${G.fmt.idr(u.income)}</b></span><span>Biaya <b>${G.fmt.idr(u.expense)}</b></span><span>Laba <b class="${u.income - u.expense < 0 ? 'err' : 'em'}">${G.fmt.idr(u.income - u.expense)}</b></span></div>
        <div class="small mute" style="margin-top:6px">${u.active_tasks} tugas aktif</div>
        <div class="row" style="margin-top:10px"><button class="btn sm pri" data-act="detail" data-id="${u.id}">Lihat detail</button><button class="btn sm" data-act="task" data-id="${u.id}" ${G.can('manager') ? '' : raw('disabled')}>Beri target</button><button class="btn sm" data-act="edit" data-id="${u.id}" ${G.can('admin') ? '' : raw('disabled')}>Ubah</button>
        <button class="btn sm danger" data-act="del" data-id="${u.id}" ${G.can('owner') ? '' : raw('disabled')}>Hapus</button></div></div>`)}</div>`.s;
    G.bind(view, {
      add: () => form(null), edit: (d) => form(r.items.find((x) => x.id === d.id)),
      del: async (d) => { if (await G.confirm('Hapus unit bisnis ini? Hanya bisa jika tidak punya data terkait.', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/business-units/' + d.id); G.toast('Unit dihapus'); G.render(); } },
      task: async (d) => { const u = r.items.find((x) => x.id === d.id); const ag = await G.api.get('/agents?status=active'); G.formModal({ title: 'Target untuk ' + u.name, submitLabel: 'Kirim target', intro: 'Dikirim ke AI CEO untuk dibagi ke tim.', values: { priority: 5 }, fields: [{ name: 'title', label: 'Judul target', required: true, full: true }, { name: 'description', label: 'Rincian', type: 'textarea' }, { name: 'priority', label: 'Prioritas (1-10)', type: 'number', min: 1 }], onSubmit: async (v) => { const t = await G.api.post('/tasks', { ...v, business_unit_id: u.id }); G.toast('Target dikirim'); G.go('/tasks/' + t.id); } }); },
      detail: async (d) => {
        const x = await G.api.get('/business-units/' + d.id);
        G.modal({ title: x.unit.name, wide: true, body: html`<div class="grid split">
          <div class="card"><h3>Produk (${x.products.length})</h3>${G.table([{ h: 'Nama', f: (q) => q.name }, { h: 'Jenis', f: (q) => q.type }, { h: 'Harga', num: true, f: (q) => G.fmt.idr(q.price) }], x.products, { empty: 'Belum ada produk' })}</div>
          <div class="card"><h3>Pesanan terbaru</h3>${G.table([{ h: 'No', f: (q) => html`<a href="#/orders/${q.id}">${q.order_no}</a>` }, { h: 'Status', f: (q) => G.badge(q.status) }, { h: 'Bayar', f: (q) => G.badge(q.payment_status) }, { h: 'Total', num: true, f: (q) => G.fmt.idr(q.total) }], x.orders, { empty: 'Belum ada pesanan' })}</div>
          <div class="card"><h3>Pelanggan</h3>${G.table([{ h: 'Nama', f: (q) => q.name }, { h: 'Bisnis', f: (q) => q.business_name || '-' }, { h: 'WhatsApp', f: (q) => q.whatsapp || '-' }], x.customers, { empty: 'Belum ada pelanggan' })}</div>
          <div class="card"><h3>Transaksi</h3>${G.table([{ h: 'Tanggal', f: (q) => G.fmt.date(q.occurred_at) }, { h: 'Jenis', f: (q) => G.badge(q.type) }, { h: 'Keterangan', f: (q) => q.description || q.category }, { h: 'Jumlah', num: true, f: (q) => G.fmt.idr(q.amount) }], x.transactions, { empty: 'Belum ada transaksi' })}</div></div>` });
      }
    });
  }
});

/* ---------- CRM ---------- */
const LEAD_STATUS = ['baru', 'dihubungi', 'tertarik', 'penawaran', 'negosiasi', 'menang', 'kalah', 'tidak_cocok'];
const leadFields = (units) => [
  { name: 'business_name', label: 'Nama bisnis', required: true }, { name: 'contact_name', label: 'Nama kontak' }, { name: 'category', label: 'Kategori bisnis' }, { name: 'whatsapp', label: 'Nomor WhatsApp', placeholder: '0812xxxxxxx', help: 'Isi hanya jika benar-benar ditemukan. Jangan menebak.' },
  { name: 'address', label: 'Alamat', full: true }, { name: 'website', label: 'Website (https://…)', type: 'url' }, { name: 'has_website', label: 'Sudah punya website', type: 'checkbox' },
  { name: 'source', label: 'Sumber prospek' }, { name: 'source_url', label: 'URL sumber', type: 'url' }, { name: 'evidence', label: 'Bukti / kutipan dari sumber', type: 'textarea', rows: 2 },
  { name: 'status', label: 'Status', type: 'select', options: LEAD_STATUS.map((s) => [s, G.stLabel(s)]) }, { name: 'potential_value', label: 'Potensi penjualan (Rp)', type: 'number', min: 0 }, { name: 'priority', label: 'Prioritas (1-10)', type: 'number', min: 1 },
  { name: 'business_unit_id', label: 'Unit bisnis', type: 'select', options: units }, { name: 'verified', label: 'Informasi sudah diverifikasi', type: 'checkbox' }, { name: 'notes', label: 'Catatan', type: 'textarea', rows: 2 }];
const customerFields = (units) => [
  { name: 'name', label: 'Nama pelanggan', required: true }, { name: 'business_name', label: 'Nama bisnis' }, { name: 'category', label: 'Kategori bisnis' }, { name: 'whatsapp', label: 'Nomor WhatsApp' }, { name: 'email', label: 'Email', type: 'email' },
  { name: 'website', label: 'Website', type: 'url' }, { name: 'address', label: 'Alamat', full: true }, { name: 'business_unit_id', label: 'Unit bisnis', type: 'select', options: units }, { name: 'notes', label: 'Catatan', type: 'textarea', rows: 2 }];
const clean = (v) => { const o = { ...v }; for (const k of Object.keys(o)) if (o[k] === '' || o[k] === null) o[k] = ''; return o; };

G.route('/crm', {
  id: 'crm', title: 'CRM',
  async render(view, p, alive) {
    const U = await unitOpts(); if (!alive()) return;
    let tab = 'leads'; const f = { q: '', status: '', unit: '' };
    const draw = async () => {
      view.innerHTML = html`${G.pagehead('CRM — Prospek & Pelanggan', 'Semua data dari input Anda atau hasil riset AI dengan sumber. Nomor WhatsApp/alamat tidak pernah dikarang.', html`${tab === 'leads' ? html`<button class="btn" data-act="research" ${G.can('manager') ? '' : raw('disabled')}>🔎 Riset prospek dengan AI</button>` : ''}<button class="btn pri" data-act="add" ${G.can('manager') ? '' : raw('disabled')}>＋ ${tab === 'leads' ? 'Prospek' : 'Pelanggan'}</button>`)}
        <div class="tabs"><button class="${tab === 'leads' ? 'on' : ''}" data-act="tab" data-k="leads">Prospek</button><button class="${tab === 'customers' ? 'on' : ''}" data-act="tab" data-k="customers">Pelanggan</button></div>
        <div class="toolbar"><input id="fq" type="search" placeholder="Cari…" value="${f.q}">${tab === 'leads' ? html`<select id="fs"><option value="">Semua status</option>${LEAD_STATUS.map((s) => html`<option value="${s}" ${f.status === s ? raw('selected') : ''}>${G.stLabel(s)}</option>`)}</select>` : ''}
          <select id="fu"><option value="">Semua unit</option>${U.raw.map((u) => html`<option value="${u.id}" ${f.unit === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select></div><div id="crmbody" class="card"><div class="empty">Memuat…</div></div>`.s;
      const box = view.querySelector('#crmbody');
      view.querySelector('#fq').onchange = (e) => { f.q = e.target.value; draw(); };
      const fs = view.querySelector('#fs'); if (fs) fs.onchange = (e) => { f.status = e.target.value; draw(); };
      view.querySelector('#fu').onchange = (e) => { f.unit = e.target.value; draw(); };
      if (tab === 'leads') {
        const r = await G.api.get('/leads' + G.qs({ q: f.q, status: f.status, business_unit_id: f.unit })); if (!alive()) return; view._rows = r.items;
        box.innerHTML = G.table([{ h: 'Bisnis', f: (l) => html`<a href="#" data-act="lead" data-id="${l.id}"><b>${l.business_name}</b></a><div class="small mute">${l.category || ''} ${l.contact_name ? '· ' + l.contact_name : ''}</div>` },
          { h: 'WhatsApp', f: (l) => l.whatsapp || html`<span class="mute">—</span>` }, { h: 'Website', f: (l) => (l.website ? html`<a href="${l.website}" target="_blank" rel="noopener noreferrer">buka</a>` : l.has_website === false ? html`<span class="badge warn">belum punya</span>` : html`<span class="mute">?</span>`) },
          { h: 'Status', f: (l) => html`${G.badge(l.status)} ${l.verified ? html`<span class="badge ok" title="Terverifikasi">✓</span>` : ''}` }, { h: 'Potensi', num: true, f: (l) => (l.potential_value ? G.fmt.idr(l.potential_value) : '-') }, { h: 'Prio', num: true, f: (l) => l.priority },
          { h: 'Sumber', f: (l) => (l.source_url ? html`<a href="${l.source_url}" target="_blank" rel="noopener noreferrer">${l.source || 'sumber'}</a>` : l.source || '-') }], r.items, { empty: 'Belum ada prospek. Tambahkan manual atau perintahkan AI Business Researcher.' }).s;
      } else {
        const r = await G.api.get('/customers' + G.qs({ q: f.q, business_unit_id: f.unit })); if (!alive()) return; view._rows = r.items;
        box.innerHTML = G.table([{ h: 'Pelanggan', f: (c) => html`<a href="#" data-act="cust" data-id="${c.id}"><b>${c.name}</b></a><div class="small mute">${c.business_name || ''}</div>` }, { h: 'Kategori', f: (c) => c.category || '-' }, { h: 'WhatsApp', f: (c) => c.whatsapp || '—' }, { h: 'Email', f: (c) => c.email || '—' }, { h: 'Sejak', f: (c) => G.fmt.date(c.created_at) }], r.items, { empty: 'Belum ada pelanggan. Konversi prospek yang menang, atau tambahkan manual.' }).s;
      }
    };
    await draw();
    const requestMsg = (kind, row) => G.formModal({ title: `Kirim pesan ke ${row.business_name || row.name}`, intro: 'Pesan TIDAK langsung terkirim — masuk Approval Center untuk Anda setujui.', submitLabel: 'Ajukan persetujuan',
      fields: [{ name: 'channel', label: 'Kanal', type: 'select', options: [['whatsapp', 'WhatsApp'], ['email', 'Email']] }, { name: 'to', label: 'Tujuan (kosong = data kontak tersimpan)', full: true }, { name: 'subject', label: 'Subjek (email)' }, { name: 'text', label: 'Isi pesan', type: 'textarea', required: true, rows: 5 }],
      onSubmit: async (v) => { await G.api.post(`/${kind}/${row.id}/request-message`, v); G.toast('Diajukan ke Approval Center'); G.refreshBadges(); } });
    const commForm = (kind, row, after) => G.formModal({ title: 'Catat riwayat komunikasi', fields: [{ name: 'channel', label: 'Kanal', placeholder: 'WhatsApp / telepon / bertemu' }, { name: 'direction', label: 'Arah', type: 'select', options: [['out', 'Keluar (kita → mereka)'], ['in', 'Masuk'], ['internal', 'Catatan internal']] }, { name: 'content', label: 'Isi', type: 'textarea', required: true }], values: { direction: 'internal', channel: 'catatan' },
      onSubmit: async (v) => { await G.api.post(`/${kind}/${row.id}/communications`, v); G.toast('Dicatat'); after(); } });
    const commList = (c) => (c.length ? html`<div class="list">${c.map((x) => html`<div class="item"><div class="grow"><span class="badge">${x.channel}</span> <span class="badge ${x.direction === 'in' ? 'info' : ''}">${x.direction}</span> ${G.badge(x.status)} <span class="mute small">${G.fmt.dt(x.created_at)}</span><div style="white-space:pre-wrap">${x.content}</div></div></div>`)}</div>` : G.empty('Belum ada riwayat'));
    G.bind(view, {
      tab: (d) => { tab = d.k; draw(); },
      add: () => G.formModal({ title: tab === 'leads' ? 'Prospek baru' : 'Pelanggan baru', wide: true, fields: tab === 'leads' ? leadFields(U.opts) : customerFields(U.opts), values: tab === 'leads' ? { status: 'baru', priority: 5, source: 'manual' } : {},
        onSubmit: async (v) => { await G.api.post(tab === 'leads' ? '/leads' : '/customers', clean(v)); G.toast('Tersimpan'); draw(); } }),
      research: () => G.formModal({ title: 'Riset prospek dengan AI Business Researcher', intro: 'Butuh API AI dan Web Search tersambung. Jika belum, tugas berstatus Terblokir (jujur, tanpa data palsu). Hanya prospek dengan sumber nyata yang disimpan.', submitLabel: 'Perintahkan AI',
        fields: [{ name: 'category', label: 'Kategori bisnis', required: true, placeholder: 'mis. toko kue, barbershop' }, { name: 'location', label: 'Lokasi', required: true, placeholder: 'mis. Cirebon' }, { name: 'count', label: 'Jumlah maks (1-15)', type: 'number', min: 1 }, { name: 'business_unit_id', label: 'Unit bisnis', type: 'select', options: U.opts }, { name: 'only_no_website', label: 'Prioritaskan yang belum punya website', type: 'checkbox' }], values: { count: 5, only_no_website: true },
        onSubmit: async (v) => { const r = await G.api.post('/leads/research', v); G.toast(r.ai_connected && r.search_connected ? 'Riset dikirim. Klik ▶ Jalankan antrean.' : 'Tugas dibuat, tetapi API AI / Web Search belum tersambung — akan Terblokir.', r.ai_connected && r.search_connected ? '' : 'warn'); G.go('/tasks/' + r.task.id); } }),
      lead: async (d) => {
        const load = () => G.api.get(`/leads/${d.id}/detail`); let x = await load();
        const m = G.modal({ title: x.lead.business_name, wide: true, body: '' });
        const paint = () => { const l = x.lead; m.body.innerHTML = html`<div class="row" style="margin-bottom:10px">${G.badge(l.status)} ${l.verified ? html`<span class="badge ok">Terverifikasi</span>` : html`<span class="badge warn">Belum diverifikasi</span>`} ${x.customer ? html`<span class="badge vio">Sudah jadi pelanggan</span>` : ''}</div>
          <div class="grid split"><div class="card"><h3>Data</h3><div class="small"><div>Kategori: ${l.category || '-'}</div><div>Kontak: ${l.contact_name || '-'}</div><div>WhatsApp: ${l.whatsapp || '—'}</div><div>Alamat: ${l.address || '—'}</div><div>Website: ${l.website ? html`<a href="${l.website}" target="_blank" rel="noopener noreferrer">${l.website}</a>` : l.has_website === false ? 'belum punya (terdeteksi)' : '?'}</div>
          <div>Potensi: ${l.potential_value ? G.fmt.idr(l.potential_value) : '-'} · Prioritas ${l.priority}</div><div>Sumber: ${l.source_url ? html`<a href="${l.source_url}" target="_blank" rel="noopener noreferrer">${l.source}</a>` : l.source}${l.created_by_agent ? ' · oleh ' + l.created_by_agent : ''}</div></div>
          ${l.evidence ? html`<h4 style="margin:10px 0 4px">Bukti</h4><div class="pre">${l.evidence}</div>` : ''}${l.notes ? html`<h4 style="margin:10px 0 4px">Catatan</h4><div class="small" style="white-space:pre-wrap">${l.notes}</div>` : ''}</div>
          <div class="card"><h3>Penawaran (${x.quotations.length})</h3>${x.quotations.length ? html`<div class="list">${x.quotations.map((q) => html`<div class="item"><div class="grow">${q.number} · ${G.fmt.idr(q.total)}</div>${G.badge(q.status)}</div>`)}</div>` : html`<div class="mute small">Belum ada. Buat di halaman Pesanan → Penawaran.</div>`}</div></div>
          <div class="card" style="margin-top:12px"><h3>Riwayat komunikasi <span class="sp"></span><button class="btn sm" data-a="note" ${G.can('manager') ? '' : raw('disabled')}>＋ Catat</button></h3>${commList(x.communications)}</div>
          <div class="row" style="margin-top:12px"><button class="btn" data-a="msg" ${G.can('manager') ? '' : raw('disabled')}>✉ Ajukan kirim pesan</button><button class="btn" data-a="edit" ${G.can('manager') ? '' : raw('disabled')}>Edit</button>
          <button class="btn pri" data-a="convert" ${G.can('manager') && !x.customer ? '' : raw('disabled')}>Jadikan pelanggan</button><button class="btn danger" data-a="del" ${G.can('admin') ? '' : raw('disabled')}>Hapus</button></div>`.s; };
        paint();
        m.body.onclick = async (e) => { const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
          try {
            if (a === 'note') commForm('leads', x.lead, async () => { x = await load(); paint(); });
            if (a === 'msg') requestMsg('leads', x.lead);
            if (a === 'edit') G.formModal({ title: 'Edit prospek', wide: true, fields: leadFields(U.opts), values: { ...x.lead, business_unit_id: x.lead.business_unit_id || '' }, onSubmit: async (v) => { await G.api.patch('/leads/' + x.lead.id, clean(v)); G.toast('Tersimpan'); x = await load(); paint(); draw(); } });
            if (a === 'convert') { await G.api.post(`/leads/${x.lead.id}/convert`, {}); G.toast('Dikonversi menjadi pelanggan'); m.close(); tab = 'customers'; draw(); }
            if (a === 'del' && await G.confirm('Hapus prospek ini?', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/leads/' + x.lead.id); G.toast('Prospek dihapus'); m.close(); draw(); }
          } catch (err) { G.toast(G.errText(err), 'err'); } };
      },
      cust: async (d) => {
        const load = () => G.api.get(`/customers/${d.id}/detail`); let x = await load();
        const m = G.modal({ title: x.customer.name, wide: true, body: '' });
        const paint = () => { const c = x.customer; m.body.innerHTML = html`<div class="grid split"><div class="card"><h3>Data</h3><div class="small"><div>Bisnis: ${c.business_name || '-'} · ${c.category || '-'}</div><div>WhatsApp: ${c.whatsapp || '—'}</div><div>Email: ${c.email || '—'}</div><div>Alamat: ${c.address || '—'}</div><div>Website: ${c.website || '—'}</div>${c.notes ? html`<div style="white-space:pre-wrap">Catatan: ${c.notes}</div>` : ''}</div></div>
          <div class="card"><h3>Pesanan (${x.orders.length})</h3>${G.table([{ h: 'No', f: (o) => html`<a href="#/orders/${o.id}">${o.order_no}</a>` }, { h: 'Bayar', f: (o) => G.badge(o.payment_status) }, { h: 'Total', num: true, f: (o) => G.fmt.idr(o.total) }], x.orders, { empty: 'Belum ada pesanan' })}</div></div>
          <div class="card" style="margin-top:12px"><h3>Konteks pelanggan (memori AI)</h3>${x.memories.length ? html`<div class="list">${x.memories.map((q) => html`<div class="item"><div class="grow small">${q.content}</div></div>`)}</div>` : html`<div class="mute small">Belum ada.</div>`}</div>
          <div class="card" style="margin-top:12px"><h3>Riwayat komunikasi <span class="sp"></span><button class="btn sm" data-a="note" ${G.can('manager') ? '' : raw('disabled')}>＋ Catat</button></h3>${commList(x.communications)}</div>
          <div class="row" style="margin-top:12px"><button class="btn" data-a="msg" ${G.can('manager') ? '' : raw('disabled')}>✉ Ajukan kirim pesan</button><button class="btn" data-a="edit" ${G.can('manager') ? '' : raw('disabled')}>Edit</button><button class="btn danger" data-a="del" ${G.can('admin') ? '' : raw('disabled')}>Hapus</button></div>`.s; };
        paint();
        m.body.onclick = async (e) => { const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
          try {
            if (a === 'note') commForm('customers', x.customer, async () => { x = await load(); paint(); });
            if (a === 'msg') requestMsg('customers', { ...x.customer, business_name: x.customer.name });
            if (a === 'edit') G.formModal({ title: 'Edit pelanggan', wide: true, fields: customerFields(U.opts), values: { ...x.customer, business_unit_id: x.customer.business_unit_id || '' }, onSubmit: async (v) => { await G.api.patch('/customers/' + x.customer.id, clean(v)); G.toast('Tersimpan'); x = await load(); paint(); draw(); } });
            if (a === 'del' && await G.confirm('Hapus pelanggan ini?', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/customers/' + x.customer.id); G.toast('Pelanggan dihapus'); m.close(); draw(); }
          } catch (err) { G.toast(G.errText(err), 'err'); } };
      }
    });
  }
});
