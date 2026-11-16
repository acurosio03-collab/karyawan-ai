'use strict';
// Aplikasi API: router + middleware (rate limit, sesi, CSRF, RBAC, validasi, penanganan error).
const { createRouter, sendJson, readBody, toErrorResponse, HttpError, securityHeaders } = require('../lib/http');
const { db } = require('../lib/db');
const auth = require('../security/auth');
const { memLimit } = require('../security/ratelimit');

const router = createRouter();
for (const m of ['auth', 'dashboard', 'agents', 'tasks', 'business', 'sales', 'finance', 'system']) require('./_routes/' + m)(router);

async function handle(req, res) {
  try {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    let p = url.searchParams.get('__path');
    url.searchParams.delete('__path');
    if (p === null) p = url.pathname.replace(/^\/api\/?/, '');
    p = '/' + String(p).replace(/^\/+|\/+$/g, '');
    const ip = auth.clientIp(req);
    memLimit('ip:' + ip, 600, 60000);

    const m = router.match(req.method, p);
    if (!m) throw new HttpError(404, 'Endpoint tidak ditemukan', { code: 'NOT_FOUND' });
    const { route, params } = m;
    const opts = route.opts || {};
    const isWrite = !['GET', 'HEAD'].includes(req.method);
    const ctx = { req, res, db, params, query: Object.fromEntries(url.searchParams), ip, status: 200, headers: {}, path: p };

    if (opts.public) {
      if (isWrite) auth.checkCsrf(req, null); // cek Origin saja
    } else {
      const session = await auth.loadSession(db, req);
      if (!session) throw new HttpError(401, 'Silakan login terlebih dahulu', { code: 'UNAUTHENTICATED' });
      if (isWrite) auth.checkCsrf(req, session);
      auth.requireRole(session, opts.min || (isWrite ? 'manager' : 'viewer'));
      ctx.session = session; ctx.user = session; ctx.workspaceId = session.workspace_id;
    }
    ctx.body = isWrite ? await readBody(req) : {};
    const out = await route.handler(ctx);
    sendJson(res, ctx.status, out === undefined ? { ok: true } : out, ctx.headers);
  } catch (e) {
    const r = toErrorResponse(e);
    sendJson(res, r.status, r.body);
  }
}
module.exports = { handle, router };
