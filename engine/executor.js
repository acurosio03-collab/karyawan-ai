'use strict';
// Agent executor: menjalankan satu tugas oleh satu agen. Output AI wajib JSON terstruktur dan divalidasi skema;
// tidak ada kode/instruksi dari AI yang dieksekusi langsung - semua aksi lewat registry tools (cek izin + validasi).
const ai = require('../services/ai');
const { validate } = require('../lib/validate');
const { HttpError } = require('../lib/http');
const tools = require('../tools');
const memory = require('../memory/memory');
const integrations = require('../services/integrations');
const { limits } = require('../workflows/default');

const FINAL_SCHEMA = {
  summary: { type: 'string', required: true, min: 3, max: 1500 },
  output: { type: 'string', required: true, min: 3, max: 20000, trim: false },
  memory: { type: 'array', max: 5, items: { type: 'string', max: 300 } },
  confidence: { type: 'number', min: 0, max: 1 },
  verdict: { type: 'string', values: ['pass', 'fail'] },
  issues: { type: 'array', max: 10, items: { type: 'string', max: 400 } }
};
const SUBTASK_SHAPE = {
  title: { type: 'string', required: true, min: 3, max: 160 },
  description: { type: 'string', required: true, min: 5, max: 2000 },
  assignee: { type: 'string', required: true, max: 80 },
  skill: { type: 'string', max: 80 },
  depends_on: { type: 'array', max: 7, items: { type: 'int', min: 0, max: 7 } },
  priority: { type: 'int', min: 1, max: 10, default: 5 }
};

