'use strict';
// Task orchestrator: OWNER -> AI CEO -> MANAGER -> WORKER -> QA -> OWNER
const crypto = require('crypto');
const executor = require('./executor');
const memory = require('../memory/memory');
const { HttpError } = require('../lib/http');
const { limits } = require('../workflows/default');

const TERMINAL = ['done', 'failed', 'cancelled'];

async function insertTask(db, d) {
  const id = d.id || crypto.randomUUID();
  return db.one(
    `insert into tasks (id, workspace_id, business_unit_id, parent_task_id, root_task_id, schedule_id, kind, title, description, assigned_agent_id, created_by_agent_id, created_by_user_id, status, priority, depth, input, max_attempts, timeout_seconds, scheduled_for, dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20)
     on conflict do nothing returning *`,
    [id, d.workspace_id, d.business_unit_id || null, d.parent_task_id || null, d.root_task_id || id, d.schedule_id || null, d.kind || 'work', d.title, d.description || null,
      d.assigned_agent_id || null, d.created_by_agent_id || null, d.created_by_user_id || null, d.status || 'queued', d.priority || 5, d.depth || 0, JSON.stringify(d.input || {}),
      d.max_attempts || 3, d.timeout_seconds || 55, d.scheduled_for || null, d.dedupe_key || null]);
}

// Owner membuat target -> ditugaskan ke AI CEO
async function createGoal(db, { workspaceId, userId, title, description, businessUnitId, priority }) {
  const ceo = await db.one("select id from agents where workspace_id=$1 and role_key='ceo' and status='active' order by created_at limit 1", [workspaceId]);
  if (!ceo) throw new HttpError(409, 'Tidak ada AI CEO aktif. Rekrut/aktifkan karyawan dengan jabatan CEO terlebih dahulu.');
  const t = await insertTask(db, { workspace_id: workspaceId, kind: 'goal', title, description, assigned_agent_id: ceo.id, created_by_user_id: userId, business_unit_id: businessUnitId, priority });
  await db.exec("insert into agent_messages (workspace_id, task_id, from_user_id, to_agent_id, kind, content) values ($1,$2,$3,$4,'owner',$5)", [workspaceId, t.id, userId, ceo.id, `Target baru dari Owner: ${title}`]);
  return t;
}

// Tugas langsung ke satu karyawan (tanpa lewat CEO)
async function assignDirect(db, { workspaceId, userId, agentId, title, description, businessUnitId, priority }) {
  const a = await db.one('select id, role_key from agents where id=$1 and workspace_id=$2', [agentId, workspaceId]);
  if (!a) throw new HttpError(404, 'Karyawan tidak ditemukan');
  const t = await insertTask(db, { workspace_id: workspaceId, kind: a.role_key === 'ceo' ? 'goal' : 'work', title, description, assigned_agent_id: a.id, created_by_user_id: userId, business_unit_id: businessUnitId, priority });
  await db.exec("insert into agent_messages (workspace_id, task_id, from_user_id, to_agent_id, kind, content) values ($1,$2,$3,$4,'owner',$5)", [workspaceId, t.id, userId, a.id, title + (description ? ': ' + description.slice(0, 500) : '')]);
  return t;
}

