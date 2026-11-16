#!/usr/bin/env node
'use strict';
// Menjalankan migrasi database: node scripts/migrate.js  (membutuhkan DATABASE_URL)
require('../lib/env').loadEnv();
const { db } = require('../lib/db');
const { migrate } = require('../services/setup');
migrate().then((r) => { console.log(r.ran.length ? 'Migrasi dijalankan: ' + r.ran.join(', ') : 'Skema sudah terbaru.'); return db.close(); })
  .catch((e) => { console.error('Migrasi gagal:', e.message); process.exit(1); });
