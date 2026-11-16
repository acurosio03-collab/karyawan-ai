#!/usr/bin/env node
'use strict';
// Server pengembangan lokal: menyajikan dashboard/ dan meneruskan /api/* ke handler yang sama dengan Vercel.
require('../lib/env').loadEnv();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('../api/_app');
const cron = require('../api/cron');

const ROOT = path.join(__dirname, '..', 'dashboard');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function createServer() {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/api/cron') return cron(req, res);
    if (pathname.startsWith('/api/') || pathname === '/api') return handle(req, res);
    let f = path.normalize(path.join(ROOT, pathname === '/' ? 'index.html' : pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, 'index.html');
    res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(f).pipe(res);
  });
}
module.exports = { createServer };
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`GERDEV AI WORKFORCE berjalan di http://localhost:${port}`));
}
