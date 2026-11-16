'use strict';
/* Halaman 3 AI Employees, 4 Employee Detail, 5 Departments. */

async function agentForm(existing, onDone) {
  const [deps, cat, agents] = await Promise.all([G.api.get('/departments'), G.api.get('/tools-catalog'), G.api.get('/agents')]);
  const a = existing || { status: 'active', provider: 'openai', max_tokens_per_run: 2000, monthly_token_limit: 0, monthly_cost_limit_usd: 0, tools: [], skills: [], avatar: '🤖', is_manager: false };
  const fields = [
    { name: 'name', label: 'Nama', required: true }, { name: 'avatar', label: 'Avatar (emoji)', help: 'Satu emoji, mis. 🧠' },
    { name: 'title', label: 'Jabatan', required: true },
    { name: 'department', label: 'Departemen', type: 'select', options: [['', '— pilih —'], ...deps.items.map((d) => [d.name, d.name])] },
    { name: 'description', label: 'Deskripsi pekerjaan', type: 'textarea', rows: 2 }, { name: 'goal', label: 'Tujuan', type: 'textarea', rows: 2 },
    { name: 'system_prompt', label: 'System prompt (min. 20 karakter)', type: 'textarea', rows: 7, required: true },
    { name: 'skills', label: 'Keahlian', type: 'tags', full: true },
    { name: 'tools', label: 'Tools yang boleh digunakan (hak akses)', type: 'checks', options: cat.items.map((t) => [t.name, t.name + (t.permission === 'write' ? ' ✎' : '')]), help: '✎ = tool yang dapat menulis data. Semua tool tetap melewati validasi backend.' },
    { name: 'provider', label: 'Model AI — penyedia', type: 'select', options: [['openai', 'OpenAI'], ['alt', 'Model alternatif']] }, { name: 'model', label: 'Nama model (kosong = default env)', placeholder: 'mis. gpt-4o-mini' },
    { name: 'max_tokens_per_run', label: 'Batas token per eksekusi', type: 'number', min: 200 }, { name: 'monthly_token_limit', label: 'Batas token per bulan (0 = tanpa batas)', type: 'number', min: 0 },
    { name: 'monthly_cost_limit_usd', label: 'Batas biaya per bulan (USD, 0 = tanpa batas)', type: 'number', min: 0, step: '0.01' },
    { name: 'reports_to', label: 'Melapor ke', type: 'select', options: [['', '— tidak ada —'], ...agents.items.filter((x) => !existing || x.id !== existing.id).map((x) => [x.id, x.name])] },
    { name: 'status', label: 'Status', type: 'select', options: [['active', 'Aktif'], ['inactive', 'Nonaktif']] },
    { name: 'is_manager', label: 'Manajer (boleh mendelegasikan tugas ke karyawan lain)', type: 'checkbox' }
  ];
  const vals = { ...a, reports_to: a.reports_to || '' };
  G.formModal({ title: existing ? 'Edit karyawan AI' : 'Tambah karyawan AI', fields, values: vals, wide: true, submitLabel: existing ? 'Simpan perubahan' : 'Tambah karyawan',
    onSubmit: async (v) => {
      v.reports_to = v.reports_to || null;
      if (existing) await G.api.patch('/agents/' + existing.id, v); else await G.api.post('/agents', v);
      G.toast(existing ? 'Karyawan diperbarui' : 'Karyawan ditambahkan'); onDone && onDone();
    } });
}
G.agentForm = agentForm;

function assignTaskModal(agent, onDone) {
  return G.api.get('/business-units').then((u) => G.formModal({
    title: `Beri pekerjaan ke ${agent.name}`, intro: 'Tugas langsung dikerjakan karyawan ini, diperiksa QA, lalu dilaporkan kepada Anda.', submitLabel: 'Berikan pekerjaan',
    fields: [{ name: 'title', label: 'Judul pekerjaan', required: true, full: true }, { name: 'description', label: 'Rincian / instruksi', type: 'textarea', rows: 5 },
      { name: 'business_unit_id', label: 'Unit bisnis (opsional)', type: 'select', options: [['', '— tidak ada —'], ...u.items.map((x) => [x.id, x.name])] },
      { name: 'priority', label: 'Prioritas (1-10)', type: 'number', min: 1 }],
    values: { priority: 5 },
    onSubmit: async (v) => { const t = await G.api.post(`/agents/${agent.id}/tasks`, v); G.toast('Pekerjaan diberikan. Klik ▶ Jalankan antrean untuk memprosesnya.'); G.go('/tasks/' + t.id); onDone && onDone(); }
  }));
}
G.assignTaskModal = assignTaskModal;

