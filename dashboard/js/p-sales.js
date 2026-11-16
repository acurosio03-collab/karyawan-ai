'use strict';
/* Halaman 11 Products, 12 Orders (pesanan, penawaran, invoice). */

/* ---------- Produk ---------- */
G.route('/products', {
  id: 'products', title: 'Produk & Daftar Harga',
  async render(view, p, alive) {
    const U = await G.unitOpts(); if (!alive()) return; const f = { q: '', unit: '', active: '' };
    const draw = async () => {
      const r = await G.api.get('/products' + G.qs({ q: f.q, business_unit_id: f.unit, active: f.active })); if (!alive()) return;
      view.innerHTML = html`${G.pagehead('Produk & Daftar Harga', 'Katalog layanan/produk per unit bisnis. Harga di sini dipakai otomatis pada pesanan & penawaran.', html`<button class="btn pri" data-act="add" ${G.can('manager') ? '' : raw('disabled')}>＋ Produk</button>`)}
        <div class="toolbar"><input id="fq" type="search" placeholder="Cari nama / SKU…" value="${f.q}"><select id="fu"><option value="">Semua unit</option>${U.raw.map((u) => html`<option value="${u.id}" ${f.unit === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select>
        <select id="fa"><option value="">Semua</option><option value="true" ${f.active === 'true' ? raw('selected') : ''}>Aktif</option><option value="false" ${f.active === 'false' ? raw('selected') : ''}>Nonaktif</option></select></div>
        <div class="card">${G.table([{ h: 'Produk', f: (x) => html`<b>${x.name}</b>${x.sku ? html` <span class="mono mute">${x.sku}</span>` : ''}<div class="small mute">${x.description || ''}</div>` }, { h: 'Jenis', f: (x) => x.type }, { h: 'Unit', f: (x) => (U.raw.find((u) => u.id === x.business_unit_id) || {}).name || '-' },
          { h: 'Harga', num: true, f: (x) => G.fmt.idr(x.price) }, { h: 'Modal', num: true, f: (x) => G.fmt.idr(x.cost) }, { h: 'Status', f: (x) => G.badge(x.active ? 'active' : 'inactive') },
          { h: '', f: (x) => html`<button class="btn sm" data-act="edit" data-id="${x.id}" ${G.can('manager') ? '' : raw('disabled')}>Ubah</button> <button class="btn sm danger" data-act="del" data-id="${x.id}" ${G.can('admin') ? '' : raw('disabled')}>Hapus</button>` }], r.items, { empty: 'Belum ada produk. Tambahkan layanan/produk pertama Anda.' })}</div>`.s;
      view.querySelector('#fq').onchange = (e) => { f.q = e.target.value; draw(); };
      view.querySelector('#fu').onchange = (e) => { f.unit = e.target.value; draw(); };
      view.querySelector('#fa').onchange = (e) => { f.active = e.target.value; draw(); };
      view._rows = r.items;
    };
    await draw();
    const form = (x) => G.formModal({ title: x ? 'Ubah produk' : 'Produk baru', wide: true, values: x ? { ...x, business_unit_id: x.business_unit_id || '' } : { type: 'jasa', active: true, price: 0, cost: 0 },
      fields: [{ name: 'name', label: 'Nama produk / layanan', required: true }, { name: 'sku', label: 'SKU / kode' }, { name: 'type', label: 'Jenis', placeholder: 'jasa / template / aset / barang' }, { name: 'business_unit_id', label: 'Unit bisnis', type: 'select', options: U.opts },
        { name: 'price', label: 'Harga jual (Rp)', type: 'number', min: 0, required: true }, { name: 'cost', label: 'Modal / biaya (Rp)', type: 'number', min: 0 }, { name: 'description', label: 'Deskripsi', type: 'textarea', rows: 2 }, { name: 'active', label: 'Aktif dijual', type: 'checkbox' }],
      onSubmit: async (v) => { if (x) await G.api.patch('/products/' + x.id, v); else await G.api.post('/products', v); G.toast('Produk disimpan'); draw(); } });
    G.bind(view, { add: () => form(null), edit: (d) => form(view._rows.find((x) => x.id === d.id)), del: async (d) => { if (await G.confirm('Hapus produk ini?', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/products/' + d.id); G.toast('Produk dihapus'); draw(); } } });
  }
});

/* ---------- editor item (dipakai pesanan & penawaran) ---------- */
function itemsEditor(products) {
  const row = () => html`<div class="item" data-row style="gap:6px;flex-wrap:wrap"><select data-k="product" style="flex:2 1 180px"><option value="">— item bebas —</option>${products.map((p) => html`<option value="${p.id}" data-name="${p.name}" data-price="${p.price}">${p.name} (${G.fmt.idr(p.price)})</option>`)}</select>
    <input data-k="name" placeholder="Nama item" style="flex:2 1 150px"><input data-k="qty" type="number" min="0.01" step="any" value="1" style="flex:0 0 80px" aria-label="Jumlah"><input data-k="price" type="number" min="0" placeholder="Harga" style="flex:1 1 110px" aria-label="Harga"><button type="button" class="btn sm danger" data-rm>✕</button></div>`;
  const wrap = document.createElement('div'); wrap.innerHTML = `<div data-rows></div><button type="button" class="btn sm" data-add>＋ Tambah item</button><div class="small mute" style="margin-top:6px">Pilih produk agar harga diambil dari database, atau isi item bebas (nama + harga).</div><div style="text-align:right;margin-top:8px"><b>Total: <span data-total>Rp 0</span></b></div>`;
  const rows = wrap.querySelector('[data-rows]');
  const add = () => { const d = document.createElement('div'); d.innerHTML = row().s; rows.appendChild(d.firstElementChild); };
  const total = () => { let t = 0; rows.querySelectorAll('[data-row]').forEach((r) => { t += (Number(r.querySelector('[data-k=qty]').value) || 0) * (Number(r.querySelector('[data-k=price]').value) || 0); }); wrap.querySelector('[data-total]').textContent = G.fmt.idr(t); };
  wrap.addEventListener('change', (e) => { const r = e.target.closest('[data-row]'); if (!r) return; if (e.target.dataset.k === 'product') { const o = e.target.selectedOptions[0]; if (o && o.value) { r.querySelector('[data-k=name]').value = o.dataset.name; r.querySelector('[data-k=price]').value = o.dataset.price; } } total(); });
  wrap.addEventListener('input', total);
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-add]')) { add(); total(); } const rm = e.target.closest('[data-rm]'); if (rm) { rm.closest('[data-row]').remove(); total(); } });
  add();
  const read = () => [...rows.querySelectorAll('[data-row]')].map((r) => {
    const pid = r.querySelector('[data-k=product]').value; const name = r.querySelector('[data-k=name]').value.trim(); const qty = Number(r.querySelector('[data-k=qty]').value) || 1; const price = r.querySelector('[data-k=price]').value;
    const it = { qty }; if (pid) it.product_id = pid; if (name) it.name = name; if (price !== '') it.price = Number(price); return it;
  }).filter((it) => it.product_id || it.name);
  return { el: wrap, read };
}

/* ---------- Pesanan, Penawaran, Invoice ---------- */
G.route('/orders', {
  id: 'orders', title: 'Pesanan',
  async render(view, p, alive) {
    const hashTab = (location.hash.split('tab=')[1] || '').split('&')[0]; let tab = ['pesanan', 'penawaran', 'invoice'].includes(hashTab) ? hashTab : 'pesanan';
    const [U, prod, cust] = await Promise.all([G.unitOpts(), G.api.get('/products?active=true'), G.api.get('/customers')]); if (!alive()) return;
    const f = { status: '', pay: '', unit: '', q: '' };
    const newOrder = () => {
      const ed = itemsEditor(prod.items);
      const m = G.modal({ title: 'Pesanan baru', wide: true, body: html`<div class="frm" style="margin-bottom:12px">${G.fieldHtml({ name: 'customer_id', label: 'Pelanggan', type: 'select', options: [['', '— tanpa pelanggan —'], ...cust.items.map((c) => [c.id, c.name + (c.business_name ? ' · ' + c.business_name : '')])] })}${G.fieldHtml({ name: 'business_unit_id', label: 'Unit bisnis', type: 'select', options: U.opts })}
        ${G.fieldHtml({ name: 'status', label: 'Status awal', type: 'select', options: [['confirmed', 'Dikonfirmasi'], ['draft', 'Draft']] })}${G.fieldHtml({ name: 'notes', label: 'Catatan' })}</div><div id="oi"></div><div id="oerr" class="notice err" hidden style="margin-top:10px"></div>`, footer: html`<button class="btn" data-n>Batal</button><button class="btn pri" data-s>Buat pesanan</button>` });
      m.el.querySelector('#oi').appendChild(ed.el); m.el.querySelector('[data-n]').onclick = m.close;
      m.el.querySelector('[data-s]').onclick = async (e) => {
        const g = (n) => m.el.querySelector(`[name=${n}]`).value; const err = m.el.querySelector('#oerr'); err.hidden = true; e.target.disabled = true;
        try { const o = await G.api.post('/orders', { customer_id: g('customer_id'), business_unit_id: g('business_unit_id'), status: g('status'), notes: g('notes'), items: ed.read() }); G.toast('Pesanan ' + o.order_no + ' dibuat'); m.close(); G.go('/orders/' + o.id); }
        catch (x) { err.textContent = G.errText(x); err.hidden = false; e.target.disabled = false; }
      };
    };
    const newQuote = () => {
      const ed = itemsEditor(prod.items); G.api.get('/leads').then((leads) => {
        const m = G.modal({ title: 'Penawaran baru (draft)', wide: true, body: html`<div class="frm" style="margin-bottom:12px">${G.fieldHtml({ name: 'customer_id', label: 'Untuk pelanggan', type: 'select', options: [['', '— pilih pelanggan —'], ...cust.items.map((c) => [c.id, c.name])] })}${G.fieldHtml({ name: 'lead_id', label: 'atau untuk prospek', type: 'select', options: [['', '— pilih prospek —'], ...leads.items.map((l) => [l.id, l.business_name])] })}
          ${G.fieldHtml({ name: 'business_unit_code', label: 'Unit bisnis', type: 'select', options: [['', '—'], ...U.raw.map((u) => [u.code, u.name])] })}${G.fieldHtml({ name: 'notes', label: 'Catatan / syarat' })}</div><div id="oi"></div><div id="oerr" class="notice err" hidden style="margin-top:10px"></div>`, footer: html`<button class="btn" data-n>Batal</button><button class="btn pri" data-s>Simpan draft</button>` });
        m.el.querySelector('#oi').appendChild(ed.el); m.el.querySelector('[data-n]').onclick = m.close;
        m.el.querySelector('[data-s]').onclick = async (e) => {
          const g = (n) => m.el.querySelector(`[name=${n}]`).value; const err = m.el.querySelector('#oerr'); err.hidden = true; e.target.disabled = true;
          try { await G.api.post('/quotations', { customer_id: g('customer_id'), lead_id: g('lead_id'), business_unit_code: g('business_unit_code'), notes: g('notes'), items: ed.read() }); G.toast('Draft penawaran dibuat'); m.close(); draw(); }
          catch (x) { err.textContent = G.errText(x); err.hidden = false; e.target.disabled = false; }
        };
      });
    };
    const draw = async () => {
      view.innerHTML = html`${G.pagehead('Pesanan, Penawaran & Invoice', 'AI hanya membuat DRAFT. Pengiriman penawaran, penerbitan invoice, dan penerimaan pesanan lewat persetujuan Owner.', tab === 'pesanan' ? html`<button class="btn pri" data-act="neworder" ${G.can('manager') ? '' : raw('disabled')}>＋ Pesanan</button>` : tab === 'penawaran' ? html`<button class="btn pri" data-act="newquote" ${G.can('manager') ? '' : raw('disabled')}>＋ Penawaran</button>` : '')}
        <div class="tabs">${[['pesanan', 'Pesanan'], ['penawaran', 'Penawaran'], ['invoice', 'Invoice']].map(([k, l]) => html`<button class="${tab === k ? 'on' : ''}" data-act="tab" data-k="${k}">${l}</button>`)}</div><div id="obody"><div class="empty">Memuat…</div></div>`.s;
      const box = view.querySelector('#obody');
      if (tab === 'pesanan') {
        const r = await G.api.get('/orders' + G.qs({ status: f.status, payment_status: f.pay, business_unit_id: f.unit, q: f.q })); if (!alive()) return;
        const sel = (id, opts, cur, ph) => html`<select id="${id}"><option value="">${ph}</option>${opts.map(([v, l]) => html`<option value="${v}" ${cur === v ? raw('selected') : ''}>${l}</option>`)}</select>`;
        box.innerHTML = html`<div class="toolbar"><input id="oq" type="search" placeholder="Cari no. pesanan / pelanggan" value="${f.q}">${sel('os', ['draft', 'confirmed', 'in_progress', 'completed', 'cancelled'].map((s) => [s, G.stLabel(s)]), f.status, 'Semua status')}${sel('op', ['unpaid', 'partial', 'paid', 'refunded'].map((s) => [s, G.stLabel(s)]), f.pay, 'Semua pembayaran')}${sel('ou', U.raw.map((u) => [u.id, u.name]), f.unit, 'Semua unit')}</div>
          <div class="card">${G.table([{ h: 'No. pesanan', f: (o) => html`<a href="#/orders/${o.id}"><b>${o.order_no}</b></a>` }, { h: 'Pelanggan', f: (o) => o.customer_name || '-' }, { h: 'Unit', f: (o) => o.unit_name || '-' }, { h: 'Status', f: (o) => G.badge(o.status) }, { h: 'Pembayaran', f: (o) => G.badge(o.payment_status) }, { h: 'Total', num: true, f: (o) => G.fmt.idr(o.total) }, { h: 'Dibayar', num: true, f: (o) => G.fmt.idr(o.paid_amount) }, { h: 'Tanggal', f: (o) => G.fmt.date(o.created_at) }], r.items, { empty: 'Belum ada pesanan.' })}</div>`.s;
        box.querySelector('#oq').onchange = (e) => { f.q = e.target.value; draw(); }; box.querySelector('#os').onchange = (e) => { f.status = e.target.value; draw(); }; box.querySelector('#op').onchange = (e) => { f.pay = e.target.value; draw(); }; box.querySelector('#ou').onchange = (e) => { f.unit = e.target.value; draw(); };
      } else if (tab === 'penawaran') {
        const r = await G.api.get('/quotations'); if (!alive()) return; view._q = r.items;
        box.innerHTML = html`<div class="card">${G.table([{ h: 'No.', f: (q) => html`<b>${q.number}</b>` }, { h: 'Untuk', f: (q) => q.customer_name || q.lead_name || '-' }, { h: 'Unit', f: (q) => q.unit_name || '-' }, { h: 'Dibuat oleh', f: (q) => q.agent_name || 'Owner' }, { h: 'Status', f: (q) => G.badge(q.status) }, { h: 'Total', num: true, f: (q) => G.fmt.idr(q.total) },
          { h: '', f: (q) => html`<button class="btn sm" data-act="qview" data-id="${q.id}">Lihat</button>` }], r.items, { empty: 'Belum ada penawaran.' })}</div>`.s;
      } else {
        const r = await G.api.get('/invoices'); if (!alive()) return;
        box.innerHTML = html`<div class="card">${G.table([{ h: 'No. invoice', f: (i) => html`<a href="#" data-act="iview" data-id="${i.id}"><b>${i.invoice_no}</b></a>` }, { h: 'Pesanan', f: (i) => (i.order_id ? html`<a href="#/orders/${i.order_id}">${i.order_no}</a>` : '-') }, { h: 'Pelanggan', f: (i) => i.customer_name || '-' }, { h: 'Status', f: (i) => G.badge(i.status) }, { h: 'Jatuh tempo', f: (i) => G.fmt.date(i.due_date) }, { h: 'Total', num: true, f: (i) => G.fmt.idr(i.total) }], r.items, { empty: 'Belum ada invoice. Buat dari halaman detail pesanan.' })}</div>`.s;
      }
    };
    await draw();
    G.bind(view, {
      tab: (d) => { tab = d.k; draw(); }, neworder: newOrder, newquote: newQuote, iview: (d) => G.showInvoice(d.id, draw),
      qview: (d) => {
        const q = view._q.find((x) => x.id === d.id); const items = Array.isArray(q.items) ? q.items : [];
        const m = G.modal({ title: 'Penawaran ' + q.number, wide: true, body: html`<div class="row" style="margin-bottom:8px">${G.badge(q.status)} <span class="mute small">untuk ${q.customer_name || q.lead_name || '-'} · ${G.fmt.dt(q.created_at)}</span></div>
          ${G.table([{ h: 'Item', f: (x) => x.name }, { h: 'Qty', num: true, f: (x) => x.qty }, { h: 'Harga', num: true, f: (x) => G.fmt.idr(x.price) }, { h: 'Subtotal', num: true, f: (x) => G.fmt.idr(x.qty * x.price) }], items)}<p style="text-align:right"><b>Total ${G.fmt.idr(q.total)}</b></p>${q.notes ? html`<div class="small">Catatan: ${q.notes}</div>` : ''}`,
          footer: html`${['draft', 'sent'].includes(q.status) ? html`<button class="btn" data-a="send" ${G.can('manager') ? '' : raw('disabled')}>✉ Ajukan kirim</button><button class="btn" data-a="acc" ${G.can('manager') ? '' : raw('disabled')}>Ditandai diterima</button><button class="btn danger" data-a="rej" ${G.can('manager') ? '' : raw('disabled')}>Ditolak</button>` : ''}${q.status === 'accepted' ? html`<button class="btn pri" data-a="conv" ${G.can('manager') ? '' : raw('disabled')}>Jadikan pesanan</button>` : ''}` });
        m.el.querySelector('footer').onclick = async (e) => { const a = e.target.closest('[data-a]'); if (!a) return; const k = a.dataset.a;
          try {
            if (k === 'send') G.formModal({ title: 'Ajukan pengiriman penawaran', intro: 'Masuk ke Approval Center — tidak terkirim sebelum Anda setujui.', fields: [{ name: 'channel', label: 'Kanal', type: 'select', options: [['whatsapp', 'WhatsApp'], ['email', 'Email']] }, { name: 'to', label: 'Tujuan (kosong = kontak tersimpan)' }, { name: 'subject', label: 'Subjek (email)' }, { name: 'text', label: 'Isi pesan', type: 'textarea', required: true, rows: 5 }], values: { text: `Halo, berikut penawaran ${q.number} total ${G.fmt.idr(q.total)}. Terima kasih.` }, onSubmit: async (v) => { await G.api.post(`/quotations/${q.id}/request-send`, v); G.toast('Diajukan ke Approval Center'); G.refreshBadges(); m.close(); } });
            if (k === 'acc' || k === 'rej') { await G.api.patch('/quotations/' + q.id, { status: k === 'acc' ? 'accepted' : 'rejected' }); G.toast('Status diperbarui'); m.close(); draw(); }
            if (k === 'conv') { const o = await G.api.post(`/quotations/${q.id}/convert`, {}); G.toast('Pesanan dibuat'); m.close(); G.go('/orders/' + (o.id || o.order_id || '')); }
          } catch (x) { G.toast(G.errText(x), 'err'); } };
      }
    });
  }
});

G.showInvoice = async (id, after) => {
  const { invoice: i, company } = await G.api.get('/invoices/' + id);
  const items = Array.isArray(i.items) ? i.items : [];
  const m = G.modal({ title: 'Invoice ' + i.invoice_no, wide: true, onClose: () => document.body.classList.remove('pm'),
    body: html`<div id="invprint"><div class="row sb"><div><h2>${company}</h2><div class="small mute">Invoice ${i.invoice_no}</div></div><div style="text-align:right">${G.badge(i.status)}<div class="small">Jatuh tempo: ${G.fmt.date(i.due_date)}</div><div class="small">Terbit: ${i.issued_at ? G.fmt.date(i.issued_at) : 'belum diterbitkan'}</div></div></div>
      <div class="small" style="margin:12px 0"><b>Kepada:</b> ${i.customer_name || '-'}${i.business_name ? ' · ' + i.business_name : ''}<br>${i.customer_address || ''} ${i.customer_whatsapp || ''}<br>Pesanan: ${i.order_no || '-'}</div>
      ${G.table([{ h: 'Item', f: (x) => x.name }, { h: 'Qty', num: true, f: (x) => x.qty }, { h: 'Harga', num: true, f: (x) => G.fmt.idr(x.price) }, { h: 'Subtotal', num: true, f: (x) => G.fmt.idr(x.qty * x.price) }], items)}<p style="text-align:right;font-size:18px"><b>Total ${G.fmt.idr(i.total)}</b></p>${i.notes ? html`<div class="small">Catatan: ${i.notes}</div>` : ''}${i.status === 'draft' ? html`<div class="notice" style="margin-top:10px">DRAFT — belum resmi. Ajukan penerbitan untuk disetujui Owner.</div>` : ''}</div>`,
    footer: html`<button class="btn" data-a="print">🖨 Cetak / simpan PDF</button>${i.status === 'draft' ? html`<button class="btn pri" data-a="issue" ${G.can('manager') ? '' : raw('disabled')}>Ajukan penerbitan</button>` : ''}${i.status !== 'void' ? html`<button class="btn danger" data-a="void" ${G.can('admin') ? '' : raw('disabled')}>Batalkan invoice</button>` : ''}` });
  m.el.querySelector('footer').onclick = async (e) => { const a = e.target.closest('[data-a]'); if (!a) return; const k = a.dataset.a;
    try {
      if (k === 'print') { document.body.classList.add('pm'); window.print(); setTimeout(() => document.body.classList.remove('pm'), 500); }
      if (k === 'issue') { await G.api.post(`/invoices/${i.id}/request-issue`, {}); G.toast('Diajukan ke Approval Center'); G.refreshBadges(); m.close(); }
      if (k === 'void' && await G.confirm('Batalkan invoice ini?', { danger: true, okLabel: 'Batalkan invoice' })) { await G.api.post(`/invoices/${i.id}/void`, {}); G.toast('Invoice dibatalkan'); m.close(); after && after(); }
    } catch (x) { G.toast(G.errText(x), 'err'); } };
};

/* ---------- Detail pesanan ---------- */
G.route('/orders/:id', {
  id: 'order-detail', menu: 'orders', title: 'Detail Pesanan',
  async render(view, p, alive) {
    const d = await G.api.get('/orders/' + p.id); if (!alive()) return; const o = d.order; const sisa = Math.max(0, o.total - o.paid_amount);
    view.innerHTML = html`<div class="pagehead"><a class="btn sm" href="#/orders">← Pesanan</a><div style="flex:1;min-width:200px"><h2 style="font-size:20px">${o.order_no}</h2><div class="mute small">${o.customer_name || 'Tanpa pelanggan'} · ${o.unit_name || 'Tanpa unit'} · ${G.fmt.dt(o.created_at)}</div></div>${G.badge(o.status)} ${G.badge(o.payment_status)}</div>
      <div class="grid g4 keep2" style="margin-bottom:14px">${G.stat('Total', G.fmt.idr(o.total))}${G.stat('Dibayar', G.fmt.idr(o.paid_amount), '', 'em')}${G.stat('Sisa tagihan', G.fmt.idr(sisa), '', sisa ? 'warn' : '')}${G.stat('Invoice', d.invoices.length)}</div>
      <div class="row" style="margin-bottom:14px"><select id="ost" style="width:auto" ${G.can('manager') ? '' : raw('disabled')}>${['draft', 'confirmed', 'in_progress', 'completed', 'cancelled'].map((s) => html`<option value="${s}" ${o.status === s ? raw('selected') : ''}>${G.stLabel(s)}</option>`)}</select>
        <button class="btn" data-act="pay" ${G.can('admin') && sisa > 0 ? '' : raw('disabled')}>＋ Catat pembayaran</button><button class="btn" data-act="refund" ${G.can('admin') && o.paid_amount > 0 ? '' : raw('disabled')}>↩ Refund</button><button class="btn pri" data-act="inv" ${G.can('manager') ? '' : raw('disabled')}>🧾 Buat draft invoice</button><button class="btn danger" data-act="del" ${G.can('admin') ? '' : raw('disabled')}>Hapus</button></div>
      <div class="grid split"><div class="card"><h3>Item</h3>${G.table([{ h: 'Item', f: (x) => x.name }, { h: 'Qty', num: true, f: (x) => x.qty }, { h: 'Harga', num: true, f: (x) => G.fmt.idr(x.price) }, { h: 'Subtotal', num: true, f: (x) => G.fmt.idr(x.qty * x.price) }], d.items)}${o.notes ? html`<div class="small mute" style="margin-top:8px">Catatan: ${o.notes}</div>` : ''}</div>
      <div class="card"><h3>Invoice</h3>${G.table([{ h: 'No.', f: (i) => html`<a href="#" data-act="iview" data-id="${i.id}">${i.invoice_no}</a>` }, { h: 'Status', f: (i) => G.badge(i.status) }, { h: 'Total', num: true, f: (i) => G.fmt.idr(i.total) }], d.invoices, { empty: 'Belum ada invoice' })}
      <h3 style="margin-top:14px">Transaksi pembayaran</h3>${G.table([{ h: 'Tanggal', f: (x) => G.fmt.date(x.occurred_at) }, { h: 'Jenis', f: (x) => G.badge(x.type) }, { h: 'Ket.', f: (x) => x.description || x.category }, { h: 'Jumlah', num: true, f: (x) => G.fmt.idr(x.amount) }], d.transactions, { empty: 'Belum ada pembayaran — pesanan belum dihitung sebagai omzet.' })}</div></div>`.s;
    view.querySelector('#ost').onchange = async (e) => { await G.guard(() => G.api.patch('/orders/' + o.id, { status: e.target.value }), 'Status pesanan diubah'); G.render(); };
    const amt = (title, label, path, ok) => G.formModal({ title, values: { amount: path === 'payments' ? sisa : '' }, fields: [{ name: 'amount', label, type: 'number', min: 0, step: 'any', required: true }, { name: 'note', label: 'Catatan', full: true }], onSubmit: async (v) => { await G.api.post(`/orders/${o.id}/${path}`, v); G.toast(ok); G.render(); } });
    G.bind(view, {
      pay: () => amt('Catat pembayaran masuk', 'Jumlah dibayar (Rp)', 'payments', 'Pembayaran dicatat sebagai pemasukan'), refund: () => amt('Refund', 'Jumlah refund (Rp)', 'refund', 'Refund dicatat'),
      inv: async () => { const r = await G.api.post(`/orders/${o.id}/invoice`, {}); G.toast(r.existing ? 'Invoice sudah ada' : 'Draft invoice dibuat'); G.render(); },
      iview: (x) => G.showInvoice(x.id, G.render),
      del: async () => { if (await G.confirm('Hapus pesanan ini?', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/orders/' + o.id); G.toast('Pesanan dihapus'); G.go('/orders'); } }
    });
  }
});
