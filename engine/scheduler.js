'use strict';
const orchestrator = require('./orchestrator');

// Ambil jadwal yang jatuh tempo secara atomik (UPDATE...RETURNING) lalu buat tugas dengan dedupe_key unik
// sehingga pekerjaan tidak ganda walau dua worker berjalan bersamaan.
async function runDueSchedules(db, workspaceId = null) {
  const due = await db.query(
    `update schedules set last_run_at = now(), run_count = run_count + 1,
       enabled = case when frequency = 'once' then false else enabled end,
       next_run_at = case frequency when 'once' then null when 'minutes' then now() + coalesce(interval_minutes,60) * interval '1 minute'
         when 'hourly' then now() + interval '1 hour' when 'daily' then now() + interval '1 day' when 'weekly' then now() + interval '7 days' end
     where enabled and next_run_at <= now() and agent_id is not null and ($1::uuid is null or workspace_id = $1)
     returning *`, [workspaceId]);
  let created = 0;
  for (const s of due) {
    const agent = await db.one('select id, role_key from agents where id=$1', [s.agent_id]);
    if (!agent) continue;
    const t = await orchestrator.insertTask(db, { workspace_id: s.workspace_id, kind: agent.role_key === 'ceo' ? 'goal' : 'work', title: s.title, description: s.description, assigned_agent_id: agent.id,
      business_unit_id: s.business_unit_id, priority: s.priority, max_attempts: s.max_attempts, schedule_id: s.id, dedupe_key: `sched:${s.id}:${s.run_count}` });
    if (t) created++;
  }
  return created;
}

function nextRunFrom(frequency, intervalMinutes, from = new Date()) {
  const d = new Date(from);
  if (frequency === 'minutes') d.setMinutes(d.getMinutes() + (intervalMinutes || 60));
  else if (frequency === 'hourly') d.setHours(d.getHours() + 1);
  else if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  return d;
}
module.exports = { runDueSchedules, nextRunFrom };