async function onTerminal(db, taskId) {
  const task = await db.one('select * from tasks where id=$1', [taskId]);
  if (!task) return;
  const dependents = await db.query("select d.task_id from task_dependencies d join tasks x on x.id=d.task_id where d.depends_on_task_id=$1 and x.status='pending_deps'", [taskId]);
  for (const { task_id } of dependents) {
    const st = await db.one(`select count(*) filter (where t.status not in ('done','failed','cancelled'))::int as open, count(*) filter (where t.status in ('failed','cancelled'))::int as bad
      from task_dependencies d join tasks t on t.id=d.depends_on_task_id where d.task_id=$1`, [task_id]);
    if (st.open > 0) continue;
    if (st.bad > 0) {
      const f = await db.one("update tasks set status='failed', error='Dependensi gagal/dibatalkan', finished_at=now(), updated_at=now() where id=$1 and status='pending_deps' returning id", [task_id]);
      if (f) await onTerminal(db, f.id);
    } else await db.exec("update tasks set status='queued', updated_at=now() where id=$1 and status='pending_deps'", [task_id]);
  }
  if (task.parent_task_id) {
    const open = await db.one("select count(*)::int n from tasks where parent_task_id=$1 and status not in ('done','failed','cancelled')", [task.parent_task_id]);
    if (open.n === 0) {
      await db.exec(`update tasks set status='queued', attempts=0, input = input || '{"phase":"synthesize"}'::jsonb, updated_at=now() where id=$1 and status='waiting_children'`, [task.parent_task_id]);
    }
  }
}

async function finalize(db, task, result, qaStatus) {
  const isRootGoal = task.kind === 'goal' && !task.parent_task_id;
  const status = isRootGoal ? 'review' : 'done';
  await db.exec('update tasks set status=$2, result=$3::jsonb, qa_status=$4, error=null, finished_at=now(), locked_at=null, updated_at=now() where id=$1',
    [task.id, status, JSON.stringify(result), qaStatus || null]);
  if (status === 'done') await onTerminal(db, task.id);
  if (task.assigned_agent_id) {
    await db.exec("insert into agent_messages (workspace_id, task_id, from_agent_id, kind, content) values ($1,$2,$3,'report',$4)",
      [task.workspace_id, task.id, task.assigned_agent_id, `${isRootGoal ? 'Hasil akhir siap ditinjau Owner' : 'Selesai'}: ${String(result.summary || '').slice(0, 500)}${qaStatus === 'fail' ? ' [QA: perlu perhatian]' : ''}`]);
  }
}

async function handleDelegate(db, task, agent, res) {
  await db.tx(async (t) => {
    const cnt = await t.one('select count(*)::int n from tasks where root_task_id=$1', [task.root_task_id]);
    if (cnt.n + res.subtasks.length > limits.maxTasksPerGoal) throw new HttpError(422, `Batas ${limits.maxTasksPerGoal} tugas per target terlampaui`, { code: 'LIMIT' });
    const ids = [];
    for (let i = 0; i < res.subtasks.length; i++) {
      const s = res.subtasks[i];
      const created = await insertTask(t, { workspace_id: task.workspace_id, business_unit_id: task.business_unit_id, parent_task_id: task.id, root_task_id: task.root_task_id, kind: 'work', title: s.title, description: s.description,
        assigned_agent_id: s.agent_id, created_by_agent_id: agent.id, status: s.depends_on.length ? 'pending_deps' : 'queued', priority: s.priority, depth: task.depth + 1 });
      ids.push(created.id);
      for (const d of s.depends_on) await t.exec('insert into task_dependencies (task_id, depends_on_task_id) values ($1,$2)', [created.id, ids[d]]);
      await t.exec("insert into agent_messages (workspace_id, task_id, from_agent_id, to_agent_id, kind, content) values ($1,$2,$3,$4,'delegation',$5)", [task.workspace_id, created.id, agent.id, s.agent_id, `${s.title}: ${s.description.slice(0, 400)}`]);
    }
    await t.exec(`update tasks set status='waiting_children', result=$2::jsonb, input = input || '{"delegated":true}'::jsonb, error=null, locked_at=null, updated_at=now() where id=$1`,
      [task.id, JSON.stringify({ summary: res.summary, plan: res.subtasks.map((s) => ({ title: s.title, assignee: s.agent_name, depends_on: s.depends_on })) })]);
  });
}

