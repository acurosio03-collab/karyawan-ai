'use strict';
/* Inti frontend: API client, templating aman (auto-escape), router, modal, form, toast, grafik SVG, format. Tanpa library eksternal (CSP: script-src 'self'). */
const G = (window.G = { pages: {}, state: { user: null, csrf: null, workspace: null, counts: {} }, nav: [] });

/* ---------- templating aman ---------- */
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const one = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(one).join('') : v === false || v == null ? '' : esc(v));
function html(strings, ...vals) { let o = ''; strings.forEach((s, i) => { o += s; if (i < vals.length) o += one(vals[i]); }); return new Raw(o); }
Object.assign(window, { Raw, raw, esc, html });

/* ---------- format ---------- */
const nf = new Intl.NumberFormat('id-ID');
G.fmt = {
  idr: (n) => 'Rp ' + nf.format(Math.round(Number(n) || 0)),
  num: (n, d = 0) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: d }).format(Number(n) || 0),
  usd: (n) => '$' + (Number(n) || 0).toFixed(Number(n) >= 1 ? 2 : 4),
  date: (d) => (d ? new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'),
  dt: (d) => (d ? new Date(d).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'),
  rel(d) {
    if (!d) return '-';
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 0) return G.fmt.dt(d);
    if (s < 60) return 'baru saja';
    if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
    if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' hari lalu';
    return G.fmt.date(d);
  },
  dur: (ms) => (ms == null ? '-' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' dtk'),
  day: (s) => { const d = new Date(s + 'T00:00:00'); return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }); },
  dateInput: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '')
};

/* ---------- label & warna status ---------- */
const ST = {
  queued: ['Antre', ''], running: ['Berjalan', 'info'], pending_deps: ['Menunggu dependensi', 'vio'], waiting_children: ['Menunggu sub-tugas', 'vio'], in_qa: ['Pemeriksaan QA', 'vio'],
  review: ['Tinjauan Owner', 'warn'], done: ['Selesai', 'ok'], failed: ['Gagal', 'err'], blocked: ['Terblokir', 'err'], cancelled: ['Dibatalkan', ''],
  succeeded: ['Berhasil', 'ok'], timeout: ['Timeout', 'err'], error: ['Error', 'err'], success: ['Sukses', 'ok'], denied: ['Ditolak', 'warn'],
  pending: ['Menunggu', 'warn'], approved: ['Disetujui', 'ok'], rejected: ['Ditolak', 'err'], executed: ['Dieksekusi', 'ok'], execution_failed: ['Eksekusi gagal', 'err'],
  active: ['Aktif', 'ok'], inactive: ['Nonaktif', ''], disabled: ['Nonaktif', ''],
  draft: ['Draft', ''], confirmed: ['Dikonfirmasi', 'info'], in_progress: ['Dikerjakan', 'info'], completed: ['Selesai', 'ok'],
  unpaid: ['Belum bayar', 'warn'], partial: ['Sebagian', 'info'], paid: ['Lunas', 'ok'], refunded: ['Dikembalikan', ''],
  issued: ['Terbit', 'ok'], void: ['Batal', ''], sent: ['Terkirim', 'info'], accepted: ['Diterima', 'ok'], pass: ['Lolos', 'ok'], fail: ['Gagal QA', 'err'],
  baru: ['Baru', 'info'], dihubungi: ['Dihubungi', 'info'], tertarik: ['Tertarik', 'vio'], penawaran: ['Penawaran', 'vio'], negosiasi: ['Negosiasi', 'warn'], menang: ['Menang', 'ok'], kalah: ['Kalah', 'err'], tidak_cocok: ['Tidak cocok', ''],
  income: ['Pemasukan', 'ok'], expense: ['Pengeluaran', 'err'], review_: ['Ditinjau', 'info']
};
G.badge = (s, kind) => { const t = ST[s] || [String(s == null ? '-' : s), '']; return html`<span class="badge ${kind || t[1]}">${t[0]}</span>`; };
G.stLabel = (s) => (ST[s] ? ST[s][0] : s);
G.ST = ST;

