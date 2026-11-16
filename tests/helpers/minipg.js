'use strict';
// Klien PostgreSQL minimal (protokol wire v3, auth trust/cleartext) HANYA untuk pengujian lokal tanpa paket "pg".
// Di produksi aplikasi memakai paket resmi "pg" (lihat package.json). API yang ditiru: Pool{query,connect,end,on}, client{query,release}.
const net = require('net');
const { EventEmitter } = require('events');

const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s) => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
const msg = (type, body) => Buffer.concat([Buffer.from(type), i32(body.length + 4), body]);

function pgArray(arr) { return '{' + arr.map((x) => (x === null || x === undefined ? 'NULL' : Array.isArray(x) ? pgArray(x) : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}'; }
function ser(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return pgArray(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function parseArray(s) {
  const out = []; let i = 1;
  while (i < s.length - 1) {
    if (s[i] === '"') { let j = i + 1, str = ''; while (s[j] !== '"') { if (s[j] === '\\') j++; str += s[j++]; } out.push(str); i = j + 2; }
    else { let j = i; while (j < s.length - 1 && s[j] !== ',') j++; const t = s.slice(i, j); out.push(t === 'NULL' ? null : t); i = j + 1; }
  }
  return out;
}
function parseVal(oid, s) {
  if (s === null) return null;
  switch (oid) {
    case 16: return s === 't';
    case 21: case 23: case 26: return parseInt(s, 10);
    case 700: case 701: return parseFloat(s);
    case 114: case 3802: return JSON.parse(s);
    case 1082: return new Date(s + 'T00:00:00');
    case 1114: return new Date(s.replace(' ', 'T') + 'Z');
    case 1184: return new Date(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    case 1009: case 1015: return parseArray(s);
    case 1007: return parseArray(s).map((x) => (x === null ? null : parseInt(x, 10)));
    default: return s;
  }
}

class Client extends EventEmitter {
  constructor(cfg) { super(); this.cfg = cfg; this.buf = Buffer.alloc(0); this.chain = Promise.resolve(); this.handler = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.cfg.port, this.cfg.host);
      this.sock.on('error', (e) => { if (this.handler) this.handler.fail(e); else reject(e); });
      this.sock.on('close', () => { this.closed = true; });
      this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
      this.startup = { resolve, reject };
      const params = Buffer.concat([cstr('user'), cstr(this.cfg.user), cstr('database'), cstr(this.cfg.database), Buffer.from([0])]);
      this.sock.write(Buffer.concat([i32(params.length + 8), i32(196608), params]));
    });
  }
  drain() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const type = String.fromCharCode(this.buf[0]); const body = this.buf.subarray(5, 1 + len);
      this.buf = this.buf.subarray(1 + len);
      this.onMessage(type, body);
    }
  }
  onMessage(type, b) {
    if (this.startup) {
      if (type === 'R') { const code = b.readInt32BE(0); if (code === 3) this.sock.write(msg('p', cstr(this.cfg.password || ''))); else if (code !== 0) { this.startup.reject(new Error('auth tidak didukung shim: ' + code)); } }
      else if (type === 'E') { this.startup.reject(this.parseErr(b)); }
      else if (type === 'Z') { const s = this.startup; this.startup = null; s.resolve(this); }
      return;
    }
    if (this.handler) this.handler.on(type, b);
  }
  parseErr(b) {
    const f = {}; let i = 0;
    while (i < b.length && b[i] !== 0) { const k = String.fromCharCode(b[i]); const e = b.indexOf(0, i + 1); f[k] = b.toString('utf8', i + 1, e); i = e + 1; }
    const err = new Error(f.M); err.code = f.C; err.severity = f.S; err.detail = f.D; return err;
  }
  query(text, params) {
    const run = () => new Promise((resolve, reject) => {
      let fields = null; let rows = []; let tag = ''; let error = null; let result = null;
      this.handler = {
        fail: (e) => { this.handler = null; reject(e); },
        on: (type, b) => {
          if (type === 'T') {
            const n = b.readInt16BE(0); let i = 2; fields = [];
            for (let k = 0; k < n; k++) { const e = b.indexOf(0, i); const name = b.toString('utf8', i, e); i = e + 1; const oid = b.readInt32BE(i + 6); fields.push({ name, oid }); i += 18; }
            rows = [];
          } else if (type === 'D') {
            const n = b.readInt16BE(0); let i = 2; const row = {};
            for (let k = 0; k < n; k++) { const l = b.readInt32BE(i); i += 4; let s = null; if (l >= 0) { s = b.toString('utf8', i, i + l); i += l; } row[fields[k].name] = parseVal(fields[k].oid, s); }
            rows.push(row);
          } else if (type === 'C') { tag = b.toString('utf8', 0, b.length - 1); result = { rows, rowCount: /(\d+)$/.test(tag) ? parseInt(/(\d+)$/.exec(tag)[1], 10) : 0, command: tag.split(' ')[0] }; rows = []; }
          else if (type === 'E') { error = this.parseErr(b); }
          else if (type === 'Z') { this.handler = null; if (error) reject(error); else resolve(result || { rows: [], rowCount: 0 }); }
        }
      };
      if (!params || !params.length) {
        this.sock.write(msg('Q', cstr(text)));
      } else {
        const vals = params.map(ser);
        const bind = Buffer.concat([cstr(''), cstr(''), i16(0), i16(vals.length), ...vals.map((v) => (v === null ? i32(-1) : Buffer.concat([i32(Buffer.byteLength(v)), Buffer.from(v, 'utf8')]))), i16(0)]);
        this.sock.write(Buffer.concat([msg('P', Buffer.concat([cstr(''), cstr(text), i16(0)])), msg('B', bind), msg('D', Buffer.concat([Buffer.from('P'), cstr('')])), msg('E', Buffer.concat([cstr(''), i32(0)])), msg('S', Buffer.alloc(0))]));
      }
    });
    const p = this.chain.then(run, run); this.chain = p.catch(() => {}); return p;
  }
  release() { if (this.pool) this.pool.release(this); }
  end() { this.sock.end(); }
}

class Pool extends EventEmitter {
  constructor(o = {}) {
    super();
    const u = new URL(o.connectionString);
    this.cfg = { host: u.hostname, port: Number(u.port) || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) };
    this.max = o.max || 4; this.idle = []; this.all = new Set(); this.waiters = [];
  }
  async connect() {
    const c = this.idle.pop();
    if (c && !c.closed) return c;
    if (this.all.size >= this.max) return new Promise((res) => this.waiters.push(res));
    const cl = new Client(this.cfg); cl.pool = this; this.all.add(cl); await cl.connect(); return cl;
  }
  release(c) { const w = this.waiters.shift(); if (w) w(c); else this.idle.push(c); }
  async query(t, p) { const c = await this.connect(); try { return await c.query(t, p); } finally { this.release(c); } }
  async end() { for (const c of this.all) c.end(); this.all.clear(); this.idle = []; }
}
module.exports = { Pool, Client };
