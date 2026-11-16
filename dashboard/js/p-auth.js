'use strict';
/* Halaman 1 (Login) + setup awal + kerangka aplikasi (sidebar/topbar) + halaman 2 (Dashboard). */
const LOGO = '<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#0f1f3f"/><path d="M32 12 50 22v20L32 52 14 42V22z" fill="none" stroke="#10b981" stroke-width="4" stroke-linejoin="round"/><circle cx="32" cy="32" r="6" fill="#10b981"/></svg>';
G.LOGO = LOGO;
const $app = () => document.getElementById('app');

/* ---------- Login & setup ---------- */
G.showLogin = async () => {
  G.clearTimers(); G.stopAuto && G.stopAuto();
  let st = null; try { st = await G.api.get('/setup/status'); } catch (e) { st = { error: G.errText(e) }; }
  document.getElementById('boot').hidden = true; $app().hidden = false;
  if (st && st.error && !st.database_configured && st.database_configured !== false) { /* tetap tampilkan login dengan peringatan */ }
  if (st && st.has_owner === false) return G.showSetup(st);
  $app().innerHTML = html`<div class="authwrap"><div class="card authcard">
    ${raw(LOGO)}<h2>GERDEV AI WORKFORCE</h2><p class="mute">Platform perusahaan virtual dengan karyawan AI. Masuk sebagai Owner/anggota tim.</p>
    ${st && (!st.database_connected || !st.migrated) ? html`<div class="notice" style="margin:10px 0">⚠ ${!st.database_configured ? 'DATABASE_URL belum diisi (NOT CONNECTED).' : !st.database_connected ? 'Database belum terhubung: ' + (st.error || '') : 'Skema database belum terpasang.'}</div>` : ''}
    <form id="lf" class="col" style="margin-top:12px" novalidate>
      <label class="f"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
      <label class="f"><span>Kata sandi</span><input name="password" type="password" autocomplete="current-password" required></label>
      <div id="lerr" class="notice err" hidden></div>
      <button class="btn pri" type="submit" style="justify-content:center">Masuk</button>
    </form></div></div>`.s;
  const f = document.getElementById('lf'), err = document.getElementById('lerr');
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!f.reportValidity()) return; err.hidden = true;
    const b = f.querySelector('button'); b.disabled = true;
    try { const r = await G.api.post('/auth/login', { email: f.email.value, password: f.password.value }); G.state.csrf = r.csrf_token; await G.boot(); }
    catch (x) { err.textContent = G.errText(x); err.hidden = false; b.disabled = false; }
  });
};