/* ---------- API ---------- */
class ApiError extends Error { constructor(status, body) { super((body && body.error) || 'Permintaan gagal (' + status + ')'); this.status = status; this.body = body || {}; this.errors = body && body.errors; } }
async function api(method, path, body) {
  const h = { Accept: 'application/json' };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (G.state.csrf && method !== 'GET') h['X-CSRF-Token'] = G.state.csrf;
  let r;
  try { r = await fetch('/api' + path, { method, headers: h, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new ApiError(0, { error: 'Tidak dapat menghubungi server. Periksa koneksi internet.' }); }
  let j = null; try { j = await r.json(); } catch { /* bukan JSON */ }
  if (r.status === 401 && G.state.user) { G.state.user = null; G.showLogin && G.showLogin(); }
  if (!r.ok) throw new ApiError(r.status, j);
  return j;
}
G.api = { get: (p) => api('GET', p), post: (p, b) => api('POST', p, b === undefined ? {} : b), patch: (p, b) => api('PATCH', p, b), del: (p) => api('DELETE', p) };
G.qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };
G.errText = (e) => (e && e.errors ? Object.entries(e.errors).map(([k, v]) => k + ' ' + v).join('; ') : (e && e.message) || 'Terjadi kesalahan');

/* ---------- peran ---------- */
const RANK = { viewer: 1, manager: 2, admin: 3, owner: 4 };
G.can = (min) => !!G.state.user && (RANK[G.state.user.role] || 0) >= RANK[min];
G.roleLabel = { owner: 'Owner', admin: 'Admin', manager: 'Manajer', viewer: 'Pembaca' };

/* ---------- toast ---------- */
G.toast = (msg, kind = '') => {
  const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3800);
};
G.guard = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) G.toast(okMsg); return r; } catch (e) { G.toast(G.errText(e), 'err'); return undefined; } };

/* ---------- modal ---------- */
G.modal = ({ title, body, footer, wide, onClose }) => {
  const root = document.getElementById('modal-root');
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}"><header><h3>${title}</h3><button class="iconbtn" data-x aria-label="Tutup">✕</button></header><div class="body">${body}</div>${footer ? html`<footer>${footer}</footer>` : ''}</div>`.s;
  const close = () => { bg.remove(); document.removeEventListener('keydown', key); onClose && onClose(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.querySelector('[data-x]').onclick = close;
  document.addEventListener('keydown', key);
  root.appendChild(bg);
  const first = bg.querySelector('input,select,textarea'); if (first) first.focus();
  return { el: bg, close, body: bg.querySelector('.body'), footer: bg.querySelector('footer') };
};
G.confirm = (message, { okLabel = 'Ya, lanjutkan', danger = false, title = 'Konfirmasi' } = {}) => new Promise((res) => {
  let done = false;
  const m = G.modal({ title, body: html`<p>${message}</p>`, footer: html`<button class="btn" data-n>Batal</button><button class="btn ${danger ? 'danger' : 'pri'}" data-y>${okLabel}</button>`, onClose: () => { if (!done) res(false); } });
  m.el.querySelector('[data-n]').onclick = () => { done = true; m.close(); res(false); };
  m.el.querySelector('[data-y]').onclick = () => { done = true; m.close(); res(true); };
});

/* ---------- form ---------- */
function fieldHtml(f, v) {
  const id = 'f_' + f.name; const req = f.required ? ' required' : ''; const cls = f.full || f.type === 'textarea' || f.type === 'checks' || f.type === 'items' ? ' full' : '';
  if (f.type === 'checkbox') return html`<label class="f chk${cls}"><input type="checkbox" name="${f.name}" ${v ? raw('checked') : ''}> ${f.label}</label>`;
  let input;
  if (f.type === 'textarea') input = html`<textarea id="${id}" name="${f.name}" rows="${f.rows || 4}" placeholder="${f.placeholder || ''}"${raw(req)}>${v == null ? '' : v}</textarea>`;
  else if (f.type === 'select') input = html`<select id="${id}" name="${f.name}"${raw(req)}>${(f.options || []).map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return html`<option value="${val}" ${String(v == null ? '' : v) === String(val) ? raw('selected') : ''}>${lab}</option>`; })}</select>`;
  else if (f.type === 'checks') { const cur = new Set(v || []); input = html`<div class="checks">${(f.options || []).map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return html`<label><input type="checkbox" data-group="${f.name}" value="${val}" ${cur.has(val) ? raw('checked') : ''}> ${lab}</label>`; })}</div>`; }
  else if (f.type === 'tags') input = html`<input id="${id}" name="${f.name}" value="${Array.isArray(v) ? v.join(', ') : v || ''}" placeholder="${f.placeholder || 'pisahkan dengan koma'}">`;
  else input = html`<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${v == null ? '' : v}" placeholder="${f.placeholder || ''}" ${f.step ? raw('step="' + esc(f.step) + '"') : ''} ${f.min != null ? raw('min="' + esc(f.min) + '"') : ''} autocomplete="off"${raw(req)}>`;
  return html`<label class="f${cls}"><span>${f.label}${f.required ? ' *' : ''}</span>${input}${f.help ? html`<span class="help">${f.help}</span>` : ''}</label>`;
}
G.fieldHtml = fieldHtml;
function readForm(form, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'checkbox') out[f.name] = form.elements[f.name].checked;
    else if (f.type === 'checks') out[f.name] = [...form.querySelectorAll(`[data-group="${f.name}"]:checked`)].map((x) => x.value);
    else if (f.type === 'tags') out[f.name] = form.elements[f.name].value.split(',').map((x) => x.trim()).filter(Boolean);
    else if (f.type === 'number') { const x = form.elements[f.name].value; out[f.name] = x === '' ? '' : Number(x); }
    else out[f.name] = form.elements[f.name].value;
  }
  return out;
}
/* formModal: onSubmit(values) boleh melempar error -> ditampilkan di dalam modal, modal tetap terbuka */
G.formModal = ({ title, fields, values = {}, submitLabel = 'Simpan', onSubmit, intro, wide }) => {
  const body = html`${intro ? html`<p class="mute">${intro}</p>` : ''}<form id="mform" class="frm" novalidate>${fields.map((f) => fieldHtml(f, values[f.name]))}</form><div id="merr" class="notice err" hidden style="margin-top:12px"></div>`;
  const m = G.modal({ title, body, wide, footer: html`<button class="btn" data-n>Batal</button><button class="btn pri" data-s>${submitLabel}</button>` });
  const form = m.el.querySelector('#mform'); const err = m.el.querySelector('#merr'); const btn = m.el.querySelector('[data-s]');
  const submit = async () => {
    if (!form.reportValidity()) return;
    btn.disabled = true; err.hidden = true;
    try { await onSubmit(readForm(form, fields)); m.close(); }
    catch (e) { err.textContent = G.errText(e); err.hidden = false; btn.disabled = false; }
  };
  btn.onclick = submit; m.el.querySelector('[data-n]').onclick = m.close;
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  return m;
};