/* ---------- Daftar karyawan ---------- */
G.route('/employees', {
  id: 'employees', title: 'AI Employees',
  async render(view, p, alive) {
    const [list, deps] = await Promise.all([G.api.get('/agents'), G.api.get('/departments')]); if (!alive()) return;
    const state = { q: '', dep: '', st: '' };
    const draw = () => {
      const items = list.items.filter((a) => (!state.q || (a.name + ' ' + a.title).toLowerCase().includes(state.q.toLowerCase())) && (!state.dep || a.department === state.dep) && (!state.st || a.status === state.st));
      document.getElementById('agrid').innerHTML = items.length ? html`${items.map((a) => html`<div class="card agent" data-act="open" data-id="${a.id}">
        <div class="row">${G.avatar(a)}<div class="grow" style="min-width:0"><b>${a.name}</b><div class="small mute">${a.title}</div></div>${G.badge(a.status)}</div>
        <div class="small mute">${a.department || '—'} ${a.is_manager ? html`· <span class="em">Manajer</span>` : ''}</div>
        <div class="small">${(a.description || '').slice(0, 110)}</div>
        <div class="tags">${(a.tools || []).slice(0, 5).map((t) => html`<span>${t}</span>`)}${(a.tools || []).length > 5 ? html`<span>+${a.tools.length - 5}</span>` : ''}</div>
        <div class="row" style="margin-top:auto"><button class="btn sm" data-act="assign" data-id="${a.id}" ${G.can('manager') && a.status === 'active' ? '' : raw('disabled')}>Beri tugas</button><button class="btn sm" data-act="open" data-id="${a.id}">Detail</button></div></div>`)}`.s : G.empty('Tidak ada karyawan yang cocok').s;
    };
    view.innerHTML = html`${G.pagehead('Karyawan AI', `${list.items.length} karyawan · ${list.items.filter((a) => a.status === 'active').length} aktif`,
      html`<button class="btn" data-act="recruit" ${G.can('manager') ? '' : raw('disabled')}>👥 Rekrut dari template</button><button class="btn pri" data-act="add" ${G.can('manager') ? '' : raw('disabled')}>＋ Tambah karyawan</button>`)}
      <div class="toolbar"><input id="aq" placeholder="Cari nama / jabatan…" type="search"><select id="ad"><option value="">Semua departemen</option>${deps.items.map((d) => html`<option>${d.name}</option>`)}</select>
      <select id="as"><option value="">Semua status</option><option value="active">Aktif</option><option value="inactive">Nonaktif</option></select></div>
      <div class="grid gauto" id="agrid"></div>`.s;
    draw();
    view.querySelector('#aq').oninput = (e) => { state.q = e.target.value; draw(); };
    view.querySelector('#ad').onchange = (e) => { state.dep = e.target.value; draw(); };
    view.querySelector('#as').onchange = (e) => { state.st = e.target.value; draw(); };
    G.bind(view, {
      open: (d) => G.go('/employees/' + d.id),
      add: () => agentForm(null, G.render),
      assign: (d) => assignTaskModal(list.items.find((x) => x.id === d.id), G.render),
      recruit: async () => {
        const t = await G.api.get('/agent-templates');
        const m = G.modal({ title: 'Rekrut karyawan AI dari template', wide: true, body: html`<p class="mute">Template berisi system prompt, keahlian, dan tools yang sudah disusun. Anda bisa mengubahnya setelah direkrut.</p>
          <div class="list">${t.items.map((x) => html`<div class="item">${G.avatar(x, 'sm')}<div class="grow"><b>${x.name}</b> <span class="mute small">· ${x.title} · ${x.department}</span><div class="small">${x.description}</div></div>
          <button class="btn sm ${x.hired ? '' : 'pri'}" data-act="hire" data-key="${x.key}">${x.hired ? 'Rekrut lagi' : 'Rekrut'}</button></div>`)}</div>` });
        G.bind(m.el, { hire: async (d) => { await G.api.post('/agents/recruit', { template_key: d.key }); G.toast('Karyawan direkrut'); m.close(); G.render(); } });
      }
    });
  }
});

