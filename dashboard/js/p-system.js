'use strict';
/* Halaman 14 Approvals, 15 Automation, 17 Integrations (+Tools), 18 Settings. */

const ACTION_LABEL = { send_message: 'Kirim pesan', send_quotation: 'Kirim penawaran', issue_invoice: 'Terbitkan invoice', deploy_website: 'Deploy website', purchase_service: 'Beli layanan', make_payment: 'Pembayaran', change_important_data: 'Ubah data penting', accept_order: 'Terima pesanan' };
const payloadView = (pl) => {
  if (!pl || typeof pl !== 'object') return '';
  const { text, ...rest } = pl;
  return html`${text ? html`<div class="pre" style="margin:6px 0;max-height:160px">${text}</div>` : ''}<div class="small mute mono">${Object.entries(rest).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' · ')}</div>`;
};

/* ---------- Approval Center ---------- */
G.route('/approvals', {
  id: 'approvals', title: 'Approval Center',
  async render(view, p, alive) {
    let st = 'open'; let type = '';
    const draw = async () => {
      const r = await G.api.get('/approvals' + G.qs({ status: st === 'all' ? '' : st, action_type: type })); if (!alive()) return;
      view.innerHTML = html`${G.pagehead('Approval Center', 'Tindakan penting AI menunggu keputusan Anda. Semua keputusan tercatat di audit log.')}
        <div class="toolbar">${[['open', 'Menunggu'], ['approved', 'Disetujui'], ['rejected', 'Ditolak'], ['all', 'Semua']].map(([k, l]) => html`<button class="btn sm ${st === k ? 'pri' : ''}" data-act="st" data-k="${k}">${l}</button>`)}
          <select id="at"><option value="">Semua jenis</option>${Object.entries(ACTION_LABEL).map(([k, l]) => html`<option value="${k}" ${type === k ? raw('selected') : ''}>${l}</option>`)}</select></div>
        ${r.items.length ? html`<div class="grid">${r.items.map((a) => html`<div class="card"><div class="row sb"><div><span class="badge vio">${ACTION_LABEL[a.action_type] || a.action_type}</span> ${G.badge(a.status)}</div><span class="small mute">${G.fmt.dt(a.created_at)} · diminta oleh ${a.requested_by_agent || a.requested_by_user || 'sistem'}</span></div>
          <h3 style="margin:10px 0 4px">${a.title}</h3>${a.description ? html`<div class="small" style="white-space:pre-wrap">${a.description}</div>` : ''}${payloadView(a.payload)}
          ${a.task_id ? html`<div class="small"><a href="#/tasks/${a.task_id}">Lihat tugas terkait →</a></div>` : ''}
          ${['pending', 'review'].includes(a.status) ? html`<div class="row" style="margin-top:12px"><button class="btn pri" data-act="dec" data-d="approve" data-id="${a.id}" ${G.can('admin') ? '' : raw('disabled')}>✔ APPROVE</button><button class="btn danger" data-act="dec" data-d="reject" data-id="${a.id}" ${G.can('admin') ? '' : raw('disabled')}>✕ REJECT</button><button class="btn" data-act="dec" data-d="review" data-id="${a.id}" ${G.can('admin') ? '' : raw('disabled')}>🔍 REVIEW</button>${G.can('admin') ? '' : html`<span class="small mute">Hanya Admin/Owner yang dapat memutuskan</span>`}</div>`
            : html`<div class="small" style="margin-top:10px">Diputuskan oleh <b>${a.decided_by_name || '-'}</b> · ${G.fmt.dt(a.decided_at)}${a.decision_note ? ' · “' + a.decision_note + '”' : ''}
              ${a.execution_result ? html`<div class="notice ${a.execution_result.executed ? 'ok' : ''}" style="margin-top:8px">${a.execution_result.executed ? '✔ Dieksekusi: ' : 'ℹ Belum dieksekusi otomatis: '}${a.execution_result.note || a.execution_result.reason || ''}</div>` : ''}</div>`}</div>`)}</div>` : html`<div class="card">${G.empty(st === 'open' ? 'Tidak ada permintaan menunggu 🎉' : 'Tidak ada data', 'Permintaan muncul saat AI/Anda mengajukan kirim pesan, penawaran, invoice, dll.')}</div>`}`.s;
      view.querySelector('#at').onchange = (e) => { type = e.target.value; draw(); };
    };
    await draw();
    G.bind(view, {
      st: (d) => { st = d.k; draw(); },
      dec: (d) => {
        const lab = { approve: 'Setujui', reject: 'Tolak', review: 'Tandai untuk ditinjau' }[d.d];
        G.formModal({ title: lab + ' permintaan', submitLabel: lab, intro: d.d === 'approve' ? 'Setelah disetujui, sistem mengeksekusi tindakan bila integrasinya tersambung; bila tidak, hasilnya dicatat apa adanya (tidak dipalsukan).' : '', fields: [{ name: 'note', label: 'Catatan (opsional)', type: 'textarea', rows: 3 }],
          onSubmit: async (v) => { const r = await G.api.post(`/approvals/${d.id}/decide`, { decision: d.d, note: v.note }); G.toast(lab + ': tercatat', r.execution_result && r.execution_result.executed === false ? 'warn' : ''); G.refreshBadges(); draw(); } });
      }
    });
  }
});