G.showSetup = (st) => {
  const ok = (v) => html`<span class="dot ${v ? 'ok' : 'bad'}">${v ? '✓' : '✕'}</span>`;
  const ready = st.database_connected && st.migrated && st.session_secret_ok;
  $app().innerHTML = html`<div class="authwrap"><div class="card authcard" style="width:min(560px,100%)">
    ${raw(LOGO)}<h2>Instalasi Awal</h2><p class="mute">Belum ada Owner. Selesaikan langkah berikut (semua dilakukan dari browser, tanpa terminal).</p>
    <div class="steps">
      <div class="step">${ok(st.session_secret_ok)} <span>SESSION_SECRET terisi (≥ 32 karakter)</span></div>
      <div class="step">${ok(st.database_configured)} <span>DATABASE_URL terisi</span></div>
      <div class="step">${ok(st.database_connected)} <span>Database terhubung ${st.error ? html`<span class="err small">— ${st.error}</span>` : ''}</span></div>
      <div class="step">${ok(st.migrated)} <span>Skema database terpasang</span></div>
    </div>
    ${!st.session_secret_ok || !st.database_configured || !st.database_connected ? html`<div class="notice">Isi environment variable di Vercel (Settings → Environment Variables), lalu <b>Redeploy</b> dan muat ulang halaman ini. Panduan lengkap ada di README.</div>` : ''}
    <form id="sf" class="frm" style="margin-top:14px" novalidate ${ready || st.database_connected ? '' : raw('hidden')}>
      <label class="f full"><span>Kunci setup (isi dengan nilai SESSION_SECRET Anda)</span><input name="setup_key" type="password" required autocomplete="off"></label>
      ${st.database_connected && !st.migrated ? html`<div class="full"><button type="button" class="btn" id="mig">1) Pasang skema database</button><div class="help">Alternatif: jalankan database/schema.sql di Neon SQL Editor.</div></div>` : ''}
      ${st.migrated ? html`
      <label class="f full"><span>Nama perusahaan</span><input name="workspace_name" value="GERDEV" required></label>
      <label class="f"><span>Nama Owner</span><input name="name" value="Gerdy Hendraman" required></label>
      <label class="f"><span>Email Owner</span><input name="email" type="email" required autocomplete="username"></label>
      <label class="f full"><span>Kata sandi (min. 10 karakter, huruf & angka)</span><input name="password" type="password" required autocomplete="new-password"></label>
      <button class="btn pri full" type="submit" style="justify-content:center">2) Buat Owner &amp; isi 12 karyawan AI</button>` : ''}
      <div id="serr" class="notice err full" hidden></div>
    </form></div></div>`.s;
  const f = document.getElementById('sf'), err = document.getElementById('serr'); if (!f) return;
  const show = (m) => { err.textContent = m; err.hidden = false; };
  const mig = document.getElementById('mig');
  if (mig) mig.onclick = async () => {
    err.hidden = true; if (!f.setup_key.value) return show('Isi kunci setup terlebih dahulu');
    mig.disabled = true;
    try { await G.api.post('/setup/migrate', { setup_key: f.setup_key.value }); G.toast('Skema terpasang'); G.showLogin(); } catch (e) { show(G.errText(e)); mig.disabled = false; }
  };
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!f.reportValidity()) return; err.hidden = true;
    const b = f.querySelector('button[type=submit]'); b.disabled = true;
    try {
      const r = await G.api.post('/setup/owner', { setup_key: f.setup_key.value, workspace_name: f.workspace_name.value, name: f.name.value, email: f.email.value, password: f.password.value });
      G.state.csrf = r.csrf_token; G.toast('Owner dibuat. Selamat datang!'); await G.boot();
    } catch (x) { show(G.errText(x)); b.disabled = false; }
  });
};

/* ---------- Kerangka aplikasi ---------- */
const MENU = [
  ['Utama', [['dashboard', '📊', 'Dashboard'], ['approvals', '✅', 'Approval Center']]],
  ['Karyawan AI', [['employees', '🤖', 'AI Employees'], ['departments', '🏢', 'Departemen'], ['tasks', '📋', 'Task Center'], ['comm', '💬', 'AI Communication']]],
  ['Bisnis', [['units', '🏪', 'Unit Bisnis'], ['crm', '🎯', 'CRM'], ['products', '🏷️', 'Produk'], ['orders', '🧾', 'Pesanan']]],
  ['Keuangan', [['finance', '💰', 'Keuangan'], ['usage', '⚡', 'Penggunaan AI']]],
  ['Sistem', [['automation', '⏱️', 'Otomasi'], ['integrations', '🔌', 'Integrasi API'], ['settings', '⚙️', 'Pengaturan']]]
];
const BOTTOM = ['dashboard', 'tasks', 'approvals', 'employees'];

