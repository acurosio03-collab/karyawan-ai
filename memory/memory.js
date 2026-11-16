'use strict';
// Sistem memori berbasis database + pencarian relevansi (PostgreSQL full-text).
const SCOPES = ['agent_short', 'agent_long', 'company', 'business', 'task', 'customer'];

function toTsQuery(text) {
  const words = [...new Set(String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(0, 12);
  return words.join(' | ');
}

async function remember(db, { workspaceId, scope, content, agentId = null, businessUnitId = null, taskId = null, customerId = null, importance = 5, ttlHours = null }) {
  if (!SCOPES.includes(scope)) throw new Error('scope memori tidak valid');
  const text = String(content || '').trim().slice(0, 2000);
  if (!text) return null;
  const ttl = scope === 'agent_short' ? (ttlHours || 48) : ttlHours;
  return db.one(
    `insert into agent_memories (workspace_id, scope, agent_id, business_unit_id, task_id, customer_id, content, importance, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, case when $9::int is null then null else now() + ($9::int * interval '1 hour') end) returning id`,
    [workspaceId, scope, agentId, businessUnitId, taskId, customerId, text, Math.min(10, Math.max(1, importance)), ttl]);
}

// Ambil memori yang relevan untuk satu agen/tugas: hasil pencocokan teks + memori penting.
async function recall(db, { workspaceId, agentId, query, businessUnitId = null, taskId = null, customerId = null, limit = 8 }) {
  const visibility = `(scope='company' or (scope in ('agent_short','agent_long') and agent_id=$2)
    or (scope='business' and ($3::uuid is null or business_unit_id=$3)) or (scope='task' and task_id=$4) or (scope='customer' and customer_id=$5))`;
  const base = [workspaceId, agentId, businessUnitId, taskId, customerId];
  const tsq = toTsQuery(query);
  const seen = new Map();
  if (tsq) {
    const rows = await db.query(
      `select id, scope, content, importance, created_at, ts_rank(tsv, to_tsquery('simple',$6)) as rank from agent_memories
       where workspace_id=$1 and (expires_at is null or expires_at > now()) and ${visibility} and tsv @@ to_tsquery('simple',$6)
       order by rank desc, importance desc, created_at desc limit $7`, [...base, tsq, limit]);
    rows.forEach((r) => seen.set(r.id, r));
  }
  const top = await db.query(
    `select id, scope, content, importance, created_at, 0 as rank from agent_memories
     where workspace_id=$1 and (expires_at is null or expires_at > now()) and ${visibility} and importance >= 8
     order by importance desc, created_at desc limit 4`, base);
  top.forEach((r) => { if (!seen.has(r.id)) seen.set(r.id, r); });
  return [...seen.values()].slice(0, limit).map((r) => ({ scope: r.scope, content: r.content }));
}
module.exports = { remember, recall, toTsQuery, SCOPES };
