'use strict';
// Job queue persisten (tabel tasks) + worker tick yang sadar batas waktu serverless.
const crypto = require('crypto');
const orchestrator = require('./orchestrator');
const scheduler = require('./scheduler');

async function claim(db, { limit = 1, workerId, workspaceId = null }) {
  return db.query(
    `update tasks set status='running', locked_at=now(), locked_by=$2, started_at=coalesce(started_at, now()), attempts=attempts+1, scheduled_for=null, updated_at=now()
     where id in (select id from tasks where status='queued' and (scheduled_for is null or scheduled_for <= now()) and ($3::uuid is null or workspace_id=$3)
                  order by priority desc, created_at asc limit $1 for update skip locked)
     returning *`, [limit, workerId, workspaceId]);
}

// Tugas yang menggantung di 'running' (worker mati/timeout platform) dikembalikan ke antrean atau ditandai gagal
async function recoverStale(db) {
  const rows = await db.query(
    `update tasks set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
       error = 'Worker berhenti sebelum tugas selesai (timeout)', locked_at = null,
       finished_at = case when attempts >= max_attempts then now() else null end, updated_at = now()
     where status='running' and locked_at < now() - ((timeout_seconds + 90) * interval '1 second') returning id, status`);
  for (const r of rows) if (r.status === 'failed') await orchestrator.onTerminal(db, r.id).catch(() => {});
  return rows.length;
}

async function tick(db, { workspaceId = null, budgetMs = 50000, maxTasks = 10 } = {}) {
  const deadline = Date.now() + budgetMs; const workerId = 'w-' + crypto.randomBytes(4).toString('hex');
  const out = { recovered: 0, schedulesCreated: 0, processed: [], stoppedBecause: 'queue_empty' };
  out.recovered = await recoverStale(db);
  out.schedulesCreated = await scheduler.runDueSchedules(db, workspaceId);
  while (out.processed.length < maxTasks) {
    if (deadline - Date.now() < 15000) { out.stoppedBecause = 'time_budget'; break; }
    const [task] = await claim(db, { limit: 1, workerId, workspaceId });
    if (!task) break;
    const r = await orchestrator.processTask(db, task, { deadline });
    out.processed.push({ id: task.id, title: task.title, ...r });
  }
  if (out.processed.length >= maxTasks) out.stoppedBecause = 'max_tasks';
  const q = await db.one("select count(*) filter (where status='queued')::int as queued, count(*) filter (where status='running')::int as running from tasks where ($1::uuid is null or workspace_id=$1)", [workspaceId]);
  out.remaining = q;
  return out;
}
module.exports = { claim, recoverStale, tick };
