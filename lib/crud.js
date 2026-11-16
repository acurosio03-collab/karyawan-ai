'use strict';
const { HttpError } = require('./http');
const { validate } = require('./validate');
const { audit } = require('../services/audit');

const isJson = (r) => !!r && (r.type === 'json' || r.type === 'object' || (r.type === 'array' && r.jsonb));
function cols(schema, data) {
  const keys = Object.keys(data);
  return { keys, vals: keys.map((k) => (isJson(schema[k]) ? JSON.stringify(data[k]) : data[k])), casts: keys.map((k) => (isJson(schema[k]) ? '::jsonb' : '')) };
}

// Pastikan setiap referensi (ref) milik workspace yang sama - mencegah kebocoran antar workspace
async function checkRefs(db, schema, data, workspaceId) {
  for (const [k, r] of Object.entries(schema)) {
    if (r.ref && data[k]) {
      const row = await db.one(`select 1 from ${r.ref} where id=$1 and workspace_id=$2`, [data[k], workspaceId]);
      if (!row) throw new HttpError(400, `Referensi ${k} tidak ditemukan di workspace ini`);
    }
  }
}

function crud(router, o) {
  const { path, table, schema, label = table, orderBy = 'created_at desc', search = [], filters = [], methods = ['list', 'get', 'create', 'update', 'delete'], minWrite = 'manager', minDelete = 'admin', select = '*', beforeCreate, afterCreate, beforeUpdate } = o;

  if (methods.includes('list')) router.get(path, async ({ db, workspaceId, query }) => {
    const where = ['workspace_id=$1']; const p = [workspaceId];
    for (const f of filters) if (query[f]) { p.push(query[f]); where.push(`${f}=$${p.length}`); }
    if (query.q && search.length) { p.push('%' + String(query.q).slice(0, 80) + '%'); where.push('(' + search.map((c) => `${c} ilike $${p.length}`).join(' or ') + ')'); }
    const limit = Math.min(Number(query.limit) || 200, 500); const offset = Math.max(Number(query.offset) || 0, 0);
    const rows = await db.query(`select ${select} from ${table} where ${where.join(' and ')} order by ${orderBy} limit ${limit} offset ${offset}`, p);
    return { items: rows };
  });
  if (methods.includes('get')) router.get(`${path}/:id`, async ({ db, workspaceId, params }) => {
    const r = await db.one(`select ${select} from ${table} where id=$1 and workspace_id=$2`, [params.id, workspaceId]);
    if (!r) throw new HttpError(404, `${label} tidak ditemukan`);
    return r;
  });
  if (methods.includes('create')) router.post(path, { min: minWrite }, async (ctx) => {
    const { db, workspaceId, body } = ctx;
    let data = validate(schema, body);
    await checkRefs(db, schema, data, workspaceId);
    if (beforeCreate) data = (await beforeCreate(ctx, data)) || data;
    const { keys, vals, casts } = cols(schema, data);
    const extra = o.extraInsert ? o.extraInsert(ctx) : {};
    const allKeys = ['workspace_id', ...keys, ...Object.keys(extra)];
    const allVals = [workspaceId, ...vals, ...Object.values(extra)];
    const ph = allKeys.map((_, i) => `$${i + 1}${i > 0 && i <= keys.length ? casts[i - 1] : ''}`);
    const row = await db.one(`insert into ${table} (${allKeys.join(',')}) values (${ph.join(',')}) returning ${select}`, allVals);
    await audit(ctx, `${table}.create`, table, row.id);
    if (afterCreate) await afterCreate(ctx, row);
    ctx.status = 201;
    return row;
  });
  if (methods.includes('update')) router.patch(`${path}/:id`, { min: minWrite }, async (ctx) => {
    const { db, workspaceId, body, params } = ctx;
    let data = validate(schema, body, { partial: true });
    if (beforeUpdate) data = (await beforeUpdate(ctx, data)) || data;
    if (!Object.keys(data).length) throw new HttpError(400, 'Tidak ada perubahan');
    await checkRefs(db, schema, data, workspaceId);
    const { keys, vals, casts } = cols(schema, data);
    const sets = keys.map((k, i) => `${k}=$${i + 3}${casts[i]}`);
    if (o.touch) sets.push('updated_at=now()');
    const row = await db.one(`update ${table} set ${sets.join(',')} where id=$1 and workspace_id=$2 returning ${select}`, [params.id, workspaceId, ...vals]);
    if (!row) throw new HttpError(404, `${label} tidak ditemukan`);
    await audit(ctx, `${table}.update`, table, params.id, { fields: keys });
    return row;
  });
  if (methods.includes('delete')) router.delete(`${path}/:id`, { min: minDelete }, async (ctx) => {
    const n = await ctx.db.exec(`delete from ${table} where id=$1 and workspace_id=$2`, [ctx.params.id, ctx.workspaceId]);
    if (!n) throw new HttpError(404, `${label} tidak ditemukan`);
    await audit(ctx, `${table}.delete`, table, ctx.params.id);
    return { ok: true };
  });
}
module.exports = { crud, checkRefs };