async function handleFinal(db, task, agent, res, phase) {
  const fin = res.final;
  const result = { summary: fin.summary, output: fin.output, confidence: fin.confidence ?? null, agent: agent.name };
  if (phase === 'qa') return handleQa(db, task, result, fin);
  const delegated = !!(task.input && task.input.delegated);
  const needsQa = (task.kind === 'goal' && !task.parent_task_id) || (task.kind === 'work' && !delegated && phase !== 'synthesize');
  if (needsQa) {
    const qa = await db.one("select id from agents where workspace_id=$1 and role_key='qa' and status='active' order by created_at limit 1", [task.workspace_id]);
    if (qa) {
      await db.tx(async (t) => {
        await t.exec("update tasks set status='in_qa', result=$2::jsonb, error=null, locked_at=null, updated_at=now() where id=$1", [task.id, JSON.stringify(result)]);
        await insertTask(t, { workspace_id: task.workspace_id, business_unit_id: task.business_unit_id, root_task_id: task.root_task_id, kind: 'qa', title: `QA: ${task.title}`.slice(0, 160),
          description: 'Periksa hasil kerja terhadap tugas aslinya.', assigned_agent_id: qa.id, created_by_agent_id: agent.id, priority: 9, depth: task.depth, max_attempts: 2, input: { phase: 'qa', target_task_id: task.id } });
        await t.exec("insert into agent_messages (workspace_id, task_id, from_agent_id, to_agent_id, kind, content) values ($1,$2,$3,$4,'review',$5)", [task.workspace_id, task.id, agent.id, qa.id, `Mohon periksa: ${task.title}`]);
      });
      return;
    }
  }
  await finalize(db, task, result, null);
}

async function handleQa(db, qaTask, qaResult, fin) {
  const target = await db.one('select * from tasks where id=$1', [qaTask.input.target_task_id]);
  const result = { ...qaResult, verdict: fin.verdict, issues: fin.issues || [] };
  await db.exec("update tasks set status='done', result=$2::jsonb, error=null, qa_status=$3, finished_at=now(), locked_at=null, updated_at=now() where id=$1", [qaTask.id, JSON.stringify(result), fin.verdict]);
  if (!target || target.status !== 'in_qa') return;
  if (fin.verdict === 'pass') return finalize(db, target, target.result, 'pass');
  if (target.revisions < limits.maxRevisions) {
    const feedback = `${fin.summary}\n${(fin.issues || []).map((x) => '- ' + x).join('\n')}`.slice(0, 2000);
    await db.exec(`update tasks set status='queued', attempts=0, revisions=revisions+1, input = input || $2::jsonb, updated_at=now() where id=$1`, [target.id, JSON.stringify({ phase: 'revise', feedback })]);
    await db.exec("insert into agent_messages (workspace_id, task_id, from_agent_id, to_agent_id, kind, content) values ($1,$2,$3,$4,'review',$5)", [target.workspace_id, target.id, qaTask.assigned_agent_id, target.assigned_agent_id, 'QA meminta perbaikan: ' + feedback.slice(0, 500)]);
    return;
  }
  await finalize(db, target, { ...target.result, qa_issues: fin.issues || [] }, 'fail');
}

async function handleFailure(db, task, err) {
  const msg = String(err.message || err).slice(0, 600);
  if (err.code === 'NOT_CONNECTED' || err.code === 'BUDGET_EXCEEDED') {
    await db.exec("update tasks set status='blocked', error=$2, attempts=greatest(attempts-1,0), locked_at=null, updated_at=now() where id=$1", [task.id, msg]);
    return 'blocked';
  }
  if (task.attempts < task.max_attempts) {
    const delaySec = Math.min(900, 30 * 2 ** Math.max(0, task.attempts - 1));
    await db.exec("update tasks set status='queued', error=$2, scheduled_for=now() + ($3::int * interval '1 second'), locked_at=null, updated_at=now() where id=$1", [task.id, msg, delaySec]);
    return 'retry';
  }
  await db.exec("update tasks set status='failed', error=$2, finished_at=now(), locked_at=null, updated_at=now() where id=$1", [task.id, msg]);
  await db.exec("insert into agent_messages (workspace_id, task_id, from_agent_id, kind, content) values ($1,$2,$3,'report',$4)", [task.workspace_id, task.id, task.assigned_agent_id, 'Tugas gagal: ' + msg.slice(0, 400)]);
  if (task.kind === 'qa' && task.input && task.input.target_task_id) {
    const tgt = await db.one("select * from tasks where id=$1 and status='in_qa'", [task.input.target_task_id]);
    if (tgt) await finalize(db, tgt, { ...(tgt.result || {}), qa_issues: ['QA gagal dijalankan: ' + msg.slice(0, 200)] }, null);
  } else await onTerminal(db, task.id);
  return 'failed';
}

