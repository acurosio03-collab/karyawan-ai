#!/usr/bin/env node
'use strict';
// Pemeriksaan statis proyek (tanpa database): sintaks, import, endpoint vs frontend, skema, keamanan secret.
// Jalankan: npm run check
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', '.vercel']);
let failed = 0;
const ok = (m) => console.log('  OK   ' + m);
const bad = (m) => { failed++; console.log('  GAGAL ' + m); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const js = files.filter((f) => f.endsWith('.js'));
const rel = (f) => path.relative(ROOT, f);

console.log('1. Sintaks JavaScript');
let syntaxBad = 0;
for (const f of js) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { syntaxBad++; bad(rel(f) + ': ' + (r.stderr || '').split('\n').slice(0, 3).join(' ')); }
}
if (!syntaxBad) ok(`${js.length} file lolos node --check`);

console.log('2. Import relatif (require)');
let impBad = 0;
for (const f of js.filter((x) => !x.includes(path.sep + 'dashboard' + path.sep))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!['', '.js', '.json', '/index.js'].some((s) => fs.existsSync(target + s) && fs.statSync(target + s).isFile())) { impBad++; bad(`${rel(f)}: import tidak ditemukan ${m[1]}`); }
  }
}
if (!impBad) ok('semua import relatif ditemukan');

console.log('3. Skema database');
const REQUIRED = 'workspaces users agents agent_runs tasks task_dependencies agent_messages agent_memories tools tool_logs business_units leads customers products orders invoices transactions approvals schedules api_usage audit_logs'.split(' ');
const sql = fs.readFileSync(path.join(ROOT, 'migrations', '001_init.sql'), 'utf8');
const sqlInstall = fs.readFileSync(path.join(ROOT, 'database', 'schema.sql'), 'utf8');
const have = new Set([...sql.matchAll(/create table if not exists\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase()));
const miss = REQUIRED.filter((t) => !have.has(t));
miss.length ? bad('tabel wajib hilang: ' + miss.join(', ')) : ok(`${REQUIRED.length} tabel wajib ada (${have.size} tabel total)`);
sql === sqlInstall ? ok('database/schema.sql identik dengan migrations/001_init.sql') : bad('database/schema.sql berbeda dari migrations/001_init.sql');
/kasirpro/i.test(sql) && !/HARUS terpisah/.test(sql) ? bad('skema menyebut KASIRPRO') : ok('skema tidak menyentuh database lain');

console.log('4. Endpoint backend vs panggilan frontend');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'check-secret-check-secret-check-secret-1234';
const { router } = require('../api/_app');
const METHODS = { get: 'GET', post: 'POST', patch: 'PATCH', put: 'PUT', del: 'DELETE' };
let epBad = 0; let epTotal = 0;
for (const f of js.filter((x) => x.includes(path.join('dashboard', 'assets')))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/api\.(get|post|patch|put|del)\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
    let p = m[2].slice(1, -1).replace(/^\/\$\{kind\}/, '/leads').replace(/\$\{[^}]*\}\s*$/, '@@').replace(/\$\{[^}]*\}/g, 'x').split('?')[0];
    if (!p.startsWith('/')) continue;
    if (p.endsWith('/') || p.includes('//')) continue; // dirangkai dinamis (mis. '/agents/' + id)
    epTotal++;
    const cands = p.includes('@@') ? ['payments', 'refund', 'invoice', 'cancel', 'retry', 'accept', 'revise'].map((c) => p.replace('@@', c)) : [p];
    if (!cands.some((c) => router.match(METHODS[m[1]], c) || router.match(METHODS[m[1]], c + '/x'))) { epBad++; bad(`${rel(f)}: ${METHODS[m[1]]} ${p} tidak punya route`); }
  }
}
if (!epBad) ok(`${epTotal} panggilan API frontend semuanya cocok dengan route backend`);

console.log('5. Keamanan secret');
let secBad = 0;
for (const f of files.filter((x) => x.includes(path.join('dashboard')))) {
  const s = fs.readFileSync(f, 'utf8');
  if (/process\.env|sk-[A-Za-z0-9]{20,}|DATABASE_URL\s*=|postgres(ql)?:\/\/[^\s'"]*:[^\s'"]*@/.test(s)) { secBad++; bad(rel(f) + ': kemungkinan ada secret/env di frontend'); }
}
if (!secBad) ok('tidak ada secret/env di folder dashboard');
if (files.some((f) => /(^|\/)\.env$/.test(rel(f)))) bad('ada file .env di proyek (jangan di-commit)'); else ok('tidak ada file .env');
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
/\.env/.test(gi) && /node_modules/.test(gi) ? ok('.gitignore melindungi .env dan node_modules') : bad('.gitignore kurang lengkap');

console.log('6. File wajib');
for (const f of ['package.json', 'vercel.json', '.env.example', 'README.md', 'database/schema.sql', 'dashboard/index.html', 'api/index.js', 'api/cron.js']) {
  fs.existsSync(path.join(ROOT, f)) ? ok(f) : bad('hilang: ' + f);
}

console.log(failed ? `\n${failed} pemeriksaan GAGAL.` : '\nSemua pemeriksaan statis lolos.');
process.exit(failed ? 1 : 0);
