'use strict';
const { HttpError } = require('../../lib/http');
const { validate } = require('../../lib/validate');
const { audit } = require('../../services/audit');
const finance = require('../../services/finance');
const tools = require('../../tools');

const S = (o = {}) => ({ type: 'string', ...o });
const PERIODS = { day: { n: 30, step: '1 day' }, week: { n: 12, step: '7 days' }, month: { n: 12, step: '1 month' } };
const unitOf = (q) => (q.unit_id && /^[0-9a-f-]{36}$/i.test(q.unit_id) ? q.unit_id : null);

module.exports = (r) => {
  r.get('/finance/summary', async ({ db, workspaceId: ws, query }) => {
    const days = Math.min(Math.max(Number(query.days) || 30, 1), 36500);
    const unitId = unitOf(query);
    const f = await finance.summary(db, ws, { days, unitId });
    const since = new Date(Date.now() - days * 86400000);
    const cat = await db.query(`select type, category, coalesce(sum(amount),0)::float as total from transactions where workspace_id=$1 and occurred_at >= $2 and ($3::uuid is null or business_unit_id=$3) group by 1,2 order by total desc`, [ws, since, unitId]);
    const open = await db.one("select coalesce(sum(total-paid_amount),0)::float as receivable from orders where workspace_id=$1 and status not in ('draft','cancelled') and payment_status in ('unpaid','partial') and ($2::uuid is null or business_unit_id=$2)", [ws, unitId]);
    return { ...f, by_category: cat, receivable: open.receivable };
  });

  r.get('/finance/series', async ({ db, workspaceId: ws, query }) => {
    const period = PERIODS[query.period] ? query.period : 'day';
    const { n, step } = PERIODS[period]; const unitId = unitOf(query);
    const rows = await db.query(
      `with b as (select generate_series(date_trunc($2, now()) - (($3::int - 1) * $4::interval), date_trunc($2, now()), $4::interval) as s)
       select to_char(b.s,'YYYY-MM-DD') as bucket,
         coalesce((select sum(amount) from transactions t where t.workspace_id=$1 and t.type='income' and date_trunc($2, t.occurred_at)=b.s and ($5::uuid is null or t.business_unit_id=$5)),0)::float as income,
         coalesce((select sum(amount) from transactions t where t.workspace_id=$1 and t.type='expense' and date_trunc($2, t.occurred_at)=b.s and ($5::uuid is null or t.business_unit_id=$5)),0)::float as expense,
         coalesce((select sum(cost_usd) from api_usage u where u.workspace_id=$1 and date_trunc($2, u.created_at)=b.s),0)::float as api_cost_usd
       from b order by b.s`, [ws, period, n, step, unitId]);
    const rate = await finance.rate(db, ws);
    return { period, usd_idr_rate: rate || null, items: rows.map((x) => ({ ...x, api_cost_idr: rate ? x.api_cost_usd * rate : null, net: x.income - x.expense - (rate ? x.api_cost_usd * rate : 0) })) };
  });

  r.get('/finance/by-unit', async ({ db, workspaceId: ws, query }) => {
    const since = new Date(Date.now() - Math.min(Math.max(Number(query.days) || 30, 1), 36500) * 86400000);
    return { items: await db.query(`select u.id, u.code, u.name,
      coalesce((select sum(amount) from transactions t where t.business_unit_id=u.id and t.type='income' and t.occurred_at>=$2),0)::float as income,
      coalesce((select sum(amount) from transactions t where t.business_unit_id=u.id and t.type='expense' and t.occurred_at>=$2),0)::float as expense,
      (select count(*)::int from orders o where o.business_unit_id=u.id and o.status<>'draft' and o.created_at>=$2) as orders
      from business_units u where u.workspace_id=$1 order by u.name`, [ws, since]) };
  });

  r.get('/transactions', async ({ db, workspaceId: ws, query }) => {
    const p = [ws]; const where = ['t.workspace_id=$1'];
    for (const f of ['type', 'business_unit_id', 'category', 'source']) if (query[f]) { p.push(query[f]); where.push(`t.${f}=$${p.length}`); }
    if (query.from) { p.push(query.from); where.push(`t.occurred_at >= $${p.length}::timestamptz`); }
    if (query.to) { p.push(query.to); where.push(`t.occurred_at <= $${p.length}::timestamptz`); }
    if (query.q) { p.push('%' + String(query.q).slice(0, 80) + '%'); where.push(`t.description ilike $${p.length}`); }
    return { items: await db.query(`select t.id, t.type, t.category, t.amount::float as amount, t.currency, t.description, t.source, t.occurred_at, t.order_id, o.order_no, bu.name as unit_name, t.business_unit_id
      from transactions t left join orders o on o.id=t.order_id left join business_units bu on bu.id=t.business_unit_id where ${where.join(' and ')} order by t.occurred_at desc limit 300`, p) };
  });
  r.post('/transactions', { min: 'admin' }, async (ctx) => {
    const b = validate({ type: S({ required: true, values: ['income', 'expense'] }), category: S({ max: 60, default: 'lainnya' }), amount: { type: 'number', required: true, min: 0.01, max: 1e12 }, description: S({ max: 300 }),
      business_unit_id: { type: 'uuid' }, occurred_at: { type: 'date' } }, ctx.body);
    if (b.business_unit_id && !(await ctx.db.one('select 1 from business_units where id=$1 and workspace_id=$2', [b.business_unit_id, ctx.workspaceId]))) throw new HttpError(400, 'Unit bisnis tidak ditemukan');
    const row = await ctx.db.one("insert into transactions (workspace_id, business_unit_id, type, category, amount, description, source, occurred_at, created_by) values ($1,$2,$3,$4,$5,$6,'manual',coalesce($7::timestamptz, now()),$8) returning id, type, amount::float as amount",
      [ctx.workspaceId, b.business_unit_id || null, b.type, b.category, b.amount, b.description || null, b.occurred_at || null, ctx.user.id]);
    await audit(ctx, 'transactions.create', 'transactions', row.id, { type: b.type, amount: b.amount });
    ctx.status = 201; return row;
  });
  r.delete('/transactions/:id', { min: 'admin' }, async (ctx) => {
    const n = await ctx.db.exec("delete from transactions where id=$1 and workspace_id=$2 and source='manual'", [ctx.params.id, ctx.workspaceId]);
    if (!n) throw new HttpError(409, 'Hanya transaksi manual yang dapat dihapus. Transaksi pembayaran/refund pesanan dikoreksi lewat pesanan.');
    await audit(ctx, 'transactions.delete', 'transactions', ctx.params.id);
    return { ok: true };
  });

  // Laporan harian/mingguan/bulanan (markdown dari data nyata, disimpan sebagai berkas)
  r.post('/finance/report', { min: 'manager' }, async (ctx) => {
    const b = validate({ period: S({ values: ['day', 'week', 'month'], default: 'week' }), business_unit_code: S({ max: 30 }) }, ctx.body);
    const label = { day: 'Harian', week: 'Mingguan', month: 'Bulanan' }[b.period];
    const out = await tools.DEFS.report_generator.run({ db: ctx.db, workspaceId: ctx.workspaceId, agent: null, taskId: null }, { title: `Laporan ${label}`, period: b.period, business_unit_code: b.business_unit_code });
    await audit(ctx, 'reports.generate', 'files', out.file_id, { period: b.period });
    ctx.status = 201; return out;
  });

  // ----- Penggunaan AI -----
  r.get('/usage', async ({ db, workspaceId: ws, query }) => {
    const days = Math.min(Math.max(Number(query.days) || 30, 1), 365); const since = new Date(Date.now() - days * 86400000);
    const [tot, byAgent, byDay, byModel, runs, unpriced] = await Promise.all([
      db.one('select count(*)::int as calls, coalesce(sum(prompt_tokens),0)::float as prompt_tokens, coalesce(sum(completion_tokens),0)::float as completion_tokens, coalesce(sum(cost_usd),0)::float as cost_usd from api_usage where workspace_id=$1 and created_at>=$2', [ws, since]),
      db.query(`select a.id, a.name, a.avatar, a.title, a.monthly_token_limit::float as token_limit, a.monthly_cost_limit_usd::float as cost_limit,
        coalesce(sum(u.prompt_tokens+u.completion_tokens) filter (where u.created_at>=$2),0)::float as tokens, coalesce(sum(u.cost_usd) filter (where u.created_at>=$2),0)::float as cost_usd, count(u.id) filter (where u.created_at>=$2)::int as calls,
        coalesce(sum(u.prompt_tokens+u.completion_tokens) filter (where u.created_at>=date_trunc('month', now())),0)::float as month_tokens,
        coalesce(sum(u.cost_usd) filter (where u.created_at>=date_trunc('month', now())),0)::float as month_cost
        from agents a left join api_usage u on u.agent_id=a.id where a.workspace_id=$1 group by a.id order by cost_usd desc, tokens desc`, [ws, since]),
      db.query(`select to_char(d::date,'YYYY-MM-DD') as day, coalesce((select sum(prompt_tokens+completion_tokens) from api_usage where workspace_id=$1 and created_at::date=d::date),0)::float as tokens,
        coalesce((select sum(cost_usd) from api_usage where workspace_id=$1 and created_at::date=d::date),0)::float as cost_usd
        from generate_series(current_date - ($2::int - 1), current_date, interval '1 day') d order by d`, [ws, Math.min(days, 60)]),
      db.query('select provider, model, count(*)::int as calls, coalesce(sum(prompt_tokens+completion_tokens),0)::float as tokens, coalesce(sum(cost_usd),0)::float as cost_usd from api_usage where workspace_id=$1 and created_at>=$2 group by 1,2 order by cost_usd desc', [ws, since]),
      db.query(`select r.id, r.status, r.phase, r.model, r.prompt_tokens, r.completion_tokens, r.cost_usd::float as cost_usd, r.duration_ms, r.error, r.started_at, r.task_id, a.name as agent_name, t.title as task_title
        from agent_runs r join agents a on a.id=r.agent_id left join tasks t on t.id=r.task_id where r.workspace_id=$1 order by r.started_at desc limit 40`, [ws]),
      db.one('select count(*)::int as n from api_usage where workspace_id=$1 and created_at>=$2 and cost_usd=0 and prompt_tokens+completion_tokens>0', [ws, since])
    ]);
    const rate = await finance.rate(db, ws);
    return { days, totals: tot, by_agent: byAgent, by_day: byDay, by_model: byModel, recent_runs: runs, usd_idr_rate: rate || null,
      note: 'Biaya adalah ESTIMASI dari harga per token model (cocokkan dengan tagihan resmi provider).' + (unpriced.n ? ` ${unpriced.n} panggilan memakai model yang harganya belum diketahui (biaya tercatat 0). Isi AI_PRICE_IN_PER_M / AI_PRICE_OUT_PER_M.` : '') };
  });
};