/* ---------- Detail karyawan ---------- */
G.route('/employees/:id', {
  id: 'employee-detail', menu: 'employees', title: 'Detail Karyawan',
  async render(view, p, alive) {
    const o = await G.api.get(`/agents/${p.id}/overview`); if (!alive()) return;
    const a = o.agent; let tab = 'ikhtisar'; const ev = o.evaluation;
    const draw = () => {
      const tabs = [['ikhtisar', 'Ikhtisar'], ['konfigurasi', 'Konfigurasi'], ['tugas', `Riwayat pekerjaan (${o.tasks.length})`], ['eksekusi', `Eksekusi (${o.runs.length})`], ['memori', `Memori (${o.memories.length})`]];
      let body = '';
      if (tab === 'ikhtisar') {
        const s = o.stats;
        body = html`<div class="grid g4 keep2" style="margin-bottom:14px">${G.stat('Eksekusi', s.runs.runs, `${s.runs.succeeded} berhasil · ${s.runs.failed} gagal`)}${G.stat('Token (total)', G.fmt.num(s.runs.tokens), 'bulan ini ' + G.fmt.num(s.month.tokens))}
          ${G.stat('Biaya (estimasi)', G.fmt.usd(s.runs.cost_usd), 'bulan ini ' + G.fmt.usd(s.month.cost_usd))}${G.stat('Rata-rata durasi', G.fmt.dur(Math.round(s.runs.avg_ms)))}</div>
          <div class="grid split">
          <div class="card"><h3>Evaluasi kinerja <span class="sp"></span><button class="btn sm" data-act="eval" ${G.can('manager') ? '' : raw('disabled')}>Evaluasi sekarang</button></h3>
            <div id="evbox">${evalHtml(ev)}</div><p class="help">Skor dihitung dari data nyata (keberhasilan eksekusi, penyelesaian tugas, lolos QA). Butuh ≥ 3 eksekusi.</p></div>
          <div class="card"><h3>Struktur</h3><div class="small">Melapor ke: ${o.reports_to ? html`<a href="#/employees/${o.reports_to.id}">${o.reports_to.name}</a>` : '—'}</div>
            <div class="small" style="margin-top:8px">Bawahan langsung:</div>${o.direct_reports.length ? html`<div class="list">${o.direct_reports.map((r) => html`<div class="item">${G.avatar(r, 'sm')}<a href="#/employees/${r.id}">${r.name}</a><span class="mute small">${r.title}</span></div>`)}</div>` : html`<div class="mute small">Tidak ada</div>`}
            <div class="small" style="margin-top:10px">Batas bulanan: token ${a.monthly_token_limit > 0 ? G.fmt.num(a.monthly_token_limit) : 'tanpa batas'} · biaya ${a.monthly_cost_limit_usd > 0 ? G.fmt.usd(a.monthly_cost_limit_usd) : 'tanpa batas'}</div>
            ${a.monthly_token_limit > 0 ? html`<div class="bar" style="margin-top:6px"><i style="width:${G.pct(s.month.tokens, a.monthly_token_limit)}%"></i></div>` : ''}</div></div>`;
      } else if (tab === 'konfigurasi') {
        body = html`<div class="card"><div class="grid g2"><div><div class="mute small">Deskripsi pekerjaan</div><p>${a.description || '—'}</p><div class="mute small">Tujuan</div><p>${a.goal || '—'}</p>
          <div class="mute small">Keahlian</div><div class="tags">${(a.skills || []).map((x) => html`<span>${x}</span>`)}</div><div class="mute small" style="margin-top:10px">Tools yang diizinkan</div><div class="tags">${(a.tools || []).map((x) => html`<span>${x}</span>`)}</div></div>
          <div><div class="mute small">Model AI</div><p>${a.provider === 'alt' ? 'Model alternatif' : 'OpenAI'} · ${a.model || 'default env'} · maks ${a.max_tokens_per_run} token/eksekusi</p><div class="mute small">System prompt</div><div class="pre">${a.system_prompt}</div></div></div></div>`;
      } else if (tab === 'tugas') {
        body = html`<div class="card">${G.table([{ h: 'Tugas', f: (t) => html`<a href="#/tasks/${t.id}">${t.title}</a>${t.error ? html`<div class="small err">${String(t.error).slice(0, 100)}</div>` : ''}` }, { h: 'Jenis', f: (t) => t.kind }, { h: 'Status', f: (t) => G.badge(t.status) }, { h: 'QA', f: (t) => (t.qa_status ? G.badge(t.qa_status) : '-') }, { h: 'Dibuat', f: (t) => G.fmt.rel(t.created_at) }], o.tasks, { empty: 'Belum ada pekerjaan' })}</div>`;
      } else if (tab === 'eksekusi') {
        body = html`<div class="card">${G.table([{ h: 'Waktu', f: (r) => G.fmt.dt(r.started_at) }, { h: 'Fase', f: (r) => r.phase }, { h: 'Status', f: (r) => G.badge(r.status) }, { h: 'Model', f: (r) => r.model || '-' }, { h: 'Token', num: true, f: (r) => G.fmt.num(r.prompt_tokens + r.completion_tokens) }, { h: 'Biaya', num: true, f: (r) => G.fmt.usd(r.cost_usd) }, { h: 'Durasi', num: true, f: (r) => G.fmt.dur(r.duration_ms) }, { h: 'Error', f: (r) => html`<span class="err small">${r.error ? String(r.error).slice(0, 90) : ''}</span>` }], o.runs, { empty: 'Belum ada eksekusi' })}</div>`;
      } else {
        body = html`<div class="card"><h3>Memori karyawan <span class="sp"></span><button class="btn sm" data-act="addmem" ${G.can('manager') ? '' : raw('disabled')}>＋ Tambah memori</button></h3>
          ${o.memories.length ? html`<div class="list">${o.memories.map((m) => html`<div class="item"><div class="grow"><span class="badge ${m.scope === 'agent_long' ? 'vio' : 'info'}">${m.scope === 'agent_long' ? 'Jangka panjang' : 'Jangka pendek'}</span> <span class="mute small">penting ${m.importance}/10 · ${G.fmt.rel(m.created_at)}${m.expires_at ? ' · kedaluwarsa ' + G.fmt.dt(m.expires_at) : ''}</span><div>${m.content}</div></div>
            <button class="btn sm danger" data-act="delmem" data-id="${m.id}" ${G.can('manager') ? '' : raw('disabled')}>Hapus</button></div>`)}</div>` : G.empty('Belum ada memori', 'Memori terbentuk otomatis dari pekerjaan, atau tambahkan manual.')}</div>`;
      }
      view.innerHTML = html`<div class="pagehead"><a class="btn sm" href="#/employees">← Daftar</a>${G.avatar(a)}<div style="flex:1;min-width:180px"><h2 style="font-size:20px">${a.name} ${G.badge(a.status)}</h2><div class="mute">${a.title} · ${a.department || '—'}${a.is_manager ? ' · Manajer' : ''}</div></div>
        <button class="btn pri" data-act="assign" ${G.can('manager') && a.status === 'active' ? '' : raw('disabled')}>Berikan pekerjaan</button>
        <button class="btn" data-act="edit" ${G.can('manager') ? '' : raw('disabled')}>Edit</button>
        <button class="btn" data-act="toggle" ${G.can('manager') ? '' : raw('disabled')}>${a.status === 'active' ? 'Nonaktifkan' : 'Aktifkan'}</button>
        <button class="btn danger" data-act="del" ${G.can('admin') ? '' : raw('disabled')}>Hapus</button></div>
        <div class="tabs">${tabs.map(([k, l]) => html`<button class="${tab === k ? 'on' : ''}" data-act="tab" data-k="${k}">${l}</button>`)}</div>${body}`.s;
    };
    const evalHtml = (e) => e.score === null ? html`<div class="notice info">${e.rating}. ${(e.advice || [])[0] || ''}</div>` : html`<div class="row"><div class="stat" style="padding:0"><span class="v em">${e.score}</span><span class="k">${e.rating}</span></div><div class="grow">${e.parts.map((x) => html`<div class="small">${x.label} (${x.weight}%) — ${x.value}%</div><div class="bar" style="margin-bottom:6px"><i style="width:${x.value}%"></i></div>`)}</div></div><ul class="small">${e.advice.map((x) => html`<li>${x}</li>`)}</ul>`;
    draw();
    G.bind(view, {
      tab: (d) => { tab = d.k; draw(); },
      edit: () => agentForm(a, G.render),
      assign: () => assignTaskModal(a, G.render),
      toggle: async () => { await G.api.patch('/agents/' + a.id, { status: a.status === 'active' ? 'inactive' : 'active' }); G.toast('Status diubah'); G.render(); },
      del: async () => { if (await G.confirm(`Hapus karyawan "${a.name}" beserta riwayat eksekusinya? Disarankan menonaktifkan saja bila ia pernah bekerja.`, { danger: true, okLabel: 'Hapus' })) { await G.api.del('/agents/' + a.id); G.toast('Karyawan dihapus'); G.go('/employees'); } },
      eval: async () => { const e = await G.api.post(`/agents/${a.id}/evaluate`); document.getElementById('evbox').innerHTML = evalHtml(e).s; G.toast('Evaluasi diperbarui'); },
      addmem: () => G.formModal({ title: 'Tambah memori', fields: [{ name: 'scope', label: 'Jenis', type: 'select', options: [['agent_long', 'Jangka panjang'], ['agent_short', 'Jangka pendek']] }, { name: 'content', label: 'Isi memori', type: 'textarea', required: true }, { name: 'importance', label: 'Penting (1-10)', type: 'number', min: 1 }, { name: 'ttl_hours', label: 'Kedaluwarsa (jam, kosong = permanen)', type: 'number', min: 1 }], values: { scope: 'agent_long', importance: 5 },
        onSubmit: async (v) => { await G.api.post('/memories', { ...v, agent_id: a.id }); G.toast('Memori disimpan'); G.render(); } }),
      delmem: async (d) => { await G.api.del('/memories/' + d.id); G.toast('Memori dihapus'); G.render(); }
    });
  }
});

