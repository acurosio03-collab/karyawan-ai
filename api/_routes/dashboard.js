'use strict';
const finance = require('../../services/finance');
const integrations = require('../../services/integrations');

module.exports = (r) => {
  // Semua angka dihitung langsung dari database workspace. Pendapatan = transaksi income yang tercatat (bukan simulasi).
  r.get('/dashboard', async ({ db, workspaceId: ws }) => {
    const [agents, tasks, leads, customers, orders, approvals, fin, series, activity, ai] = await Promise.all([
      db.one("select count(*)::int as total, count(*) filter (where status='active')::int as active from agents where workspace_id=$1", [ws]),
      db.one(`select count(*) filter (where status in ('running','waiting_children','in_qa','pending_deps'))::int as running,
              count(*) filter (where status='queued')::int as queued, count(*) filter (where status='done')::int as done,
              count(*) filter (where status='review')::int as review, count(*) filter (where status in ('failed','blocked'))::int as problem
              from tasks where workspace_id=$1`, [ws]),
      db.one('select count(*)::int as total, count(*) filter (where verified)::int as verified from leads where workspace_id=$1', [ws]),
      db.one('select count(*)::int as total from customers where workspace_id=$1', [ws]),
      db.one("select count(*) filter (where status<>'draft')::int as total, count(*) filter (where status in ('confirmed','in_progress'))::int as active from orders where workspace_id=$1", [ws]),
      db.one("select count(*)::int as pending from approvals where workspace_id=$1 and status in ('pending','review')", [ws]),
      finance.summary(db, ws, { days: 36500 }),
      db.query(`select to_char(d::date,'YYYY-MM-DD') as day,
                (select count(*)::int from tasks where workspace_id=$1 and created_at::date = d::date) as tasks_created,
                (select count(*)::int from tasks where workspace_id=$1 and status='done' and finished_at::date = d::date) as tasks_done,
                (select count(*)::int from agent_runs where workspace_id=$1 and started_at::date = d::date) as runs
                from generate_series(current_date - 13, current_date, interval '1 day') d order by d`, [ws]),
      db.query(`select r.id, r.status, r.phase, r.started_at, r.duration_ms, r.cost_usd::float as cost_usd, r.error, a.name as agent_name, a.avatar, t.title as task_title, t.id as task_id
                from agent_runs r join agents a on a.id=r.agent_id left join tasks t on t.id=r.task_id where r.workspace_id=$1 order by r.started_at desc limit 12`, [ws]),
      Promise.resolve({ openai: integrations.configured('openai'), alt_ai: integrations.configured('alt_ai') })
    ]);
    return {
      agents, tasks, leads, customers, orders, approvals,
      finance: { revenue: fin.income, expense: fin.expense, api_cost_usd: fin.apiCostUsd, api_cost_idr: fin.apiCostIdr, total_expense: fin.totalExpense, net: fin.net, note: fin.note },
      series, activity, ai_connected: ai.openai || ai.alt_ai
    };
  });
};
