'use strict';
const { db, health } = require('../../lib/db');
const { HttpError } = require('../../lib/http');
const { validate } = require('../../lib/validate');
const auth = require('../../security/auth');
const { memLimit, dbLimit } = require('../../security/ratelimit');
const setup = require('../../services/setup');
const { audit } = require('../../services/audit');
const integrations = require('../../services/integrations');

let DUMMY = null; // hash palsu agar waktu respons login tidak membocorkan keberadaan email
const dummy = () => DUMMY || (DUMMY = auth.hashPassword('dummy-Password-1'));
const secretOk = () => !!process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32;

module.exports = (r) => {
  // Status sistem (publik, tanpa rahasia). Aplikasi tetap bisa dibuka walau belum ada API/DB.
  r.get('/health', { public: true }, async () => {
    const h = await health();
    const integ = {};
    for (const k of Object.keys(integrations.KINDS)) integ[k] = integrations.configured(k);
    return { app: 'GERDEV AI WORKFORCE', version: '1.0.0', database: h, session_secret: secretOk(), integrations: integ, time: new Date().toISOString() };
  });

  r.get('/setup/status', { public: true }, async () => {
    const h = await health();
    return { database_configured: h.configured, database_connected: h.connected, migrated: h.migrated, has_owner: h.hasOwner, session_secret_ok: secretOk(), error: h.error };
  });

  // Pasang skema dari aplikasi (alternatif SQL Editor). Hanya selama belum ada Owner dan dengan kunci SESSION_SECRET.
  r.post('/setup/migrate', { public: true }, async (ctx) => {
    memLimit('setup:' + ctx.ip, 10, 600000);
    if (!secretOk()) throw new HttpError(503, 'SESSION_SECRET belum diatur (minimal 32 karakter)', { code: 'NOT_CONNECTED' });
    const b = validate({ setup_key: { type: 'string', required: true, max: 300, trim: false } }, ctx.body);
    if (!auth.safeEqual(b.setup_key, process.env.SESSION_SECRET)) throw new HttpError(403, 'Kunci setup salah');
    const h = await health();
    if (!h.connected) throw new HttpError(503, 'Database belum terhubung: ' + (h.error || 'DATABASE_URL belum diisi'), { code: 'NOT_CONNECTED' });
    if (h.hasOwner) throw new HttpError(409, 'Setup sudah selesai (Owner sudah ada)');
    const out = await setup.migrate();
    return { ok: true, ...out };
  });

  r.post('/setup/owner', { public: true }, async (ctx) => {
    memLimit('setup:' + ctx.ip, 10, 600000);
    if (!secretOk()) throw new HttpError(503, 'SESSION_SECRET belum diatur (minimal 32 karakter)', { code: 'NOT_CONNECTED' });
    const b = validate({
      setup_key: { type: 'string', required: true, max: 300, trim: false },
      workspace_name: { type: 'string', required: true, min: 2, max: 80 },
      name: { type: 'string', required: true, min: 2, max: 80 },
      email: { type: 'string', required: true, max: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternMsg: 'format email tidak valid' },
      password: { type: 'string', required: true, max: 200, trim: false }
    }, ctx.body);
    if (!auth.safeEqual(b.setup_key, process.env.SESSION_SECRET)) throw new HttpError(403, 'Kunci setup salah');
    auth.checkPasswordStrength(b.password);
    const h = await health();
    if (!h.connected) throw new HttpError(503, 'Database belum terhubung (NOT CONNECTED)', { code: 'NOT_CONNECTED' });
    if (!h.migrated) throw new HttpError(409, 'Skema database belum terpasang. Jalankan database/schema.sql di Neon atau gunakan tombol Pasang Skema.', { code: 'NOT_MIGRATED' });
    const user = await setup.createOwner({ workspaceName: b.workspace_name, name: b.name, email: b.email.toLowerCase(), passwordHash: auth.hashPassword(b.password) });
    if (!user) throw new HttpError(409, 'Owner sudah ada. Silakan login.');
    const s = await auth.createSession(db, ctx.req, user);
    ctx.headers['Set-Cookie'] = s.cookie; ctx.status = 201;
    return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, csrf_token: s.csrf };
  });

  r.post('/auth/login', { public: true }, async (ctx) => {
    const b = validate({ email: { type: 'string', required: true, max: 200 }, password: { type: 'string', required: true, max: 200, trim: false } }, ctx.body);
    const email = b.email.toLowerCase();
    await dbLimit(db, 'login:ip:' + ctx.ip, 20, 600);
    await dbLimit(db, 'login:em:' + email, 8, 600);
    const u = await db.one('select * from users where lower(email)=$1', [email]);
    const ok = auth.verifyPassword(b.password, u ? u.password_hash : dummy());
    if (!u || !ok || !u.active) {
      if (u) await audit({ db, workspaceId: u.workspace_id, ip: ctx.ip }, 'auth.login_failed', 'users', u.id);
      throw new HttpError(401, 'Email atau kata sandi salah', { code: 'BAD_CREDENTIALS' });
    }
    const s = await auth.createSession(db, ctx.req, u);
    ctx.headers['Set-Cookie'] = s.cookie;
    await audit({ db, workspaceId: u.workspace_id, user: u, ip: ctx.ip }, 'auth.login', 'users', u.id);
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role }, csrf_token: s.csrf };
  });

  r.post('/auth/logout', { min: 'viewer' }, async (ctx) => {
    ctx.headers['Set-Cookie'] = await auth.destroySession(db, ctx.req);
    return { ok: true };
  });

  r.get('/auth/me', async (ctx) => {
    const w = await db.one('select id, name, slug, settings from workspaces where id=$1', [ctx.workspaceId]);
    const s = ctx.session;
    return { user: { id: s.id, name: s.name, email: s.email, role: s.role }, csrf_token: s.csrf_token, workspace: { id: w.id, name: w.name, slug: w.slug, owner_name: (w.settings && w.settings.owner_name) || null } };
  });

  r.post('/auth/password', { min: 'viewer' }, async (ctx) => {
    const b = validate({ current: { type: 'string', required: true, max: 200, trim: false }, next: { type: 'string', required: true, max: 200, trim: false } }, ctx.body);
    const u = await db.one('select password_hash from users where id=$1', [ctx.user.id]);
    if (!auth.verifyPassword(b.current, u.password_hash)) throw new HttpError(400, 'Kata sandi saat ini salah');
    auth.checkPasswordStrength(b.next);
    await db.exec('update users set password_hash=$2 where id=$1', [ctx.user.id, auth.hashPassword(b.next)]);
    await db.exec('delete from sessions where user_id=$1 and id<>$2', [ctx.user.id, ctx.session.session_id]);
    await audit(ctx, 'auth.password_changed', 'users', ctx.user.id);
    return { ok: true };
  });
};
