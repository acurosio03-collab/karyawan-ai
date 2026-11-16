'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('../lib/db');
const { TEMPLATES, DEPARTMENTS } = require('../agents/templates');
const UNITS = require('../businesses/units');
const tools = require('../tools');
const memory = require('../memory/memory');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function migrate() {
  await db.query('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
  const applied = new Set((await db.query('select version from schema_migrations')).map((r) => r.version));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const ran = [];
  for (const f of files) {
    const v = f.replace(/\.sql$/, '');
    if (applied.has(v)) continue;
    await db.raw(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    await db.exec('insert into schema_migrations (version) values ($1) on conflict do nothing', [v]);
    ran.push(v);
  }
  return { ran, total: files.length };
}

// Isi data awal untuk satu workspace: departemen, 4 unit bisnis, 12 karyawan AI default, tools, memori perusahaan.
// Idempotent. TIDAK membuat data transaksi/pelanggan/pesanan palsu.
async function seedWorkspace(tx, workspaceId) {
  for (const d of DEPARTMENTS) await tx.exec('insert into departments (workspace_id, name) values ($1,$2) on conflict do nothing', [workspaceId, d]);
  for (const u of UNITS) await tx.exec('insert into business_units (workspace_id, code, name, description, services) values ($1,$2,$3,$4,$5::jsonb) on conflict (workspace_id, code) do nothing', [workspaceId, u.code, u.name, u.description, JSON.stringify(u.services)]);
  const ids = {};
  for (const t of TEMPLATES) {
    const r = await tx.one(
      `insert into agents (workspace_id, name, avatar, title, department, description, goal, system_prompt, skills, tools, permissions, role_key, is_manager, template_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
       on conflict (workspace_id, name) do update set updated_at = agents.updated_at returning id`,
      [workspaceId, t.name, t.avatar, t.title, t.department, t.description, t.goal, t.system_prompt, t.skills, t.tools, JSON.stringify({ delegate: !!t.is_manager }), t.role_key, t.is_manager, t.key]);
    ids[t.key] = r.id;
  }
  for (const t of TEMPLATES) if (t.reports_to && ids[t.reports_to]) await tx.exec('update agents set reports_to=$2 where id=$1 and reports_to is null', [ids[t.key], ids[t.reports_to]]);
  await tools.seedTools(tx, workspaceId);
  const has = await tx.one("select 1 from agent_memories where workspace_id=$1 and scope='company' limit 1", [workspaceId]);
  if (!has) {
    await memory.remember(tx, { workspaceId, scope: 'company', importance: 9, content: 'Perusahaan: GERDEV AI WORKFORCE, pemilik Gerdy Hendraman. Unit bisnis: GERDEV Digital Agency, Digital Products, Creative Marketing, Online Commerce. Bahasa kerja: Indonesia.' });
    await memory.remember(tx, { workspaceId, scope: 'company', importance: 10, content: 'Aturan perusahaan: jangan mengarang data pelanggan/nomor WhatsApp/alamat; semua tindakan keluar (pesan, penawaran, invoice, deploy, pembayaran) wajib persetujuan Owner.' });
  }
  return { agents: Object.keys(ids).length };
}

async function createOwner({ workspaceName, name, email, passwordHash }) {
  return db.tx(async (t) => {
    const lock = await t.one('select count(*)::int c from users');
    if (lock.c > 0) return null;
    const slug = String(workspaceName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'gerdev';
    const ws = await t.one('insert into workspaces (name, slug) values ($1,$2) returning id', [workspaceName, slug]);
    const user = await t.one("insert into users (workspace_id, email, name, password_hash, role) values ($1,$2,$3,$4,'owner') returning id, workspace_id, email, name, role", [ws.id, email, name, passwordHash]);
    await seedWorkspace(t, ws.id);
    await t.exec("insert into audit_logs (workspace_id, user_id, action, entity, entity_id) values ($1,$2,'setup.owner_created','users',$3::text)", [ws.id, user.id, String(user.id)]);
    return user;
  });
}
module.exports = { migrate, seedWorkspace, createOwner };
