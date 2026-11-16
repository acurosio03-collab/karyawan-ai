'use strict';
const { HttpError } = require('../lib/http');
const mem = new Map();

// Pembatas in-memory per-instance (untuk lalu lintas umum)
function memLimit(key, max, windowMs) {
  const now = Date.now();
  const e = mem.get(key);
  if (!e || e.reset < now) { mem.set(key, { n: 1, reset: now + windowMs }); if (mem.size > 5000) for (const [k, v] of mem) if (v.reset < now) mem.delete(k); return; }
  e.n++;
  if (e.n > max) throw new HttpError(429, 'Terlalu banyak permintaan, coba lagi sebentar lagi', { code: 'RATE_LIMIT' });
}

// Pembatas persisten di database (cocok untuk serverless) - login & operasi mahal
async function dbLimit(db, key, max, windowSec) {
  const bucket = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
  const row = await db.one(
    `insert into rate_limits (key, window_start, count) values ($1, to_timestamp($2), 1)
     on conflict (key, window_start) do update set count = rate_limits.count + 1 returning count`, [key, bucket]);
  if (row.count > max) throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.', { code: 'RATE_LIMIT' });
  if (Math.random() < 0.02) db.exec(`delete from rate_limits where window_start < now() - interval '1 day'`).catch(() => {});
}
module.exports = { memLimit, dbLimit };