/* ---------- Departemen ---------- */
G.route('/departments', {
  id: 'departments', title: 'Departemen',
  async render(view, p, alive) {
    const r = await G.api.get('/departments'); if (!alive()) return;
    view.innerHTML = html`${G.pagehead('Departemen', 'Kelompokkan karyawan AI berdasarkan fungsi.', html`<button class="btn pri" data-act="add" ${G.can('admin') ? '' : raw('disabled')}>＋ Departemen</button>`)}
      <div class="grid gauto">${r.items.map((d) => html`<div class="card"><h3>${d.name} <span class="sp"></span><span class="badge ok">${d.active_count}/${d.agent_count} aktif</span></h3><div class="small mute">${d.description || ''}</div>
        <div class="list" style="margin:8px 0">${(d.agents || []).map((a) => html`<div class="item" style="padding:6px 0">${G.avatar(a, 'sm')}<a href="#/employees/${a.id}">${a.name}</a><span class="mute small">${a.title}</span></div>`)}${d.agent_count ? '' : html`<div class="mute small">Belum ada karyawan</div>`}</div>
        <div class="row"><button class="btn sm" data-act="edit" data-id="${d.id}" ${G.can('admin') ? '' : raw('disabled')}>Ubah</button><button class="btn sm danger" data-act="del" data-id="${d.id}" ${G.can('admin') ? '' : raw('disabled')}>Hapus</button></div></div>`)}</div>`.s;
    const form = (d) => G.formModal({ title: d ? 'Ubah departemen' : 'Departemen baru', fields: [{ name: 'name', label: 'Nama', required: true, full: true }, { name: 'description', label: 'Deskripsi', type: 'textarea', rows: 2 }], values: d || {},
      onSubmit: async (v) => { if (d) await G.api.patch('/departments/' + d.id, v); else await G.api.post('/departments', v); G.toast('Tersimpan'); G.render(); } });
    G.bind(view, {
      add: () => form(null), edit: (d) => form(r.items.find((x) => x.id === d.id)),
      del: async (d) => { if (await G.confirm('Hapus departemen ini?', { danger: true, okLabel: 'Hapus' })) { await G.api.del('/departments/' + d.id); G.toast('Departemen dihapus'); G.render(); } }
    });
  }
});