/* ---------- Automation ---------- */
const FREQ = { once: 'Sekali', minutes: 'Per N menit', hourly: 'Tiap jam', daily: 'Harian', weekly: 'Mingguan' };
G.route('/automation', {
  id: 'automation', title: 'Otomasi',
  async render(view, p, alive) {
    const [m, s, ag, U] = await Promise.all([G.api.get('/automation/monitor'), G.api.get('/schedules'), G.api.get('/agents?status=active'), G.unitOpts()]); if (!alive()) return;
    const q = m.queue;
    view.innerHTML = html`${G.pagehead('Otomasi & Pekerjaan Terjadwal', 'Jadwal membuat tugas persisten di database; worker memprosesnya dengan retry dan pencegahan ganda.', html`<button class="btn" data-act="runq">▶ Jalankan antrean</button><button class="btn pri" data-act="add" ${G.can('manager') ? '' : raw('disabled')}>＋ Jadwal</button>`)}
      <div class="grid g4 keep2" style="margin-bottom:14px">${G.stat('Antre', q.queued, m.schedules_due ? m.schedules_due + ' jadwal jatuh tempo' : '')}${G.stat('Berjalan', q.running, m.stale_running ? m.stale_running + ' menggantung' : '', m.stale_running ? 'err' : 'warn')}${G.stat('Selesai 24 jam', q.done_24h, '', 'em')}${G.stat('Gagal 24 jam', q.failed_24h, q.blocked + ' terblokir', q.failed_24h ? 'err' : '')}</div>
      <div class="notice info" style="margin-bottom:14px"><b>Cara worker berjalan di Vercel:</b> (1) tombol <b>▶ Jalankan antrean</b> / mode <b>Auto</b> di bar atas memproses tugas selama halaman dibuka; (2) Vercel Cron memanggil <span class="mono">${m.cron.vercel_cron_path}</span> (${m.cron.vercel_default_schedule}); untuk jadwal lebih sering gunakan layanan cron eksternal (mis. cron-job.org) dengan header <span class="mono">Authorization: Bearer CRON_SECRET</span>. CRON_SECRET: ${m.cron.secret_set ? html`<b class="em">terisi</b>` : html`<b class="warn">belum diisi</b>`}.</div>
      <div class="card" style="margin-bottom:14px"><h3>Jadwal (${s.items.length})</h3>${G.table([{ h: 'Jadwal', f: (x) => html`<b>${x.name}</b><div class="small mute">${x.title}</div>` }, { h: 'Karyawan', f: (x) => (x.agent_name ? `${x.agent_avatar || ''} ${x.agent_name}` : '-') }, { h: 'Frekuensi', f: (x) => FREQ[x.frequency] + (x.frequency === 'minutes' ? ' (' + x.interval_minutes + ')' : '') },
        { h: 'Berikutnya', f: (x) => (x.enabled ? G.fmt.dt(x.next_run_at) : '—') }, { h: 'Terakhir', f: (x) => (x.last_task_id ? html`<a href="#/tasks/${x.last_task_id}">${G.badge(x.last_task_status)}</a>` : '-') }, { h: 'Aktif', f: (x) => html`<input type="checkbox" data-act="toggle" data-id="${x.id}" ${x.enabled ? raw('checked') : ''} ${G.can('manager') ? '' : raw('disabled')} aria-label="Aktif">` },
        { h: '', f: (x) => html`<button class="btn sm" data-act="now" data-id="${x.id}" ${G.can('manager') ? '' : raw('disabled')}>Jalankan</button> <button class="btn sm" data-act="edit" data-id="${x.id}" ${G.can('manager') ? '' : raw('disabled')}>Ubah</button> <button class="btn sm danger" data-act="del" data-id="${x.id}" ${G.can('manager') ? '' : raw('disabled')}>Hapus</button>` }], s.items, { empty: 'Belum ada jadwal. Contoh: laporan keuangan mingguan oleh AI Finance Analyst.' })}</div>
      <div class="card"><h3>Eksekusi terbaru (log)</h3>${G.table([{ h: 'Tugas', f: (t) => html`<a href="#/tasks/${t.id}">${t.title}</a>${t.error ? html`<div class="small err">${String(t.error).slice(0, 110)}</div>` : ''}` }, { h: 'Jadwal', f: (t) => t.schedule_name || '-' }, { h: 'Karyawan', f: (t) => t.agent_name || '-' }, { h: 'Status', f: (t) => G.badge(t.status) }, { h: 'Percobaan', f: (t) => `${t.attempts}/${t.max_attempts}` }, { h: 'Dibuat', f: (t) => G.fmt.rel(t.created_at) }], m.recent, { empty: 'Belum ada eksekusi' })}</div>`.s;
    const form = (x) => G.formModal({ title: x ? 'Ubah jadwal' : 'Jadwal baru', wide: true, submitLabel: 'Simpan', values: x ? { ...x, business_unit_id: x.business_unit_id || '', interval_minutes: x.interval_minutes || '', next_run_at: x.next_run_at ? new Date(new Date(x.next_run_at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' } : { frequency: 'daily', priority: 5, max_attempts: 3, enabled: true },
      fields: [{ name: 'name', label: 'Nama jadwal', required: true }, { name: 'agent_id', label: 'Dikerjakan oleh', type: 'select', required: true, options: ag.items.map((a) => [a.id, `${a.name} — ${a.title}`]) }, { name: 'title', label: 'Judul tugas yang dibuat', required: true, full: true }, { name: 'description', label: 'Instruksi', type: 'textarea', rows: 4 },
        { name: 'frequency', label: 'Frekuensi', type: 'select', options: Object.entries(FREQ) }, { name: 'interval_minutes', label: 'Interval menit (untuk "Per N menit", min 5)', type: 'number', min: 5 }, { name: 'next_run_at', label: 'Mulai / jalan berikutnya', type: 'datetime-local' }, { name: 'business_unit_id', label: 'Unit bisnis', type: 'select', options: U.opts },
        { name: 'priority', label: 'Prioritas (1-10)', type: 'number', min: 1 }, { name: 'max_attempts', label: 'Maks. percobaan', type: 'number', min: 1 }, { name: 'enabled', label: 'Aktif', type: 'checkbox' }],
      onSubmit: async (v) => { if (!v.next_run_at) delete v.next_run_at; else v.next_run_at = new Date(v.next_run_at).toISOString(); if (x) await G.api.patch('/schedules/' + x.id, v); else await G.api.post('/schedules', v); G.toast('Jadwal disimpan'); G.render(); } });
    G.bind(view, {
      runq: (d, el) => G.runQueue(el), add: () => form(null), edit: (d) => form(s.items.find((x) => x.id === d.id)),
      toggle: async (d, el) => { await G.api.patch('/schedules/' + d.id, { enabled: el.checked }); G.toast(el.checked ? 'Jadwal diaktifkan' : 'Jadwal dinonaktifkan'); G.render(); },
      now: async (d) => { const r = await G.api.post(`/schedules/${d.id}/run-now`); G.toast(r.note); G.render(); },
      del: async (d) => { if (await G.confirm('Hapus jadwal ini?', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/schedules/' + d.id); G.toast('Jadwal dihapus'); G.render(); } }
    });
  }
});

/* ---------- Integrations & Tools ---------- */
const INT_STATUS = { CONNECTED: 'ok', CONFIGURED: 'info', 'NOT CONNECTED': 'warn', ERROR: 'err', DISABLED: '', UNSUPPORTED: '' };
G.route('/integrations', {
  id: 'integrations', title: 'Integrasi API',
  async render(view, p, alive) {
    let tab = 'integrasi';
    const draw = async () => {
      view.innerHTML = html`${G.pagehead('Integrasi API & Tools AI', 'API key HANYA disimpan sebagai environment variable di server (Vercel) — tidak pernah dikirim ke browser atau database.')}
        <div class="tabs"><button class="${tab === 'integrasi' ? 'on' : ''}" data-act="tab" data-k="integrasi">Integrasi</button><button class="${tab === 'tools' ? 'on' : ''}" data-act="tab" data-k="tools">Tools AI</button><button class="${tab === 'log' ? 'on' : ''}" data-act="tab" data-k="log">Log tool</button></div><div id="ibody"><div class="empty">Memuat…</div></div>`.s;
      const box = view.querySelector('#ibody');
      if (tab === 'integrasi') {
        const r = await G.api.get('/integrations'); if (!alive()) return; view._i = r.items;
        box.innerHTML = html`<div class="grid g2">${r.items.map((i) => html`<div class="card"><h3>${i.label} <span class="sp"></span><span class="badge ${INT_STATUS[i.status] || ''}">${i.status}</span></h3>
          <div class="small mute">${i.help}</div>
          ${i.env.length ? html`<div class="tags" style="margin:10px 0">${i.env.map((e) => html`<span title="${e.set ? 'terisi' : 'belum diisi'}">${e.set ? '✔' : '○'} ${e.name}</span>`)}</div>` : ''}
          ${i.last_test_at ? html`<div class="small">Tes terakhir: ${G.fmt.dt(i.last_test_at)} — ${G.badge(i.last_status === 'ok' ? 'success' : 'error')}${i.last_error ? html`<div class="err">${i.last_error}</div>` : ''}</div>` : ''}
          ${i.settings && i.settings.daily_call_limit ? html`<div class="small mute">Batas panggilan/hari: ${G.fmt.num(i.settings.daily_call_limit)}</div>` : ''}
          <div class="row" style="margin-top:10px"><button class="btn sm pri" data-act="test" data-k="${i.kind}" ${G.can('admin') && !i.unsupported ? '' : raw('disabled')}>Test connection</button>
            <label class="row small" style="gap:6px"><input type="checkbox" data-act="en" data-k="${i.kind}" ${i.enabled ? raw('checked') : ''} ${G.can('admin') && !i.unsupported ? '' : raw('disabled')}> Aktif</label>
            <button class="btn sm" data-act="set" data-k="${i.kind}" ${G.can('admin') && !i.unsupported ? '' : raw('disabled')}>Pengaturan penggunaan</button><button class="btn sm" data-act="how" data-k="${i.kind}">Cara menyambungkan</button></div></div>`)}</div>`.s;
      } else if (tab === 'tools') {
        const r = await G.api.get('/tools'); if (!alive()) return; view._t = r.items;
        box.innerHTML = html`<div class="card">${G.table([{ h: 'Tool', f: (t) => html`<b class="mono">${t.name}</b><div class="small mute">${t.description}</div>` }, { h: 'Izin', f: (t) => html`<span class="badge ${t.permission === 'write' ? 'warn' : 'info'}">${t.permission}</span>` }, { h: 'Agen', num: true, f: (t) => t.agents_with_access }, { h: 'Panggilan', num: true, f: (t) => `${t.calls}${t.errors ? ' · ' + t.errors + ' err' : ''}${t.denied ? ' · ' + t.denied + ' ditolak' : ''}` },
          { h: 'Status', f: (t) => html`<label class="row small" style="gap:6px"><input type="checkbox" data-act="ts" data-n="${t.name}" ${t.status === 'active' ? raw('checked') : ''} ${G.can('admin') ? '' : raw('disabled')}> ${t.status === 'active' ? 'Aktif' : 'Nonaktif'}</label>` }, { h: '', f: (t) => html`<button class="btn sm" data-act="schema" data-n="${t.name}">Skema</button>` }], r.items)}</div>`.s;
      } else {
        const r = await G.api.get('/tool-logs'); if (!alive()) return; view._l = r.items;
        box.innerHTML = html`<div class="card">${G.table([{ h: 'Waktu', f: (l) => G.fmt.dt(l.created_at) }, { h: 'Tool', f: (l) => l.tool_name }, { h: 'Oleh', f: (l) => l.agent_name || '-' }, { h: 'Status', f: (l) => G.badge(l.status) }, { h: 'Durasi', num: true, f: (l) => G.fmt.dur(l.duration_ms) }, { h: '', f: (l) => html`<button class="btn sm" data-act="log" data-id="${l.id}">Detail</button>${l.error ? html` <span class="small err">${String(l.error).slice(0, 70)}</span>` : ''}` }], r.items, { empty: 'Belum ada pemakaian tool.' })}</div>`.s;
      }
    };
    await draw();
    G.bind(view, {
      tab: (d) => { tab = d.k; draw(); },
      test: async (d) => { const r = await G.api.post(`/integrations/${d.k}/test`); G.toast(r.ok ? '✔ ' + (r.detail || 'Terhubung') : '✕ ' + r.error, r.ok ? '' : 'err'); draw(); },
      en: async (d, el) => { await G.api.patch('/integrations/' + d.k, { enabled: el.checked }); G.toast(el.checked ? 'Diaktifkan' : 'Dinonaktifkan'); draw(); },
      set: (d) => { const i = view._i.find((x) => x.kind === d.k); G.formModal({ title: 'Pengaturan penggunaan — ' + i.label, values: i.settings || {}, fields: [{ name: 'daily_call_limit', label: 'Batas panggilan per hari (0 = tanpa batas)', type: 'number', min: 0 }, { name: 'note', label: 'Catatan', full: true }], onSubmit: async (v) => { await G.api.patch('/integrations/' + d.k, { settings: v }); G.toast('Disimpan'); draw(); } }); },
      how: (d) => { const i = view._i.find((x) => x.kind === d.k); G.modal({ title: 'Menyambungkan ' + i.label, body: html`<p>${i.help}</p>${i.env.length ? html`<ol><li>Buka <b>Vercel → Project → Settings → Environment Variables</b>.</li><li>Tambahkan: ${i.env.map((e) => html`<span class="mono badge">${e.name}</span> `)}</li><li>Klik <b>Redeploy</b> agar nilai terbaca.</li><li>Kembali ke halaman ini dan klik <b>Test connection</b>.</li></ol>` : ''}<div class="notice info">Alasan keamanan: kunci tidak diketik di halaman ini supaya tidak pernah tersimpan di browser/database. Status di atas membaca environment server.</div>` }); },
      ts: async (d, el) => { await G.api.patch('/tools/' + d.n, { status: el.checked ? 'active' : 'disabled' }); G.toast('Status tool diubah'); draw(); },
      schema: (d) => { const t = view._t.find((x) => x.name === d.n); G.modal({ title: 'Skema tool: ' + t.name, wide: true, body: html`<p>${t.description}</p><h4>Input schema</h4><div class="pre">${JSON.stringify(t.input_schema, null, 2)}</div><h4 style="margin-top:10px">Output schema</h4><div class="pre">${typeof t.output_schema === 'string' ? t.output_schema : JSON.stringify(t.output_schema, null, 2)}</div>` }); },
      log: (d) => { const l = view._l.find((x) => x.id === d.id); G.modal({ title: 'Log: ' + l.tool_name, wide: true, body: html`<h4>Input</h4><div class="pre">${JSON.stringify(l.input, null, 2)}</div><h4 style="margin-top:10px">Output</h4><div class="pre">${JSON.stringify(l.output, null, 2)}</div>${l.error ? html`<div class="notice err" style="margin-top:10px">${l.error}</div>` : ''}` }); }
    });
  }
});

/* ---------- Settings ---------- */
G.route('/settings', {
  id: 'settings', title: 'Pengaturan',
  async render(view, p, alive) {
    let tab = 'umum';
    const draw = async () => {
      const tabs = [['umum', 'Umum'], ['akun', 'Akun saya'], ...(G.can('admin') ? [['pengguna', 'Pengguna'], ['audit', 'Audit log']] : [])];
      view.innerHTML = html`${G.pagehead('Pengaturan')}<div class="tabs">${tabs.map(([k, l]) => html`<button class="${tab === k ? 'on' : ''}" data-act="tab" data-k="${k}">${l}</button>`)}</div><div id="sbody"><div class="empty">Memuat…</div></div>`.s;
      const box = view.querySelector('#sbody');
      if (tab === 'umum') {
        const [s, h] = await Promise.all([G.api.get('/settings'), G.api.get('/health')]); if (!alive()) return; const w = s.workspace; const st = w.settings || {};
        box.innerHTML = html`<div class="grid split"><div class="card"><h3>Perusahaan</h3><form id="wf" class="frm" novalidate>${G.fieldHtml({ name: 'name', label: 'Nama perusahaan', required: true }, w.name)}${G.fieldHtml({ name: 'owner_name', label: 'Nama pemilik' }, st.owner_name || '')}
          ${G.fieldHtml({ name: 'usd_idr_rate', label: 'Kurs USD → IDR', type: 'number', min: 0, step: 'any', help: 'Dipakai mengonversi biaya API ke Rupiah di laporan keuangan.' }, st.usd_idr_rate || '')}${G.fieldHtml({ name: 'currency', label: 'Mata uang' }, st.currency || 'IDR')}
          <div class="full"><button class="btn pri" type="submit" ${G.can('admin') ? '' : raw('disabled')}>Simpan</button></div></form></div>
          <div class="card"><h3>Status sistem</h3><div class="list">
            <div class="item"><div class="grow">Database</div>${G.badge(h.database.connected ? 'success' : 'error', h.database.connected ? 'ok' : 'err')} <span class="small mute">${h.database.connected ? (h.database.migrated ? 'terhubung, skema terpasang' : 'skema belum terpasang') : h.database.error || 'NOT CONNECTED'}</span></div>
            <div class="item"><div class="grow">SESSION_SECRET</div>${h.session_secret ? html`<span class="badge ok">OK</span>` : html`<span class="badge err">Belum diatur</span>`}</div>
            ${Object.entries(h.integrations).map(([k, v]) => html`<div class="item"><div class="grow">${k}</div>${v ? html`<span class="badge ok">terisi</span>` : html`<span class="badge warn">NOT CONNECTED</span>`}</div>`)}</div>
            <p class="help">${s.notes.secrets}</p><p class="help">Versi ${h.version} · ${G.fmt.dt(h.time)}</p></div></div>`.s;
        box.querySelector('#wf').addEventListener('submit', async (e) => { e.preventDefault(); const f = e.target; const body = { name: f.name.value, owner_name: f.owner_name.value, currency: f.currency.value }; if (f.usd_idr_rate.value !== '') body.usd_idr_rate = Number(f.usd_idr_rate.value); await G.guard(() => G.api.patch('/settings', body), 'Pengaturan disimpan'); });
      } else if (tab === 'akun') {
        const u = G.state.user;
        box.innerHTML = html`<div class="card" style="max-width:520px"><h3>${u.name}</h3><div class="small mute">${u.email} · ${G.roleLabel[u.role] || u.role}</div><form id="pf" class="col" style="margin-top:12px" novalidate><label class="f"><span>Kata sandi saat ini</span><input name="current" type="password" autocomplete="current-password" required></label>
          <label class="f"><span>Kata sandi baru (min. 10 karakter, huruf & angka)</span><input name="next" type="password" autocomplete="new-password" required></label><div id="perr" class="notice err" hidden></div><button class="btn pri" type="submit">Ganti kata sandi</button></form></div>`.s;
        box.querySelector('#pf').addEventListener('submit', async (e) => { e.preventDefault(); const f = e.target; const er = box.querySelector('#perr'); er.hidden = true; try { await G.api.post('/auth/password', { current: f.current.value, next: f.next.value }); G.toast('Kata sandi diganti. Sesi lain dikeluarkan.'); f.reset(); } catch (x) { er.textContent = G.errText(x); er.hidden = false; } });
      } else if (tab === 'pengguna') {
        const r = await G.api.get('/users'); if (!alive()) return; view._u = r.items;
        box.innerHTML = html`<div class="card"><h3>Pengguna tim <span class="sp"></span><button class="btn sm pri" data-act="adduser">＋ Pengguna</button></h3>${G.table([{ h: 'Nama', f: (u) => html`<b>${u.name}</b><div class="small mute">${u.email}</div>` }, { h: 'Peran', f: (u) => html`<span class="badge ${u.role === 'owner' ? 'ok' : ''}">${G.roleLabel[u.role]}</span>` }, { h: 'Status', f: (u) => G.badge(u.active ? 'active' : 'inactive') }, { h: 'Login terakhir', f: (u) => (u.last_login_at ? G.fmt.rel(u.last_login_at) : '-') },
          { h: '', f: (u) => (u.role === 'owner' ? '' : html`<button class="btn sm" data-act="edituser" data-id="${u.id}">Ubah</button>`) }], r.items)}<p class="help">Owner = administrator utama. Admin dapat menyetujui tindakan; Manajer menjalankan pekerjaan; Pembaca hanya melihat.</p></div>`.s;
      } else {
        const r = await G.api.get('/audit'); if (!alive()) return;
        box.innerHTML = html`<div class="card"><h3>Audit log (200 terbaru)</h3>${G.table([{ h: 'Waktu', f: (l) => G.fmt.dt(l.created_at) }, { h: 'Aksi', f: (l) => html`<span class="mono">${l.action}</span>` }, { h: 'Oleh', f: (l) => l.user_name || l.agent_name || 'sistem' }, { h: 'Objek', f: (l) => `${l.entity || ''} ${l.entity_id ? String(l.entity_id).slice(0, 8) : ''}` }, { h: 'IP', f: (l) => l.ip || '-' }, { h: 'Detail', f: (l) => html`<span class="small mute mono">${l.details && Object.keys(l.details).length ? JSON.stringify(l.details).slice(0, 90) : ''}</span>` }], r.items, { empty: 'Belum ada log' })}</div>`.s;
      }
    };
    await draw();
    const uform = (u) => G.formModal({ title: u ? 'Ubah pengguna' : 'Pengguna baru', values: u || { role: 'manager' }, submitLabel: 'Simpan',
      fields: [{ name: 'name', label: 'Nama', required: true }, ...(u ? [] : [{ name: 'email', label: 'Email', type: 'email', required: true }]), { name: 'role', label: 'Peran', type: 'select', options: [['viewer', 'Pembaca'], ['manager', 'Manajer'], ...(G.can('owner') ? [['admin', 'Admin']] : [])] },
        { name: 'password', label: u ? 'Kata sandi baru (kosongkan bila tidak diganti)' : 'Kata sandi awal (min. 10, huruf & angka)', type: 'password', required: !u }, ...(u ? [{ name: 'active', label: 'Akun aktif', type: 'checkbox' }] : [])],
      onSubmit: async (v) => { if (u) { if (!v.password) delete v.password; await G.api.patch('/users/' + u.id, v); } else await G.api.post('/users', v); G.toast('Pengguna disimpan'); draw(); } });
    G.bind(view, { tab: (d) => { tab = d.k; draw(); }, adduser: () => uform(null), edituser: (d) => uform(view._u.find((x) => x.id === d.id)) });
  }
});