const normTok = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
// Cari karyawan tujuan delegasi: nama persis / role_key -> sebagian nama -> kecocokan keahlian
function resolveAssignee(roster, assignee, skill) {
  const a = String(assignee || '').trim().toLowerCase();
  let hit = roster.find((r) => r.name.toLowerCase() === a || r.role_key === a);
  if (hit) return hit;
  hit = roster.find((r) => a.length >= 3 && (r.name.toLowerCase().includes(a) || (r.title || '').toLowerCase() === a));
  if (hit) return hit;
  const toks = new Set([...normTok(assignee), ...normTok(skill)]);
  let best = null, bestScore = 0;
  for (const r of roster) {
    const sk = new Set((r.skills || []).flatMap(normTok));
    let score = 0; for (const t of toks) if (sk.has(t)) score++;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

function allowedRoster(all, agent) {
  const isCeo = agent.role_key === 'ceo';
  return all.filter((r) => r.id !== agent.id && r.role_key !== 'qa' && (isCeo || (r.role_key !== 'ceo' && !r.is_manager)));
}
const canDelegate = (agent, phase, depth) => (agent.is_manager || (agent.permissions && agent.permissions.delegate === true)) && (phase === 'work' || phase === 'revise') && depth < limits.maxDepth;

const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…[dipotong]' : s; };
const brief = (r) => (r ? { summary: cut(r.summary, 500), output: cut(r.output, 3000) } : null);

async function checkBudget(db, agent) {
  if (agent.status !== 'active') throw new HttpError(409, `Karyawan ${agent.name} nonaktif`, { code: 'BUDGET_EXCEEDED' });
  if (agent.monthly_token_limit == null && agent.monthly_cost_limit_usd == null) return;
  const u = await db.one("select coalesce(sum(prompt_tokens+completion_tokens),0)::float as t, coalesce(sum(cost_usd),0)::float as c from api_usage where agent_id=$1 and created_at >= date_trunc('month', now())", [agent.id]);
  if (agent.monthly_token_limit != null && u.t >= Number(agent.monthly_token_limit)) throw new HttpError(402, `Batas token bulanan ${agent.name} tercapai`, { code: 'BUDGET_EXCEEDED' });
  if (agent.monthly_cost_limit_usd != null && u.c >= Number(agent.monthly_cost_limit_usd)) throw new HttpError(402, `Batas biaya bulanan ${agent.name} tercapai`, { code: 'BUDGET_EXCEEDED' });
}

const PHASE_GUIDE = {
  work: 'Kerjakan tugas ini. Bila tugas terlalu besar dan Anda berhak mendelegasikan, pecah menjadi subtugas. Jika tidak, selesaikan sendiri.',
  revise: 'Tugas ini perlu diperbaiki berdasarkan "feedback". Perbaiki masalah yang disebutkan lalu berikan hasil final yang baru.',
  synthesize: 'Semua subtugas sudah selesai (lihat "children"). Susun hasil akhir yang utuh dan jujur - sebutkan subtugas yang gagal atau ditandai QA fail. Jangan mendelegasikan lagi.',
  qa: 'Anda memeriksa hasil kerja karyawan lain ("target"). Bandingkan dengan tugas aslinya. Final WAJIB memuat "verdict" ("pass"/"fail") dan "issues" (daftar masalah konkret bila fail). Tandai fail bila ada data yang tampak dikarang, bagian tugas yang terlewat, atau hasil yang tidak bisa dipakai.'
};

function systemPrompt({ agent, workspaceName, phase, delegateOK, toolDefs }) {
  const forms = ['1) Pakai tool: {"action":"tool","tool":"<nama>","input":{...}}'];
  if (delegateOK) forms.push('2) Delegasi: {"action":"delegate","subtasks":[{"title":"","description":"","assignee":"<nama karyawan atau role_key>","skill":"<opsional>","depends_on":[<indeks subtugas sebelumnya>],"priority":1-10}]} (maks 8 subtugas; depends_on hanya boleh menunjuk indeks yang lebih kecil)');
  forms.push('3) Selesai: {"action":"final","summary":"1-3 kalimat","output":"hasil kerja lengkap (markdown)","memory":["fakta penting yang perlu diingat (opsional)"],"confidence":0.0-1.0' + (phase === 'qa' ? ',"verdict":"pass|fail","issues":["..."]' : '') + '}');
  return `${agent.system_prompt}\n\nAnda adalah ${agent.name} (${agent.title}) di perusahaan "${workspaceName}".\nBalas HANYA dengan SATU objek JSON valid. Bentuk yang diizinkan:\n${forms.join('\n')}\n\nTool yang boleh Anda pakai: ${toolDefs.length ? toolDefs.map((t) => t.name).join(', ') : '(tidak ada)'}.\nAturan: jangan mengarang data; jangan klaim sudah mengirim/membayar/deploy bila hanya mengajukan persetujuan; jika sebuah tool mengembalikan error atau "NOT CONNECTED", laporkan apa adanya di hasil.\nFase saat ini: ${phase}. ${PHASE_GUIDE[phase]}`;
}

async function buildContext({ db, task, agent, phase, rosterAll, workspaceName, toolDefs, delegateOK }) {
  const ctx = { tanggal: new Date().toISOString(), tugas: { judul: task.title, deskripsi: cut(task.description, 3000), jenis: task.kind, prioritas: task.priority } };
  if (task.business_unit_id) {
    const u = await db.one('select code, name from business_units where id=$1', [task.business_unit_id]);
    if (u) ctx.unit_bisnis = u;
  }
  if (task.root_task_id && task.root_task_id !== task.id) {
    const root = await db.one('select title, description from tasks where id=$1', [task.root_task_id]);
    if (root) ctx.target_utama = { judul: root.title, deskripsi: cut(root.description, 1500) };
  }
  if (task.input && task.input.feedback) ctx.feedback = cut(task.input.feedback, 2000);
  const deps = await db.query('select t.title, t.status, t.result, t.error from task_dependencies d join tasks t on t.id=d.depends_on_task_id where d.task_id=$1', [task.id]);
  if (deps.length) ctx.hasil_dependensi = deps.map((d) => ({ judul: d.title, status: d.status, hasil: brief(d.result), error: d.error }));
  if (phase === 'synthesize') {
    const ch = await db.query('select t.title, t.status, t.qa_status, t.result, t.error, a.name as agent from tasks t left join agents a on a.id=t.assigned_agent_id where t.parent_task_id=$1 order by t.created_at', [task.id]);
    ctx.children = ch.map((c) => ({ judul: c.title, oleh: c.agent, status: c.status, qa: c.qa_status, hasil: brief(c.result), error: c.error }));
  }
  if (phase === 'qa') {
    const tgt = await db.one('select t.title, t.description, t.result, a.name as agent from tasks t left join agents a on a.id=t.assigned_agent_id where t.id=$1', [task.input.target_task_id]);
    if (tgt) ctx.target = { tugas_asli: { judul: tgt.title, deskripsi: cut(tgt.description, 2500) }, dikerjakan_oleh: tgt.agent, hasil: { summary: cut(tgt.result && tgt.result.summary, 800), output: cut(tgt.result && tgt.result.output, 9000) } };
  }
  if (delegateOK) ctx.karyawan_tersedia = allowedRoster(rosterAll, agent).map((r) => ({ nama: r.name, role_key: r.role_key, jabatan: r.title, keahlian: r.skills }));
  const mem = await memory.recall(db, { workspaceId: task.workspace_id, agentId: agent.id, query: `${task.title} ${task.description || ''}`, businessUnitId: task.business_unit_id, taskId: task.id });
  if (mem.length) ctx.memori = mem;
  ctx.tools = toolDefs.map((t) => ({ nama: t.name, fungsi: t.description, input: t.input_schema }));
  return ctx;
}

async function execute({ db, task, agent, deadline }) {
  const phase = (task.input && task.input.phase) || (task.kind === 'qa' ? 'qa' : 'work');
  await checkBudget(db, agent);
  await integrations.assertEnabled(db, task.workspace_id, agent.provider === 'alt' ? 'alt_ai' : 'openai');
  const ws = await db.one('select name from workspaces where id=$1', [task.workspace_id]);
  const rosterAll = await db.query("select id, name, role_key, title, skills, is_manager from agents where workspace_id=$1 and status='active'", [task.workspace_id]);
  const delegateOK = canDelegate(agent, phase, task.depth);
  const toolDefs = tools.listDefs().filter((t) => (agent.tools || []).includes(t.name));
  const context = await buildContext({ db, task, agent, phase, rosterAll, workspaceName: ws.name, toolDefs, delegateOK });
  const messages = [{ role: 'system', content: systemPrompt({ agent, workspaceName: ws.name, phase, delegateOK, toolDefs }) }, { role: 'user', content: JSON.stringify(context) }];

  const run = await db.one('insert into agent_runs (workspace_id, agent_id, task_id, phase, model) values ($1,$2,$3,$4,$5) returning id', [task.workspace_id, agent.id, task.id, phase, agent.model || null]);
  const started = Date.now(); let pt = 0, ct = 0, cost = 0, steps = 0, toolCalls = 0, modelUsed = agent.model || null;
  const finishRun = (status, out, err) => db.exec('update agent_runs set status=$2, output=$3::jsonb, error=$4, prompt_tokens=$5, completion_tokens=$6, cost_usd=$7, steps=$8, model=$9, duration_ms=$10, finished_at=now() where id=$1',
    [run.id, status, out ? JSON.stringify(out) : null, err ? String(err).slice(0, 500) : null, pt, ct, cost, steps, modelUsed, Date.now() - started]).catch(() => {});

  try {
    for (let step = 1; step <= limits.maxStepsPerRun; step++) {
      steps = step;
      const remaining = deadline - Date.now();
      if (remaining < 6000) throw new HttpError(504, 'Waktu eksekusi habis sebelum tugas selesai', { code: 'TIMEOUT' });
      const res = await ai.chatJSON({ provider: agent.provider, model: agent.model || undefined, messages, maxTokens: agent.max_tokens_per_run, timeoutMs: Math.min(Number(process.env.AI_TIMEOUT_MS) || 40000, remaining - 2000) });
      pt += res.promptTokens; ct += res.completionTokens; cost += res.cost.usd; modelUsed = res.model;
      await db.exec('insert into api_usage (workspace_id, agent_id, run_id, provider, model, prompt_tokens, completion_tokens, cost_usd, cost_estimated) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [task.workspace_id, agent.id, run.id, res.provider, res.model, res.promptTokens, res.completionTokens, res.cost.usd, true]);

      const reply = res.parsed || {};
      messages.push({ role: 'assistant', content: res.raw });
      const bad = (msg) => messages.push({ role: 'user', content: JSON.stringify({ error: 'Format salah: ' + msg + '. Balas ulang dengan JSON yang benar.' }) });

      if (reply.action === 'tool') {
        if (!reply.tool || typeof reply.tool !== 'string') { bad('field "tool" wajib'); continue; }
        if (toolCalls >= limits.maxToolCallsPerRun) { messages.push({ role: 'user', content: JSON.stringify({ info: 'Batas pemakaian tool tercapai. Berikan jawaban final sekarang.' }) }); continue; }
        toolCalls++;
        const out = await tools.runTool({ db, workspaceId: task.workspace_id, agent, taskId: task.id, runId: run.id }, reply.tool, reply.input);
        messages.push({ role: 'user', content: JSON.stringify({ hasil_tool: reply.tool, hasil: out }) });
        continue;
      }
      if (reply.action === 'delegate') {
        if (!delegateOK) { bad('Anda tidak boleh mendelegasikan pada fase ini; berikan hasil final'); continue; }
        let subs;
        try {
          if (!Array.isArray(reply.subtasks) || reply.subtasks.length < 1 || reply.subtasks.length > limits.maxSubtasksPerDelegation) throw new Error(`subtasks harus 1-${limits.maxSubtasksPerDelegation} item`);
          subs = reply.subtasks.map((s, idx) => {
            const v = validate(SUBTASK_SHAPE, s);
            const target = resolveAssignee(allowedRoster(rosterAll, agent), v.assignee, v.skill);
            if (!target) throw new Error(`assignee "${v.assignee}" tidak ditemukan/tidak boleh (subtugas ${idx})`);
            const deps = [...new Set(v.depends_on || [])];
            if (deps.some((d) => d >= idx)) throw new Error(`depends_on subtugas ${idx} harus menunjuk indeks yang lebih kecil`);
            return { ...v, depends_on: deps, agent_id: target.id, agent_name: target.name };
          });
        } catch (e) { bad(e.message); continue; }
        await finishRun('succeeded', { action: 'delegate', count: subs.length });
        return { kind: 'delegate', subtasks: subs, runId: run.id, usage: { pt, ct, cost }, summary: cut(reply.summary || `Mendelegasikan ${subs.length} subtugas`, 500) };
      }
      if (reply.action === 'final') {
        let fin;
        try {
          fin = validate(FINAL_SCHEMA, reply);
          if (phase === 'qa' && !fin.verdict) throw new Error('fase QA wajib memuat "verdict"');
        } catch (e) { bad(e.message); continue; }
        await finishRun('succeeded', { action: 'final', summary: fin.summary, verdict: fin.verdict });
        const label = cut(`Tugas "${task.title}": ${fin.summary}`, 400);
        await memory.remember(db, { workspaceId: task.workspace_id, scope: 'agent_short', agentId: agent.id, taskId: task.id, content: label, importance: 4 }).catch(() => {});
        for (const m of fin.memory || []) await memory.remember(db, { workspaceId: task.workspace_id, scope: 'agent_long', agentId: agent.id, content: m, importance: 6 }).catch(() => {});
        return { kind: 'final', final: fin, runId: run.id, usage: { pt, ct, cost } };
      }
      bad('"action" harus tool, delegate, atau final');
    }
    throw new HttpError(502, 'Agen tidak memberi jawaban final dalam batas langkah', { code: 'NO_FINAL' });
  } catch (e) {
    await finishRun(e.code === 'TIMEOUT' ? 'timeout' : 'failed', null, e.message);
    throw e;
  }
}
module.exports = { execute, resolveAssignee, allowedRoster, canDelegate, FINAL_SCHEMA, SUBTASK_SHAPE };
