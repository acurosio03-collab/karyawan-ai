'use strict';
// Perhitungan keuangan dari data nyata. Biaya API (USD) dikonversi ke IDR hanya bila Owner mengisi kurs di Pengaturan.
async function rate(db, ws) {
  const w = await db.one('select settings from workspaces where id=$1', [ws]);
  const r = Number(w && w.settings && w.settings.usd_idr_rate);
  return Number.isFinite(r) && r > 0 ? r : 0;
}
async function summary(db, ws, { days = 30, unitId = null } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const tx = await db.one(
    `select coalesce(sum(amount) filter (where type='income'),0)::float as income,
            coalesce(sum(amount) filter (where type='expense'),0)::float as expense
     from transactions where workspace_id=$1 and occurred_at >= $2 and ($3::uuid is null or business_unit_id = $3)`, [ws, since, unitId]);
  const api = await db.one(
    `select coalesce(sum(cost_usd),0)::float as usd, coalesce(sum(prompt_tokens+completion_tokens),0)::float as tokens
     from api_usage where workspace_id=$1 and created_at >= $2`, [ws, since]);
  const r = await rate(db, ws);
  const apiIdr = r ? api.usd * r : 0;
  return { days, income: tx.income, expense: tx.expense, apiCostUsd: api.usd, apiTokens: api.tokens, usdIdrRate: r || null,
    apiCostIdr: r ? apiIdr : null, totalExpense: tx.expense + apiIdr, net: tx.income - tx.expense - apiIdr,
    note: r ? null : 'Biaya API belum dikonversi ke Rupiah (isi kurs USD→IDR di Pengaturan). Keuntungan bersih belum memasukkan biaya API.' };
}
module.exports = { summary, rate };
