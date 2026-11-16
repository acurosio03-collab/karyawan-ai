'use strict';
// Catatan audit. ctx: {db, workspaceId, user, ip}. Gagal mencatat tidak boleh menggagalkan permintaan utama.
async function audit(ctx, action, entity, entityId, details) {
  try {
    await ctx.db.exec(
      `insert into audit_logs (workspace_id, user_id, agent_id, action, entity, entity_id, details, ip) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [ctx.workspaceId, ctx.user ? ctx.user.id : null, ctx.agentId || null, action, entity || null, entityId ? String(entityId) : null, details ? JSON.stringify(details) : null, ctx.ip || null]);
  } catch (e) { console.error('[audit]', e.message); }
}
module.exports = { audit };