// Proses satu tugas yang sudah di-claim (status running)
async function processTask(db, task, { deadline }) {
  try {
    const agent = task.assigned_agent_id ? await db.one('select * from agents where id=$1', [task.assigned_agent_id]) : null;
    if (!agent) throw new HttpError(409, 'Tugas tidak punya karyawan yang valid', { code: 'BUDGET_EXCEEDED' });
    const phase = (task.input && task.input.phase) || (task.kind === 'qa' ? 'qa' : 'work');
    const taskDeadline = Math.min(deadline, Date.now() + task.timeout_seconds * 1000);
    const res = await executor.execute({ db, task, agent, deadline: taskDeadline });
    if (res.kind === 'delegate') await handleDelegate(db, task, agent, res);
    else await handleFinal(db, task, agent, res, phase);
    return { id: task.id, outcome: res.kind };
  } catch (e) {
    const outcome = await handleFailure(db, task, e);
    return { id: task.id, outcome, error: String(e.message || e).slice(0, 200) };
  }
}

async function cancelTask(db, workspaceId, taskId) {
  const rows = await db.query(`with recursive tree as (select id from tasks where id=$1 and workspace_id=$2 union all select t.id from tasks t join tree on t.parent_task_id = tree.id)
    update tasks set status='cancelled', finished_at=now(), locked_at=null, updated_at=now() where id in (select id from tree) and status not in ('done','failed','cancelled') returning id, parent_task_id`, [taskId, workspaceId]);
  if (rows[0]) await onTerminal(db, taskId).catch(() => {});
  return rows.length;
}
async function retryTask(db, workspaceId, taskId) {
  const t = await db.one("update tasks set status='queued', attempts=0, error=null, scheduled_for=null, finished_at=null, updated_at=now() where id=$1 and workspace_id=$2 and status in ('failed','blocked','cancelled') returning id", [taskId, workspaceId]);
  if (!t) throw new HttpError(409, 'Hanya tugas gagal/terblokir/dibatalkan yang bisa dicoba ulang');
  return t;
}
async function ownerAccept(db, workspaceId, taskId) {
  const t = await db.one("update tasks set status='done', finished_at=now(), updated_at=now() where id=$1 and workspace_id=$2 and status='review' returning id", [taskId, workspaceId]);
  if (!t) throw new HttpError(409, 'Tugas tidak dalam status menunggu tinjauan Owner');
  return t;
}
async function ownerRevise(db, workspaceId, taskId, feedback) {
  const t = await db.one(`update tasks set status='queued', attempts=0, revisions=revisions+1, input = input || $3::jsonb, finished_at=null, updated_at=now() where id=$1 and workspace_id=$2 and status='review' returning id`,
    [taskId, workspaceId, JSON.stringify({ phase: 'revise', feedback: String(feedback).slice(0, 2000) })]);
  if (!t) throw new HttpError(409, 'Tugas tidak dalam status menunggu tinjauan Owner');
  return t;
}
module.exports = { createGoal, assignDirect, insertTask, processTask, onTerminal, cancelTask, retryTask, ownerAccept, ownerRevise, handleFailure, TERMINAL };