G.showApp = () => {
  document.getElementById('boot').hidden = true; $app().hidden = false;
  const u = G.state.user;
  const collapsed = (() => { try { return localStorage.getItem('gerdev.collapsed') === '1'; } catch { return false; } })();
  $app().innerHTML = html`<div class="shell ${collapsed ? 'collapsed' : ''}">
    <aside class="side" id="side"><div class="brand">${raw(LOGO)}<div class="bt">GERDEV<small>AI WORKFORCE</small></div></div>
      <nav class="nav">${MENU.map(([g, items]) => html`<div class="grp">${g}</div>${items.map(([id, ic, lb]) => html`<a href="#/${id}" data-id="${id}" title="${lb}"><span class="ic">${ic}</span><span class="lbl">${lb}</span>${id === 'approvals' ? html`<span class="badge nbadge" id="apbadge" hidden></span>` : ''}</a>`)}`)}</nav>
      <div style="margin-top:auto;padding:12px 16px" class="small mute lbl">${G.state.workspace ? G.state.workspace.name : ''}<br>v1.0.0</div></aside>
    <div class="scrim" id="scrim"></div>
    <div class="main"><header class="top">
      <button class="iconbtn" id="burger" aria-label="Buka/tutup sidebar">☰</button>
      <h1 id="pagetitle"></h1>
      <label class="small mute row hide-m" title="Jalankan antrean otomatis tiap 30 detik selama halaman ini terbuka" style="gap:6px"><input type="checkbox" id="autorun"> Auto</label>
      <button class="btn sm" id="runq" ${G.can('manager') ? '' : raw('disabled')} title="Proses tugas yang antre sekarang">▶ <span class="hide-m">Jalankan antrean</span></button>
      <div class="hide-m small" style="text-align:right;line-height:1.2"><b>${u.name}</b><br><span class="mute">${G.roleLabel[u.role] || u.role}</span></div>
      <button class="iconbtn" id="logout" title="Keluar" aria-label="Keluar">⎋</button></header>
      <main class="view" id="view"></main></div>
    <nav class="bottomnav">${BOTTOM.map((id) => { const it = MENU.flatMap((m) => m[1]).find((x) => x[0] === id); return html`<a href="#/${id}" data-id="${id}"><span class="ic">${it[1]}</span>${it[2].replace('AI ', '')}</a>`; })}<a href="#" id="morebtn"><span class="ic">☰</span>Menu</a></nav>
  </div>`.s;
  const shell = document.querySelector('.shell');
  document.getElementById('burger').onclick = () => {
    if (window.innerWidth <= 900) shell.classList.toggle('open');
    else { shell.classList.toggle('collapsed'); try { localStorage.setItem('gerdev.collapsed', shell.classList.contains('collapsed') ? '1' : '0'); } catch { /* abaikan */ } }
  };
  document.getElementById('scrim').onclick = () => shell.classList.remove('open');
  document.getElementById('morebtn').onclick = (e) => { e.preventDefault(); shell.classList.toggle('open'); };
  document.getElementById('logout').onclick = async () => { await G.guard(() => G.api.post('/auth/logout')); G.state.user = null; G.state.csrf = null; location.hash = ''; G.showLogin(); };
  document.getElementById('runq').onclick = (e) => G.runQueue(e.currentTarget);
  const ar = document.getElementById('autorun'); try { ar.checked = localStorage.getItem('gerdev.auto') === '1'; } catch { /* abaikan */ }
  ar.onchange = () => { try { localStorage.setItem('gerdev.auto', ar.checked ? '1' : '0'); } catch { /* abaikan */ } ar.checked ? G.startAuto() : G.stopAuto(); };
  if (ar.checked && G.can('manager')) G.startAuto();
  G.refreshBadges(); clearInterval(G._bt); G._bt = setInterval(G.refreshBadges, 45000);
  G.render();
};

G.refreshBadges = async () => {
  if (!G.state.user) return;
  try {
    const r = await G.api.get('/approvals?status=open'); const n = r.items.length; G.state.counts.approvals = n;
    const b = document.getElementById('apbadge'); if (b) { b.hidden = !n; b.textContent = n; }
  } catch { /* abaikan */ }
};

/* ---------- Worker (jalankan antrean) ---------- */
let ticking = false;
G.runQueue = async (btn, silent) => {
  if (ticking) return; ticking = true; if (btn) btn.disabled = true;
  try {
    const r = await G.api.post('/worker/tick');
    const n = r.processed.length;
    if (!silent || n) G.toast(n ? `${n} tugas diproses${r.remaining.queued ? ' · sisa antre ' + r.remaining.queued : ''}` : 'Antrean kosong', n ? '' : '');
    if (n || r.schedulesCreated) { G.refreshBadges(); if (!document.querySelector('.modal-bg')) G.render(); }
  } catch (e) { G.toast(G.errText(e), 'err'); }
  finally { ticking = false; if (btn) btn.disabled = !G.can('manager'); }
};
G.startAuto = () => { G.stopAuto(); G._auto = setInterval(async () => { try { const s = await G.api.get('/worker/status'); if (s.queued > 0 && !ticking) await G.runQueue(null, true); } catch { /* abaikan */ } }, 30000); };
G.stopAuto = () => { clearInterval(G._auto); G._auto = null; };

