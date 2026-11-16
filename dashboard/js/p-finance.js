'use strict';
/* Halaman 13 Finance, 16 AI Usage. */

G.route('/finance', {
  id: 'finance', title: 'Keuangan',
  async render(view, p, alive) {
    const U = await G.unitOpts(); if (!alive()) return;
    const f = { days: 30, unit: '', period: 'day', type: '' };
    const draw = async () => {
      const [s, ser, bu, tx] = await Promise.all([G.api.get('/finance/summary' + G.qs({ days: f.days, unit_id: f.unit })), G.api.get('/finance/series' + G.qs({ period: f.period, unit_id: f.unit })), G.api.get('/finance/by-unit' + G.qs({ days: f.days })), G.api.get('/transactions' + G.qs({ business_unit_id: f.unit, type: f.type }))]);
      if (!alive()) return;
      const lbl = (b) => (f.period === 'month' ? b.slice(0, 7) : G.fmt.day(b));
      const short = (n) => (n >= 1e6 ? G.fmt.num(n / 1e6, 1) + ' jt' : n >= 1e3 ? G.fmt.num(n / 1e3) + ' rb' : G.fmt.num(n));
      view.innerHTML = html`${G.pagehead('Keuangan', 'Hanya transaksi nyata (pembayaran pesanan & catatan manual). Tidak ada simulasi pendapatan.', html`<button class="btn" data-act="report" ${G.can('manager') ? '' : raw('disabled')}>📄 Buat laporan</button><button class="btn pri" data-act="addtx" ${G.can('admin') ? '' : raw('disabled')}>＋ Transaksi manual</button>`)}
        <div class="toolbar"><select id="fd">${[[7, '7 hari'], [30, '30 hari'], [90, '90 hari'], [365, '1 tahun'], [36500, 'Semua']].map(([v, l]) => html`<option value="${v}" ${f.days === v ? raw('selected') : ''}>${l}</option>`)}</select>
          <select id="fu"><option value="">Semua unit</option>${U.raw.map((u) => html`<option value="${u.id}" ${f.unit === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select></div>
        ${s.note ? html`<div class="notice info" style="margin-bottom:12px">${s.note}</div>` : ''}
        <div class="grid g4 keep2" style="margin-bottom:14px">${G.stat('Total omzet', G.fmt.idr(s.income), 'pemasukan tercatat', 'em')}${G.stat('Pengeluaran operasional', G.fmt.idr(s.expense))}
          ${G.stat('Biaya API AI', s.apiCostIdr == null ? G.fmt.usd(s.apiCostUsd) : G.fmt.idr(s.apiCostIdr), s.apiCostIdr == null ? 'USD — kurs belum diisi' : G.fmt.usd(s.apiCostUsd) + ' (estimasi)')}${G.stat('Keuntungan bersih', G.fmt.idr(s.net), 'piutang berjalan ' + G.fmt.idr(s.receivable), s.net < 0 ? 'err' : 'em')}</div>
        <div class="card" style="margin-bottom:14px"><h3>Grafik pendapatan <span class="sp"></span>${[['day', 'Harian'], ['week', 'Mingguan'], ['month', 'Bulanan']].map(([k, l]) => html`<button class="btn sm ${f.period === k ? 'pri' : ''}" data-act="per" data-k="${k}">${l}</button>`)}</h3>
          ${G.chart({ labels: ser.items.map((x) => lbl(x.bucket)), type: 'bar', fmt: short, series: [{ name: 'Pemasukan', data: ser.items.map((x) => x.income) }, { name: 'Pengeluaran', data: ser.items.map((x) => x.expense), color: '#f59e0b' }] })}</div>
        <div class="grid split" style="margin-bottom:14px"><div class="card"><h3>Pendapatan per unit bisnis</h3>${G.table([{ h: 'Unit', f: (x) => x.name }, { h: 'Pesanan', num: true, f: (x) => x.orders }, { h: 'Pemasukan', num: true, f: (x) => G.fmt.idr(x.income) }, { h: 'Pengeluaran', num: true, f: (x) => G.fmt.idr(x.expense) }, { h: 'Laba', num: true, f: (x) => html`<b class="${x.income - x.expense < 0 ? 'err' : 'em'}">${G.fmt.idr(x.income - x.expense)}</b>` }], bu.items)}</div>
          <div class="card"><h3>Per kategori</h3>${G.table([{ h: 'Kategori', f: (x) => x.category }, { h: 'Jenis', f: (x) => G.badge(x.type) }, { h: 'Total', num: true, f: (x) => G.fmt.idr(x.total) }], s.by_category, { empty: 'Belum ada transaksi' })}</div></div>
        <div class="card"><h3>Riwayat transaksi <span class="sp"></span><select id="ft" style="width:auto"><option value="">Semua</option><option value="income" ${f.type === 'income' ? raw('selected') : ''}>Pemasukan</option><option value="expense" ${f.type === 'expense' ? raw('selected') : ''}>Pengeluaran</option></select></h3>
          ${G.table([{ h: 'Tanggal', f: (x) => G.fmt.date(x.occurred_at) }, { h: 'Jenis', f: (x) => G.badge(x.type) }, { h: 'Kategori', f: (x) => x.category }, { h: 'Keterangan', f: (x) => x.description || '-' }, { h: 'Unit', f: (x) => x.unit_name || '-' }, { h: 'Sumber', f: (x) => (x.order_id ? html`<a href="#/orders/${x.order_id}">${x.order_no}</a>` : x.source) }, { h: 'Jumlah', num: true, f: (x) => html`<b class="${x.type === 'income' ? 'em' : ''}">${x.type === 'expense' ? '−' : ''}${G.fmt.idr(x.amount)}</b>` },
            { h: '', f: (x) => (x.source === 'manual' ? html`<button class="btn sm danger" data-act="deltx" data-id="${x.id}" ${G.can('admin') ? '' : raw('disabled')}>Hapus</button>` : '') }], tx.items, { empty: 'Belum ada transaksi. Omzet muncul setelah pembayaran pesanan dicatat.' })}</div>`.s;
      view.querySelector('#fd').onchange = (e) => { f.days = Number(e.target.value); draw(); };
      view.querySelector('#fu').onchange = (e) => { f.unit = e.target.value; draw(); };
      view.querySelector('#ft').onchange = (e) => { f.type = e.target.value; draw(); };
    };
    await draw();
    G.bind(view, {
      per: (d) => { f.period = d.k; draw(); },
      addtx: () => G.formModal({ title: 'Transaksi manual', intro: 'Untuk biaya operasional (domain, hosting, iklan, dll) atau pemasukan di luar pesanan. Pembayaran pesanan dicatat dari halaman pesanan.', values: { type: 'expense', category: 'operasional', occurred_at: G.fmt.dateInput(new Date()) },
        fields: [{ name: 'type', label: 'Jenis', type: 'select', options: [['expense', 'Pengeluaran'], ['income', 'Pemasukan']] }, { name: 'amount', label: 'Jumlah (Rp)', type: 'number', min: 0, step: 'any', required: true }, { name: 'category', label: 'Kategori' }, { name: 'occurred_at', label: 'Tanggal', type: 'date' }, { name: 'business_unit_id', label: 'Unit bisnis', type: 'select', options: U.opts }, { name: 'description', label: 'Keterangan', full: true }],
        onSubmit: async (v) => { await G.api.post('/transactions', v); G.toast('Transaksi dicatat'); draw(); } }),
      deltx: async (d) => { if (await G.confirm('Hapus transaksi manual ini?', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/transactions/' + d.id); G.toast('Dihapus'); draw(); } },
      report: () => G.formModal({ title: 'Buat laporan keuangan', intro: 'Laporan dihitung dari data nyata dan disimpan sebagai berkas (Task Center → Berkas hasil kerja).', submitLabel: 'Buat laporan', values: { period: 'week' },
        fields: [{ name: 'period', label: 'Periode', type: 'select', options: [['day', 'Harian'], ['week', 'Mingguan'], ['month', 'Bulanan']] }, { name: 'business_unit_code', label: 'Unit bisnis', type: 'select', options: [['', 'Semua unit'], ...U.raw.map((u) => [u.code, u.name])] }],
        onSubmit: async (v) => { const r = await G.api.post('/finance/report', v); G.toast('Laporan dibuat'); if (r.file_id) G.openFile(r.file_id); } })
    });
  }
});

G.route('/usage', {
  id: 'usage', title: 'Penggunaan AI',
  async render(view, p, alive) {
    let days = 30;
    const draw = async () => {
      const u = await G.api.get('/usage' + G.qs({ days })); if (!alive()) return; const t = u.totals;
      view.innerHTML = html`${G.pagehead('Penggunaan & Biaya AI', null, html`<select id="ud" style="width:auto">${[7, 30, 90].map((v) => html`<option value="${v}" ${days === v ? raw('selected') : ''}>${v} hari</option>`)}</select>`)}
        <div class="notice info" style="margin-bottom:12px">${u.note}</div>
        <div class="grid g4 keep2" style="margin-bottom:14px">${G.stat('Panggilan AI', G.fmt.num(t.calls))}${G.stat('Token masuk', G.fmt.num(t.prompt_tokens))}${G.stat('Token keluar', G.fmt.num(t.completion_tokens))}${G.stat('Biaya (estimasi)', G.fmt.usd(t.cost_usd), u.usd_idr_rate ? '≈ ' + G.fmt.idr(t.cost_usd * u.usd_idr_rate) : 'kurs belum diisi di Pengaturan', 'warn')}</div>
        <div class="card" style="margin-bottom:14px"><h3>Token per hari</h3>${G.chart({ labels: u.by_day.map((x) => G.fmt.day(x.day)), type: 'bar', series: [{ name: 'Token', data: u.by_day.map((x) => x.tokens) }], fmt: (n) => (n >= 1000 ? G.fmt.num(n / 1000, 1) + 'rb' : G.fmt.num(n)) })}</div>
        <div class="grid split" style="margin-bottom:14px"><div class="card"><h3>Per karyawan (batas bulanan)</h3>${G.table([{ h: 'Karyawan', f: (a) => html`${a.avatar || ''} <a href="#/employees/${a.id}">${a.name}</a>` }, { h: 'Token', num: true, f: (a) => G.fmt.num(a.tokens) }, { h: 'Biaya', num: true, f: (a) => G.fmt.usd(a.cost_usd) },
          { h: 'Bulan ini vs batas', f: (a) => (a.token_limit > 0 ? html`<div class="bar ${G.pct(a.month_tokens, a.token_limit) > 90 ? 'err' : G.pct(a.month_tokens, a.token_limit) > 70 ? 'warn' : ''}"><i style="width:${G.pct(a.month_tokens, a.token_limit)}%"></i></div><span class="small mute">${G.fmt.num(a.month_tokens)}/${G.fmt.num(a.token_limit)}</span>` : a.cost_limit > 0 ? html`<div class="bar"><i style="width:${G.pct(a.month_cost, a.cost_limit)}%"></i></div><span class="small mute">${G.fmt.usd(a.month_cost)}/${G.fmt.usd(a.cost_limit)}</span>` : html`<span class="mute small">tanpa batas</span>`) }], u.by_agent)}</div>
          <div class="card"><h3>Per model</h3>${G.table([{ h: 'Penyedia', f: (m) => m.provider }, { h: 'Model', f: (m) => m.model }, { h: 'Panggilan', num: true, f: (m) => G.fmt.num(m.calls) }, { h: 'Token', num: true, f: (m) => G.fmt.num(m.tokens) }, { h: 'Biaya', num: true, f: (m) => G.fmt.usd(m.cost_usd) }], u.by_model, { empty: 'Belum ada pemakaian' })}</div></div>
        <div class="card"><h3>Riwayat eksekusi terbaru</h3>${G.table([{ h: 'Waktu', f: (r) => G.fmt.dt(r.started_at) }, { h: 'Karyawan', f: (r) => r.agent_name }, { h: 'Tugas', f: (r) => (r.task_id ? html`<a href="#/tasks/${r.task_id}">${r.task_title || 'tugas'}</a>` : '-') }, { h: 'Fase', f: (r) => r.phase }, { h: 'Status', f: (r) => G.badge(r.status) }, { h: 'Token', num: true, f: (r) => G.fmt.num(r.prompt_tokens + r.completion_tokens) }, { h: 'Biaya', num: true, f: (r) => G.fmt.usd(r.cost_usd) }, { h: 'Durasi', num: true, f: (r) => G.fmt.dur(r.duration_ms) }], u.recent_runs, { empty: 'Belum ada eksekusi' })}</div>`.s;
      view.querySelector('#ud').onchange = (e) => { days = Number(e.target.value); draw(); };
    };
    await draw();
  }
});
