'use strict';
// Worker terjadwal (Vercel Cron / pemicu eksternal). Menjalankan jadwal yang jatuh tempo lalu memproses antrean
// dalam batas waktu fungsi serverless. Bila CRON_SECRET diisi, wajib "Authorization: Bearer <CRON_SECRET>".
const { sendJson, toErrorResponse, HttpError } = require('../lib/http');
const { db } = require('../lib/db');
const { safeEqual } = require('../security/auth');
const { memLimit } = require('../security/ratelimit');
const queue = require('../engine/queue');

module.exports = async (req, res) => {
  try {
    memLimit('cron', 30, 60000);
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!got || !safeEqual(got, secret)) throw new HttpError(401, 'Tidak diizinkan');
    }
    const out = await queue.tick(db, { budgetMs: 50000, maxTasks: 10 });
    sendJson(res, 200, { ok: true, ...out });
  } catch (e) { const r = toErrorResponse(e); sendJson(res, r.status, r.body); }
};
