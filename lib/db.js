'use strict';
const { HttpError } = require('./http');
let pool = null;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new HttpError(503, 'DATABASE_URL belum diatur (NOT CONNECTED)', { code: 'NOT_CONNECTED' });
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX) || 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
  pool.on('error', (e) => console.error('[pg pool]', e.message));
  return pool;
}

const wrap = (c) => ({
  async query(text, params) { return (await c.query(text, params)).rows; },
  async one(text, params) { return (await c.query(text, params)).rows[0] || null; },
  async exec(text, params) { return (await c.query(text, params)).rowCount; }
});

const lazy = { query: (t, p) => getPool().query(t, p) };
const db = {
  ...wrap(lazy),
  async tx(fn) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const out = await fn(wrap(client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* abaikan */ }
      throw e;
    } finally { client.release(); }
  },
  async raw(sql) { // multi-statement (untuk migrasi)
    const client = await getPool().connect();
    try { await client.query(sql); } finally { client.release(); }
  },
  async close() { if (pool) { await pool.end(); pool = null; } }
};

async function health() {
  const out = { configured: !!process.env.DATABASE_URL, connected: false, migrated: false, hasOwner: false, error: null };
  if (!out.configured) return out;
  try {
    await db.query('select 1');
    out.connected = true;
    const r = await db.one("select to_regclass('public.users') as u, to_regclass('public.schema_migrations') as m");
    out.migrated = !!(r && r.u && r.m);
    if (out.migrated) out.hasOwner = (await db.one('select count(*)::int c from users')).c > 0;
  } catch (e) { out.error = String(e.message || e).slice(0, 200); }
  return out;
}
module.exports = { db, health };
