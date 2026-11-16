'use strict';
const crypto = require('crypto');
const { HttpError, parseCookies } = require('../lib/http');

const COOKIE = 'gw_session';
const SESSION_DAYS = 7;
const ROLE_RANK = { viewer: 1, manager: 2, admin: 3, owner: 4 };

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError(503, 'SESSION_SECRET belum diatur atau kurang dari 32 karakter (NOT CONNECTED)', { code: 'NOT_CONNECTED' });
  return s;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const h = crypto.scryptSync(pw, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(h, expected);
  } catch { return false; }
}
function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Kata sandi minimal 10 karakter');
  if (pw.length > 200) throw new HttpError(400, 'Kata sandi terlalu panjang');
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) throw new HttpError(400, 'Kata sandi harus mengandung huruf dan angka');
}
const tokenHash = (t) => crypto.createHmac('sha256', secret()).update(t).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function isHttps(req) { return (req.headers['x-forwarded-proto'] || '').includes('https') || process.env.VERCEL === '1'; }
function cookieString(req, value, maxAge) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

async function createSession(db, req, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.exec(
    `insert into sessions (token_hash, user_id, workspace_id, csrf_token, ip, user_agent, expires_at) values ($1,$2,$3,$4,$5,$6,$7)`,
    [tokenHash(token), user.id, user.workspace_id, csrf, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200), expires]);
  await db.exec('update users set last_login_at=now() where id=$1', [user.id]);
  if (Math.random() < 0.05) db.exec('delete from sessions where expires_at < now()').catch(() => {});
  return { cookie: cookieString(req, token, SESSION_DAYS * 86400), csrf };
}

async function loadSession(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = await db.one(
    `select s.id as session_id, s.csrf_token, u.id, u.workspace_id, u.email, u.name, u.role, u.active
     from sessions s join users u on u.id = s.user_id
     where s.token_hash=$1 and s.expires_at > now()`, [tokenHash(token)]);
  if (!row || !row.active) return null;
  return row;
}
async function destroySession(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await db.exec('delete from sessions where token_hash=$1', [tokenHash(token)]);
  return cookieString(req, '', 0);
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function requireRole(user, min) {
  if ((ROLE_RANK[user.role] || 0) < (ROLE_RANK[min] || 99)) throw new HttpError(403, 'Anda tidak memiliki izin untuk tindakan ini', { code: 'FORBIDDEN' });
}
// Perlindungan CSRF: header token (double-submit via sesi) + cek Origin bila ada
function checkCsrf(req, session) {
  const origin = req.headers.origin;
  if (origin) {
    let host; try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Origin tidak valid', { code: 'CSRF' }); }
    if (host !== req.headers.host) throw new HttpError(403, 'Origin tidak diizinkan', { code: 'CSRF' });
  }
  if (session && !safeEqual(req.headers['x-csrf-token'] || '', session.csrf_token)) throw new HttpError(403, 'Token CSRF tidak valid. Muat ulang halaman.', { code: 'CSRF' });
}
module.exports = { hashPassword, verifyPassword, checkPasswordStrength, createSession, loadSession, destroySession, clientIp, requireRole, checkCsrf, safeEqual, secret, ROLE_RANK, cookieString };