/* ---------- komponen kecil ---------- */
G.avatar = (a, cls = '') => html`<div class="avatar ${cls}">${(a && a.avatar) || (a && a.agent_avatar) || '🤖'}</div>`;
G.empty = (title, text) => html`<div class="empty"><b>${title}</b>${text || ''}</div>`;
G.table = (cols, rows, { empty = 'Belum ada data' } = {}) => {
  if (!rows.length) return G.empty(empty);
  return html`<div class="tablewrap"><table><thead><tr>${cols.map((c) => html`<th class="${c.num ? 'num' : ''}">${c.h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr ${r.__attr ? raw(r.__attr) : ''}>${cols.map((c) => html`<td class="${c.num ? 'num' : ''}">${c.f(r)}</td>`)}</tr>`)}</tbody></table></div>`;
};
G.stat = (k, v, s, cls = '') => html`<div class="card stat ${cls}"><span class="k">${k}</span><span class="v">${v}</span>${s ? html`<span class="s">${s}</span>` : ''}</div>`;
G.pagehead = (title, sub, actions) => html`<div class="pagehead"><h2>${title}</h2>${actions || ''}${sub ? html`<p>${sub}</p>` : ''}</div>`;
G.notConnected = (msg) => html`<div class="notice">⚠ <b>NOT CONNECTED</b> — ${msg}</div>`;
G.pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);

/* ---------- delegasi klik: elemen [data-act] ---------- */
G.bind = (root, handlers) => {
  root._h = handlers; // handler halaman terbaru menggantikan yang lama (listener hanya dipasang sekali per elemen)
  if (root._bound) return; root._bound = true;
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]'); if (!el || !root.contains(el)) return;
    const fn = root._h && root._h[el.dataset.act]; if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    if (el.dataset.busy) return;
    el.dataset.busy = '1'; if (el.tagName === 'BUTTON') el.disabled = true;
    try { await fn(el.dataset, el, e); } catch (err) { G.toast(G.errText(err), 'err'); }
    finally { delete el.dataset.busy; if (el.tagName === 'BUTTON' && el.isConnected) el.disabled = false; }
  });
};

