'use strict';
const ai = require('./ai');
const search = require('./search');
const { health } = require('../lib/db');
const { HttpError } = require('../lib/http');

const KINDS = {
  openai: { label: 'OpenAI API', env: ['OPENAI_API_KEY'], help: 'Isi OPENAI_API_KEY (dan opsional OPENAI_MODEL) di Vercel → Settings → Environment Variables, lalu Redeploy.' },
  alt_ai: { label: 'API Model AI Alternatif', env: ['ALT_AI_API_KEY', 'ALT_AI_BASE_URL', 'ALT_AI_MODEL'], help: 'Isi ALT_AI_API_KEY, ALT_AI_BASE_URL (API kompatibel OpenAI, mis. https://openrouter.ai/api/v1), dan ALT_AI_MODEL.' },
  web_search: { label: 'Web Search API', env: ['SEARCH_API_KEY'], help: 'Isi SEARCH_PROVIDER (tavily/brave/serper) dan SEARCH_API_KEY.' },
  database: { label: 'PostgreSQL Neon', env: ['DATABASE_URL'], help: 'Isi DATABASE_URL dari dashboard Neon (Connection string).' },
  email: { label: 'Email Provider (Resend)', env: ['RESEND_API_KEY', 'EMAIL_FROM'], help: 'Isi RESEND_API_KEY dan EMAIL_FROM (domain terverifikasi di Resend).' },
  whatsapp: { label: 'WhatsApp Business (Meta Cloud API)', env: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'], help: 'Isi WHATSAPP_TOKEN dan WHATSAPP_PHONE_NUMBER_ID dari Meta for Developers.' },
  storage: { label: 'Object Storage', env: [], unsupported: true, help: 'Belum didukung pada V1. Berkas hasil kerja disimpan di database (tabel files).' }
};
const configured = (k) => !KINDS[k].unsupported && KINDS[k].env.every((e) => !!process.env[e]);

async function getJson(url, headers) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
  try { const r = await fetch(url, { headers, signal: c.signal }); return { ok: r.ok, status: r.status, text: r.ok ? '' : (await r.text()).slice(0, 200) }; }
  catch (e) { return { ok: false, status: 0, text: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}

async function test(kind) {
  if (!KINDS[kind]) return { ok: false, error: 'Integrasi tidak dikenal' };
  if (KINDS[kind].unsupported) return { ok: false, error: 'Belum didukung pada V1' };
  if (!configured(kind)) return { ok: false, error: 'NOT CONNECTED: environment variable belum diisi (' + KINDS[kind].env.join(', ') + ')' };
  if (kind === 'database') { const h = await health(); return h.connected ? { ok: true, detail: h.migrated ? 'Terhubung, skema terpasang' : 'Terhubung, skema BELUM terpasang' } : { ok: false, error: h.error || 'Gagal terhubung' }; }
  if (kind === 'openai' || kind === 'alt_ai') {
    const c = ai.providerConfig(kind === 'alt_ai' ? 'alt' : 'openai');
    const r = await getJson(c.base + '/models', { Authorization: 'Bearer ' + c.key });
    return r.ok ? { ok: true, detail: 'API key diterima provider (model: ' + c.model + ')' } : { ok: false, error: `Provider menjawab ${r.status}: ${r.text}` };
  }
  if (kind === 'web_search') {
    try { const rs = await search.webSearch('gerdev test', 1); return { ok: true, detail: `Provider ${search.provider()} aktif (${rs.length} hasil)` }; } catch (e) { return { ok: false, error: e.message }; }
  }
  if (kind === 'email') { const r = await getJson('https://api.resend.com/domains', { Authorization: 'Bearer ' + process.env.RESEND_API_KEY }); return r.ok ? { ok: true, detail: 'API key Resend valid' } : { ok: false, error: `Resend menjawab ${r.status}: ${r.text}` }; }
  if (kind === 'whatsapp') { const r = await getJson(`https://graph.facebook.com/v20.0/${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)}`, { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN }); return r.ok ? { ok: true, detail: 'Token WhatsApp valid' } : { ok: false, error: `Meta menjawab ${r.status}: ${r.text}` }; }
  return { ok: false, error: 'Tidak ada pengujian' };
}

// Pengiriman keluar (hanya dipanggil setelah Owner menyetujui)
async function sendWhatsApp(to, text) {
  if (!configured('whatsapp')) return { sent: false, reason: 'NOT CONNECTED: WhatsApp provider belum tersambung' };
  const num = String(to).replace(/\D/g, '').replace(/^0/, '62');
  const r = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: num, type: 'text', text: { body: String(text).slice(0, 4000) } }) });
  return r.ok ? { sent: true } : { sent: false, reason: `WhatsApp API ${r.status}: ${(await r.text()).slice(0, 200)}` };
}
async function sendEmail(to, subject, text) {
  if (!configured('email')) return { sent: false, reason: 'NOT CONNECTED: Email provider belum tersambung' };
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject: subject || 'Pesan dari GERDEV', text: String(text).slice(0, 20000) }) });
  return r.ok ? { sent: true } : { sent: false, reason: `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
}

// Toggle aktif/nonaktif dari Owner (tabel integrations). Tanpa baris = aktif (selama env terisi).
async function isEnabled(db, ws, kind) {
  const r = await db.one('select enabled from integrations where workspace_id=$1 and kind=$2', [ws, kind]);
  return r ? r.enabled : true;
}
async function assertEnabled(db, ws, kind) {
  const r = await db.one('select enabled, settings from integrations where workspace_id=$1 and kind=$2', [ws, kind]);
  if (r && !r.enabled) throw new HttpError(503, `Integrasi ${KINDS[kind].label} dinonaktifkan oleh Owner (NOT CONNECTED)`, { code: 'NOT_CONNECTED' });
  // Pengaturan penggunaan: batas panggilan AI per hari (diberlakukan sungguhan)
  const lim = r && r.settings && Number(r.settings.daily_call_limit);
  if ((kind === 'openai' || kind === 'alt_ai') && lim > 0) {
    const u = await db.one("select count(*)::int as n from api_usage where workspace_id=$1 and provider=$2 and created_at >= date_trunc('day', now())", [ws, kind === 'alt_ai' ? 'alt' : 'openai']);
    if (u.n >= lim) throw new HttpError(402, `Batas panggilan harian ${KINDS[kind].label} (${lim}) tercapai`, { code: 'BUDGET_EXCEEDED' });
  }
}
module.exports = { KINDS, configured, test, sendWhatsApp, sendEmail, isEnabled, assertEnabled };