/* ---------- Halaman 2: Dashboard ---------- */
G.route('/dashboard', {
  id: 'dashboard', title: 'Dashboard',
  async render(view, p, alive) {
    const d = await G.api.get('/dashboard'); if (!alive()) return;
    const f = d.finance;
    view.innerHTML = html`
      ${G.pagehead('Dashboard Perusahaan', 'Semua angka dihitung langsung dari database. Omzet hanya dari transaksi pemasukan yang tercatat.', html`<button class="btn sm" data-act="refresh">↻ Segarkan</button>`)}
      ${!d.ai_connected ? html`<div style="margin-bottom:14px">${G.notConnected('API AI belum tersambung. Karyawan AI tidak bisa bekerja sampai OPENAI_API_KEY (atau model alternatif) diisi — lihat halaman Integrasi API.')}</div>` : ''}
      ${d.approvals.pending ? html`<div class="notice info" style="margin-bottom:14px">🔔 ${d.approvals.pending} permintaan menunggu persetujuan Anda. <a href="#/approvals">Buka Approval Center →</a></div>` : ''}
      <div class="grid g4 keep2" style="margin-bottom:14px">
        ${G.stat('Total karyawan AI', d.agents.total, 'terdaftar')}
        ${G.stat('Karyawan AI aktif', d.agents.active, `dari ${d.agents.total}`, 'em')}
        ${G.stat('Pekerjaan berjalan', d.tasks.running, `${d.tasks.queued} antre${d.tasks.review ? ' · ' + d.tasks.review + ' tinjauan' : ''}`, 'warn')}
        ${G.stat('Pekerjaan selesai', d.tasks.done, d.tasks.problem ? d.tasks.problem + ' gagal/terblokir' : 'tanpa masalah', 'em')}
        ${G.stat('Total prospek', d.leads.total, d.leads.verified + ' terverifikasi')}
        ${G.stat('Total pelanggan', d.customers.total)}
        ${G.stat('Pesanan masuk', d.orders.total, d.orders.active + ' sedang dikerjakan')}
        ${G.stat('Total omzet', G.fmt.idr(f.revenue), 'pemasukan tercatat', 'em')}
        ${G.stat('Total pengeluaran', G.fmt.idr(f.total_expense), `termasuk biaya API ${G.fmt.idr(f.api_cost_idr)}`)}
        ${G.stat('Keuntungan bersih', G.fmt.idr(f.net), f.note || '', f.net < 0 ? 'err' : 'em')}
      </div>
      <div class="grid dash2">
        <div class="card"><h3>Aktivitas perusahaan (14 hari)</h3>
          ${G.chart({ labels: d.series.map((x) => G.fmt.day(x.day)), type: 'bar', series: [{ name: 'Tugas dibuat', data: d.series.map((x) => x.tasks_created) }, { name: 'Tugas selesai', data: d.series.map((x) => x.tasks_done) }, { name: 'Eksekusi AI', data: d.series.map((x) => x.runs) }] })}</div>
        <div class="card"><h3>Aktivitas terbaru seluruh AI</h3>
          ${d.activity.length ? html`<div class="list">${d.activity.map((a) => html`<div class="item">${G.avatar(a, 'sm')}<div class="grow"><div><b>${a.agent_name}</b> ${G.badge(a.status)} <span class="mute small">${a.phase}</span></div>
            <div class="small">${a.task_id ? html`<a href="#/tasks/${a.task_id}">${a.task_title || 'tugas'}</a>` : (a.task_title || '')}</div>${a.error ? html`<div class="small err">${String(a.error).slice(0, 120)}</div>` : ''}
            <div class="small mute">${G.fmt.rel(a.started_at)} · ${G.fmt.dur(a.duration_ms)} · ${G.fmt.usd(a.cost_usd)}</div></div></div>`)}</div>` : G.empty('Belum ada aktivitas', 'Berikan target pertama di Task Center — AI CEO akan membaginya ke tim.')}</div>
      </div>
      <div class="card" style="margin-top:14px"><div class="row sb"><div><h3 style="margin:0">Mulai bekerja</h3><div class="mute small">Berikan target bisnis ke AI CEO; ia membagi ke manajer → pekerja → QA → Anda.</div></div>
        <a class="btn pri" href="#/tasks">＋ Beri target baru</a></div></div>`.s;
    G.bind(view, { refresh: () => G.render() });
  }
});
