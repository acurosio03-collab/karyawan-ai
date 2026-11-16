'use strict';
/* Halaman 6 Task Center, 7 Task Detail, 8 AI Communication. */
const ACTIVE = ['queued', 'running', 'pending_deps', 'waiting_children', 'in_qa'];

async function newGoalModal(onDone) {
  const [ag, un] = await Promise.all([G.api.get('/agents?status=active'), G.api.get('/business-units')]);
  G.formModal({
    title: 'Target / pekerjaan baru', intro: 'Tanpa memilih karyawan, target dikirim ke AI CEO yang akan membaginya ke manajer & pekerja (alur Owner → CEO → Manajer → Pekerja → QA → Owner).', submitLabel: 'Kirim target',
    fields: [{ name: 'title', label: 'Judul target', required: true, full: true, placeholder: 'mis. Cari 5 calon klien UMKM kuliner di Cirebon' }, { name: 'description', label: 'Rincian, batasan, hasil yang diharapkan', type: 'textarea', rows: 5 },
      { name: 'agent_id', label: 'Berikan langsung ke (opsional)', type: 'select', options: [['', 'AI CEO (otomatis dibagi)'], ...ag.items.map((a) => [a.id, `${a.name} — ${a.title}`])] },
      { name: 'business_unit_id', label: 'Unit bisnis (opsional)', type: 'select', options: [['', '— tidak ada —'], ...un.items.map((u) => [u.id, u.name])] }, { name: 'priority', label: 'Prioritas (1-10)', type: 'number', min: 1 }],
    values: { priority: 5 },
    onSubmit: async (v) => { const t = await G.api.post('/tasks', v); G.toast('Target dikirim. Klik ▶ Jalankan antrean (atau aktifkan Auto) untuk memprosesnya.'); G.go('/tasks/' + t.id); onDone && onDone(); }
  });
}