/* ---------- grafik SVG ---------- */
const COL = ['#10b981', '#38bdf8', '#f59e0b', '#a78bfa', '#ef4444'];
G.COL = COL;
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
/* series: [{name, color, data:[n]}], labels: [string] ; type: 'line' | 'bar' */
G.chart = ({ labels, series, type = 'line', height = 220, fmt = (n) => G.fmt.num(n) }) => {
  const W = 640, H = height, L = 52, R = 10, T = 12, B = 26; const iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.data)));
  const n = labels.length; if (!n) return G.empty('Belum ada data');
  const x = (i) => L + (n === 1 ? iw / 2 : (i * iw) / (n - 1)); const y = (v) => T + ih - (v / max) * ih;
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = (max * i) / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#1d2c4f" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#8a99b8">${esc(fmt(v))}</text>`; }
  const step = Math.ceil(n / 7);
  labels.forEach((lb, i) => { if (i % step === 0 || i === n - 1) g += `<text x="${type === 'bar' ? L + (i + 0.5) * (iw / n) : x(i)}" y="${H - 7}" text-anchor="middle" font-size="10" fill="#8a99b8">${esc(lb)}</text>`; });
  if (type === 'bar') {
    const gw = iw / n; const bw = Math.max(2, Math.min(28, (gw * 0.8) / series.length));
    series.forEach((s, si) => s.data.forEach((v, i) => { const bx = L + i * gw + (gw - bw * series.length) / 2 + si * bw; const bh = ih - (y(v) - T); g += `<rect x="${bx}" y="${y(v)}" width="${bw - 1}" height="${Math.max(0, bh)}" rx="2" fill="${s.color || COL[si]}"><title>${esc(s.name)} ${esc(labels[i])}: ${esc(fmt(v))}</title></rect>`; }));
  } else {
    series.forEach((s, si) => {
      const c = s.color || COL[si]; const pts = s.data.map((v, i) => `${x(i)},${y(v)}`);
      g += `<polyline fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round" points="${pts.join(' ')}"/>`;
      if (si === 0 && n > 1) g += `<polygon fill="${c}" opacity=".08" points="${L},${T + ih} ${pts.join(' ')} ${x(n - 1)},${T + ih}"/>`;
      s.data.forEach((v, i) => { g += `<circle cx="${x(i)}" cy="${y(v)}" r="${n > 20 ? 1.8 : 3}" fill="${c}"><title>${esc(s.name)} ${esc(labels[i])}: ${esc(fmt(v))}</title></circle>`; });
    });
  }
  const legend = series.length > 1 || series[0].name ? `<div class="legend">${series.map((s, i) => `<span><i style="background:${s.color || COL[i]}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="grafik">${g}</svg>${legend}`);
};

/* ---------- router berbasis hash ---------- */
G.route = (pattern, def) => { const keys = []; const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'); G.nav.push({ re, keys, ...def }); };
G.go = (h) => { if (location.hash === '#' + h) G.render(); else location.hash = h; };
G.timers = [];
G.clearTimers = () => { G.timers.forEach(clearInterval); G.timers = []; };
G.current = null;
G.render = async () => {
  const view = document.getElementById('view'); if (!view) return;
  const path = (location.hash.slice(1) || '/dashboard').split('?')[0];
  let hit = null, params = {};
  for (const r of G.nav) { const m = r.re.exec(path); if (m) { hit = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; } }
  if (!hit) { hit = G.nav.find((r) => r.id === 'dashboard'); params = {}; }
  const token = (G.current = {});
  G.clearTimers();
  document.getElementById('pagetitle').textContent = hit.title;
  document.title = hit.title + ' · GERDEV AI WORKFORCE';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.id === (hit.menu || hit.id)));
  document.querySelectorAll('.bottomnav a').forEach((a) => a.classList.toggle('on', a.dataset.id === (hit.menu || hit.id)));
  document.querySelector('.shell').classList.remove('open');
  view.innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto 10px"></div>Memuat…</div>';
  window.scrollTo(0, 0);
  try { await hit.render(view, params, () => G.current === token); }
  catch (e) {
    if (G.current !== token) return;
    view.innerHTML = html`<div class="notice err"><b>Gagal memuat halaman.</b> ${G.errText(e)}${e.body && e.body.code === 'NOT_MIGRATED' ? html`<br>Skema database belum terpasang — lihat README (Panduan Neon).` : ''}<div style="margin-top:10px"><button class="btn sm" data-retry>Coba lagi</button></div></div>`.s;
    const b = view.querySelector('[data-retry]'); if (b) b.onclick = G.render;
  }
};
G.refresh = () => G.render();
window.addEventListener('hashchange', () => { if (G.state.user) G.render(); });
