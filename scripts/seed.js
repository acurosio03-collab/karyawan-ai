#!/usr/bin/env node
'use strict';
// Mengisi ulang data awal (departemen, unit bisnis, 12 karyawan AI default, tools) untuk semua workspace. Idempotent:
// data yang sudah ada tidak diubah. Tidak membuat pelanggan/pesanan/transaksi palsu.
require('../lib/env').loadEnv();
const { db } = require('../lib/db');
const { seedWorkspace } = require('../services/setup');
(async () => {
  const ws = await db.query('select id, name from workspaces');
  if (!ws.length) { console.log('Belum ada workspace. Buat Owner pertama lewat halaman login terlebih dahulu.'); return; }
  for (const w of ws) { const r = await db.tx((t) => seedWorkspace(t, w.id)); console.log(`Workspace "${w.name}": ${r.agents} template karyawan diperiksa.`); }
})().then(() => db.close()).catch((e) => { console.error('Seed gagal:', e.message); process.exit(1); });