G.route('/tasks', {
  id: 'tasks', title: 'Task Center',
  async render(view, p, alive) {
    let filter = ''; let tab = 'tugas';
    const load = async () => {
      const [r, w] = await Promise.all([G.api.get('/tasks' + G.qs({ parent: 'none', status: filter, limit: 100 })), G.api.get('/worker/status')]);
      return { r, w };
    };
    let { r, w } = await load(); if (!alive()) return;
    const FILTERS = [['', 'Semua'], ['active', 'Aktif'], ['review', 'Tinjauan Owner'], ['done', 'Selesai'], ['failed', 'Gagal'], ['blocked', 'Terblokir']];
    const draw = () => {
      view.innerHTML = html`${G.pagehead('Task Center', 'Antrean, pembagian tugas, dan hasil kerja seluruh karyawan AI.', html`<button class="btn pri" data-act="new" ${G.can('manager') ? '' : raw('disabled')}>＋ Target baru</button>`)}
        ${!w.ai_connected ? html`<div style="margin-bottom:12px">${G.notConnected('API AI belum tersambung — tugas baru akan berstatus Terblokir (tidak ada hasil palsu). Isi OPENAI_API_KEY di Vercel lalu Redeploy.')}</div>` : ''}
        <div class="grid g4 keep2" style="margin-bottom:14px">${G.stat('Antre', w.queued, w.delayed ? w.delayed + ' dijadwalkan ulang' : '')}${G.stat('Berjalan', w.running, '', 'warn')}${G.stat('Menunggu', w.waiting_deps + w.waiting_children + w.in_qa, 'dependensi / sub-tugas / QA')}${G.stat('Gagal 24 jam', w.failed_24h, w.blocked + ' terblokir', w.failed_24h ? 'err' : '')}</div>
        <div class="tabs"><button class="${tab === 'tugas' ? 'on' : ''}" data-act="tab" data-k="tugas">Tugas</button><button class="${tab === 'berkas' ? 'on' : ''}" data-act="tab" data-k="berkas">Berkas hasil kerja</button></div>
        <div id="tbody"></div>`.s;
      drawBody();
    };
    const drawBody = async () => {
      const box = view.querySelector('#tbody'); if (!box) return;
      if (tab === 'berkas') {
        const f = await G.api.get('/files'); if (!alive()) return;
        box.innerHTML = html`<div class="card">${G.table([{ h: 'Nama berkas', f: (x) => html`<a href="#" data-act="file" data-id="${x.id}">${x.name}</a>` }, { h: 'Jenis', f: (x) => x.mime }, { h: 'Ukuran', num: true, f: (x) => G.fmt.num(x.size) + ' B' }, { h: 'Oleh', f: (x) => x.agent_name || 'Sistem' }, { h: 'Dibuat', f: (x) => G.fmt.rel(x.created_at) },
          { h: '', f: (x) => html`<button class="btn sm" data-act="file" data-id="${x.id}">Buka</button> <button class="btn sm danger" data-act="delfile" data-id="${x.id}" ${G.can('admin') ? '' : raw('disabled')}>Hapus</button>` }], f.items, { empty: 'Belum ada berkas. Laporan & dokumen buatan AI muncul di sini.' })}</div>`.s;
        return;
      }
      box.innerHTML = html`<div class="toolbar">${FILTERS.map(([k, l]) => html`<button class="btn sm ${filter === k ? 'pri' : ''}" data-act="filter" data-k="${k}">${l}${k && r.counts[k] ? ' (' + r.counts[k] + ')' : ''}</button>`)}</div>
        <div class="card">${G.table([
          { h: 'Tugas', f: (t) => html`<a href="#/tasks/${t.id}"><b>${t.title}</b></a>${t.summary ? html`<div class="small mute">${String(t.summary).slice(0, 120)}</div>` : ''}${t.error ? html`<div class="small err">${String(t.error).slice(0, 120)}</div>` : ''}` },
          { h: 'Penanggung jawab', f: (t) => (t.agent_name ? html`${t.agent_avatar || ''} ${t.agent_name}` : '—') },
          { h: 'Status', f: (t) => html`${G.badge(t.status)} ${t.qa_status ? G.badge(t.qa_status) : ''}` },
          { h: 'Sub-tugas', f: (t) => (t.child_count ? `${t.child_done}/${t.child_count}` : '-') }, { h: 'Prio', num: true, f: (t) => t.priority }, { h: 'Dibuat', f: (t) => G.fmt.rel(t.created_at) }], r.items, { empty: 'Belum ada tugas. Klik "Target baru" untuk memberi target pertama ke AI CEO.' })}</div>`.s;
    };
    draw();
    G.timers.push(setInterval(async () => { if (document.querySelector('.modal-bg') || !alive()) return; try { ({ r, w } = await load()); if (alive()) draw(); } catch { /* abaikan */ } }, 15000));
    G.bind(view, {
      new: () => newGoalModal(),
      tab: (d) => { tab = d.k; draw(); },
      filter: async (d) => { filter = d.k; ({ r, w } = await load()); draw(); },
      file: (d) => openFile(d.id),
      delfile: async (d) => { if (await G.confirm('Hapus berkas ini?', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/files/' + d.id); G.toast('Berkas dihapus'); drawBody(); } }
    });
  }
});

async function openFile(id) {
  const f = await G.api.get('/files/' + id);
  const m = G.modal({ title: f.name, wide: true, body: html`<div class="small mute" style="margin-bottom:8px">${f.mime} · ${G.fmt.num(f.size)} B · ${G.fmt.dt(f.created_at)}</div><div class="pre">${f.content}</div>`, footer: html`<button class="btn" data-dl>⬇ Unduh</button><button class="btn pri" data-x2>Tutup</button>` });
  m.el.querySelector('[data-x2]').onclick = m.close;
  m.el.querySelector('[data-dl]').onclick = () => { const b = new Blob([f.content], { type: (f.mime || 'text/plain') + ';charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };
}
G.openFile = openFile;

/* ---------- Detail tugas ---------- */
G.route('/tasks/:id', {
  id: 'task-detail', menu: 'tasks', title: 'Detail Tugas',
  async render(view, p, alive) {
    let tab = 'hasil';
    let d = await G.api.get('/tasks/' + p.id); if (!alive()) return;
    const resultView = (t) => {
      const r = t.result; if (!r) return G.empty('Belum ada hasil', t.status === 'blocked' ? 'Tugas terblokir — lihat pesan error di atas.' : 'Hasil muncul setelah tugas diproses.');
      const out = typeof r.output === 'string' ? r.output : r.output ? JSON.stringify(r.output, null, 2) : '';
      return html`${r.summary ? html`<h4 style="margin-bottom:6px">Ringkasan</h4><p>${r.summary}</p>` : ''}${out ? html`<h4 style="margin:10px 0 6px">Output</h4><div class="pre">${out}</div>` : ''}${!r.summary && !out ? html`<div class="pre">${JSON.stringify(r, null, 2)}</div>` : ''}`;
    };
    const draw = () => {
      const t = d.task; const active = ACTIVE.includes(t.status);
      const tabs = [['hasil', 'Hasil'], ['sub', `Sub-tugas (${d.children.length})`], ['eksekusi', `Eksekusi (${d.runs.length})`], ['pesan', `Pesan AI (${d.messages.length})`], ['tools', `Tool (${d.tool_logs.length})`], ['lain', 'Berkas & persetujuan']];
      let body = '';
      if (tab === 'hasil') {
        body = html`<div class="card">${t.error ? html`<div class="notice err" style="margin-bottom:10px"><b>Error:</b> ${t.error}</div>` : ''}${resultView(t)}
          ${d.qa_reviews.length ? html`<h4 style="margin:14px 0 6px">Pemeriksaan QA</h4>${d.qa_reviews.map((q) => html`<div class="item">${G.badge(q.qa_status || q.status)}<div class="grow small">${(q.result && (q.result.summary || q.result.feedback)) || ''}</div></div>`)}` : ''}</div>`;
      } else if (tab === 'sub') {
        body = html`<div class="card">${d.dependencies.length ? html`<div class="small mute" style="margin-bottom:6px">Bergantung pada: ${d.dependencies.map((x) => html`<a href="#/tasks/${x.id}">${x.title}</a> ${G.badge(x.status)} `)}</div>` : ''}
          ${G.table([{ h: 'Sub-tugas', f: (c) => html`<a href="#/tasks/${c.id}">${c.title}</a>${c.summary ? html`<div class="small mute">${String(c.summary).slice(0, 140)}</div>` : ''}${c.error ? html`<div class="small err">${String(c.error).slice(0, 120)}</div>` : ''}` }, { h: 'Jenis', f: (c) => c.kind }, { h: 'Karyawan', f: (c) => (c.agent_name ? `${c.agent_avatar || ''} ${c.agent_name}` : '—') }, { h: 'Status', f: (c) => html`${G.badge(c.status)} ${c.qa_status ? G.badge(c.qa_status) : ''}` }], d.children, { empty: 'Tidak ada sub-tugas' })}</div>`;
      } else if (tab === 'eksekusi') {
        body = html`<div class="card">${G.table([{ h: 'Waktu', f: (r) => G.fmt.dt(r.started_at) }, { h: 'Karyawan', f: (r) => r.agent_name }, { h: 'Fase', f: (r) => r.phase }, { h: 'Status', f: (r) => G.badge(r.status) }, { h: 'Model', f: (r) => r.model || '-' }, { h: 'Token', num: true, f: (r) => G.fmt.num(r.prompt_tokens + r.completion_tokens) }, { h: 'Biaya', num: true, f: (r) => G.fmt.usd(r.cost_usd) }, { h: 'Durasi', num: true, f: (r) => G.fmt.dur(r.duration_ms) }, { h: 'Error', f: (r) => html`<span class="small err">${r.error ? String(r.error).slice(0, 100) : ''}</span>` }], d.runs, { empty: 'Belum ada eksekusi' })}</div>`;
      } else if (tab === 'pesan') {
        body = html`<div class="card chat">${d.messages.length ? d.messages.map((m) => html`<div class="msg"><div class="h"><b>${m.from_agent || m.from_user || 'Sistem'}</b>${m.to_agent ? html`→ <b>${m.to_agent}</b>` : ''}<span class="badge">${m.kind}</span><span>${G.fmt.dt(m.created_at)}</span></div><div>${m.content}</div></div>`) : G.empty('Belum ada pesan antar-AI')}</div>`;
      } else if (tab === 'tools') {
        body = html`<div class="card">${G.table([{ h: 'Waktu', f: (l) => G.fmt.dt(l.created_at) }, { h: 'Tool', f: (l) => l.tool_name }, { h: 'Oleh', f: (l) => l.agent_name || '-' }, { h: 'Status', f: (l) => G.badge(l.status) }, { h: 'Durasi', num: true, f: (l) => G.fmt.dur(l.duration_ms) }, { h: 'Detail', f: (l) => html`<button class="btn sm" data-act="toollog" data-id="${l.id}">Lihat</button>${l.error ? html` <span class="small err">${String(l.error).slice(0, 80)}</span>` : ''}` }], d.tool_logs, { empty: 'Belum ada pemakaian tool' })}</div>`;
      } else {
        body = html`<div class="grid split"><div class="card"><h3>Berkas</h3>${d.files.length ? html`<div class="list">${d.files.map((f) => html`<div class="item"><div class="grow"><a href="#" data-act="file" data-id="${f.id}">${f.name}</a><div class="small mute">${f.mime} · ${G.fmt.num(f.size)} B</div></div></div>`)}</div>` : G.empty('Tidak ada berkas')}</div>
          <div class="card"><h3>Permintaan persetujuan</h3>${d.approvals.length ? html`<div class="list">${d.approvals.map((a) => html`<div class="item"><div class="grow">${a.title}<div class="small mute">${a.action_type} · ${G.fmt.rel(a.created_at)}</div></div>${G.badge(a.status)}</div>`)}</div><a class="btn sm" href="#/approvals">Buka Approval Center</a>` : G.empty('Tidak ada')}</div></div>`;
      }
      view.innerHTML = html`<div class="pagehead"><a class="btn sm" href="#/tasks">← Task Center</a><div style="flex:1;min-width:200px"><h2 style="font-size:19px">${t.title}</h2>
        <div class="mute small">${t.kind} · prioritas ${t.priority} · ${t.agent_name ? 'oleh ' + t.agent_name : 'belum ditugaskan'}${t.unit_name ? ' · ' + t.unit_name : ''} · dibuat ${G.fmt.dt(t.created_at)} oleh ${t.created_by_name || t.created_by_agent_name || 'sistem'}</div></div>
        ${G.badge(t.status)} ${t.qa_status ? G.badge(t.qa_status) : ''}</div>
        ${t.description ? html`<div class="card" style="margin-bottom:12px"><div class="small mute">Instruksi</div><div style="white-space:pre-wrap">${t.description}</div></div>` : ''}
        <div class="row" style="margin-bottom:14px">
          ${t.status === 'review' ? html`<button class="btn pri" data-act="accept" ${G.can('manager') ? '' : raw('disabled')}>✔ Terima hasil</button><button class="btn" data-act="revise" ${G.can('manager') ? '' : raw('disabled')}>↺ Minta revisi</button>` : ''}
          ${['failed', 'blocked', 'cancelled'].includes(t.status) ? html`<button class="btn pri" data-act="retry" ${G.can('manager') ? '' : raw('disabled')}>↻ Coba lagi</button>` : ''}
          ${active || t.status === 'review' ? html`<button class="btn danger" data-act="cancel" ${G.can('manager') ? '' : raw('disabled')}>Batalkan</button>` : ''}
          ${['done', 'failed', 'cancelled', 'blocked'].includes(t.status) ? html`<button class="btn danger" data-act="del" ${G.can('admin') ? '' : raw('disabled')}>Hapus</button>` : ''}
          ${active ? html`<button class="btn" data-act="runq">▶ Jalankan antrean</button>` : ''}
          <span class="mute small">percobaan ${t.attempts}/${t.max_attempts}${active ? ' · halaman ini menyegarkan otomatis' : ''}</span></div>
        <div class="tabs">${tabs.map(([k, l]) => html`<button class="${tab === k ? 'on' : ''}" data-act="tab" data-k="${k}">${l}</button>`)}</div>${body}`.s;
    };
    draw();
    if (ACTIVE.includes(d.task.status)) G.timers.push(setInterval(async () => { if (document.querySelector('.modal-bg') || !alive()) return; try { d = await G.api.get('/tasks/' + p.id); if (alive()) draw(); if (!ACTIVE.includes(d.task.status)) G.clearTimers(); } catch { /* abaikan */ } }, 8000));
    const act = (path, body, ok) => async () => { await G.api.post(`/tasks/${p.id}/${path}`, body); G.toast(ok); G.render(); G.refreshBadges(); };
    G.bind(view, {
      tab: (x) => { tab = x.k; draw(); },
      accept: act('accept', {}, 'Hasil diterima — target selesai'),
      retry: act('retry', {}, 'Tugas dimasukkan ke antrean lagi'),
      cancel: async () => { if (await G.confirm('Batalkan tugas ini beserta sub-tugasnya?', { danger: true, okLabel: 'Batalkan tugas' })) { await G.api.post(`/tasks/${p.id}/cancel`, {}); G.toast('Dibatalkan'); G.render(); } },
      revise: () => G.formModal({ title: 'Minta revisi', fields: [{ name: 'feedback', label: 'Apa yang perlu diperbaiki?', type: 'textarea', required: true, rows: 5 }], submitLabel: 'Kirim revisi', onSubmit: async (v) => { await G.api.post(`/tasks/${p.id}/revise`, v); G.toast('Revisi dikirim ke antrean'); G.render(); } }),
      del: async () => { if (await G.confirm('Hapus tugas ini?', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/tasks/' + p.id); G.toast('Tugas dihapus'); G.go('/tasks'); } },
      runq: (x, el) => G.runQueue(el),
      file: (x) => openFile(x.id),
      toollog: (x) => { const l = d.tool_logs.find((q) => q.id === x.id); G.modal({ title: 'Log tool: ' + l.tool_name, wide: true, body: html`<h4>Input</h4><div class="pre">${JSON.stringify(l.input, null, 2)}</div><h4 style="margin-top:10px">Output</h4><div class="pre">${JSON.stringify(l.output, null, 2)}</div>${l.error ? html`<div class="notice err" style="margin-top:10px">${l.error}</div>` : ''}` }); }
    });
  }
});

/* ---------- AI Communication ---------- */
G.route('/comm', {
  id: 'comm', title: 'AI Communication',
  async render(view, p, alive) {
    let tab = 'pesan'; let agentId = ''; let kind = '';
    const agents = await G.api.get('/agents'); if (!alive()) return;
    const draw = async () => {
      view.innerHTML = html`${G.pagehead('Komunikasi AI', 'Pesan antar-karyawan AI, delegasi tugas, dan memori bersama perusahaan.', html`<button class="btn pri" data-act="send" ${G.can('manager') ? '' : raw('disabled')}>✉ Kirim instruksi ke karyawan</button>`)}
        <div class="tabs"><button class="${tab === 'pesan' ? 'on' : ''}" data-act="tab" data-k="pesan">Pesan</button><button class="${tab === 'memori' ? 'on' : ''}" data-act="tab" data-k="memori">Memori</button></div><div id="cbody"><div class="empty">Memuat…</div></div>`.s;
      const box = view.querySelector('#cbody');
      if (tab === 'pesan') {
        const r = await G.api.get('/messages' + G.qs({ agent_id: agentId, kind, limit: 150 })); if (!alive()) return;
        const kinds = [...new Set(r.items.map((m) => m.kind))];
        box.innerHTML = html`<div class="toolbar"><select id="fa"><option value="">Semua karyawan</option>${agents.items.map((a) => html`<option value="${a.id}" ${a.id === agentId ? raw('selected') : ''}>${a.name}</option>`)}</select>
          <select id="fk"><option value="">Semua jenis</option>${[...new Set(['delegation', 'report', 'qa', 'owner', ...kinds])].map((k) => html`<option ${k === kind ? raw('selected') : ''}>${k}</option>`)}</select></div>
          <div class="card chat">${r.items.length ? r.items.map((m) => html`<div class="msg"><div class="h"><b>${m.from_agent || 'Owner'}</b>${m.to_agent ? html`→ <b>${m.to_agent}</b>` : ''}<span class="badge">${m.kind}</span><span>${G.fmt.dt(m.created_at)}</span>${m.task_id ? html`<a href="#/tasks/${m.task_id}">${m.task_title || 'tugas'}</a>` : ''}</div><div style="white-space:pre-wrap">${m.content}</div></div>`) : G.empty('Belum ada pesan', 'Pesan muncul saat AI mendelegasikan tugas dan melapor.')}</div>`.s;
        box.querySelector('#fa').onchange = (e) => { agentId = e.target.value; draw(); };
        box.querySelector('#fk').onchange = (e) => { kind = e.target.value; draw(); };
      } else {
        const r = await G.api.get('/memories' + G.qs({ limit: 100 })); if (!alive()) return;
        const LB = { company: 'Perusahaan', business: 'Bisnis', agent_long: 'Karyawan (panjang)', agent_short: 'Karyawan (pendek)', task: 'Tugas', customer: 'Pelanggan' };
        box.innerHTML = html`<div class="toolbar"><input id="mq" type="search" placeholder="Cari memori berdasarkan relevansi…"><button class="btn" data-act="msearch">Cari</button><button class="btn pri" data-act="addmem" ${G.can('manager') ? '' : raw('disabled')}>＋ Tambah memori</button></div><div id="mlist"></div>`.s;
        const list = (items) => { box.querySelector('#mlist').innerHTML = html`<div class="card">${items.length ? html`<div class="list">${items.map((m) => html`<div class="item"><div class="grow"><span class="badge vio">${LB[m.scope] || m.scope}</span> <span class="mute small">penting ${m.importance}/10 · ${G.fmt.rel(m.created_at)}</span><div style="white-space:pre-wrap">${m.content}</div></div><button class="btn sm danger" data-act="delmem" data-id="${m.id}" ${G.can('manager') ? '' : raw('disabled')}>Hapus</button></div>`)}</div>` : G.empty('Tidak ada memori')}</div>`.s; };
        list(r.items); view._mem = list;
      }
    };
    await draw();
    G.bind(view, {
      tab: (d) => { tab = d.k; draw(); },
      send: () => G.formModal({ title: 'Kirim instruksi ke karyawan', intro: 'Instruksi menjadi tugas langsung yang dikerjakan karyawan tersebut.', submitLabel: 'Kirim',
        fields: [{ name: 'to_agent_id', label: 'Kepada', type: 'select', required: true, options: agents.items.filter((a) => a.status === 'active').map((a) => [a.id, `${a.name} — ${a.title}`]) }, { name: 'content', label: 'Instruksi', type: 'textarea', required: true, rows: 5 }],
        onSubmit: async (v) => { const r = await G.api.post('/messages', v); G.toast('Instruksi dikirim sebagai tugas'); G.go('/tasks/' + r.task.id); } }),
      msearch: async () => { const q = view.querySelector('#mq').value; const r = await G.api.get('/memories' + G.qs({ q, limit: 100 })); view._mem(r.items); },
      delmem: async (d) => { await G.api.del('/memories/' + d.id); G.toast('Memori dihapus'); draw(); },
      addmem: async () => {
        const [u] = await Promise.all([G.api.get('/business-units')]);
        G.formModal({ title: 'Tambah memori', fields: [{ name: 'scope', label: 'Jenis', type: 'select', options: [['company', 'Perusahaan'], ['business', 'Bisnis (pilih unit)']] }, { name: 'business_unit_id', label: 'Unit bisnis (untuk jenis Bisnis)', type: 'select', options: [['', '—'], ...u.items.map((x) => [x.id, x.name])] }, { name: 'content', label: 'Isi memori', type: 'textarea', required: true }, { name: 'importance', label: 'Penting (1-10)', type: 'number', min: 1 }], values: { scope: 'company', importance: 6 },
          onSubmit: async (v) => { await G.api.post('/memories', v); G.toast('Memori disimpan'); draw(); } });
      }
    });
  }
});
