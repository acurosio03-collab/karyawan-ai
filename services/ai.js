'use strict';
const { HttpError } = require('../lib/http');

// Harga per 1 juta token (USD) untuk model umum. Model lain: isi AI_PRICE_IN_PER_M / AI_PRICE_OUT_PER_M.
// Angka ini ESTIMASI - selalu cocokkan dengan tagihan resmi provider.
const PRICES = { 'gpt-4o-mini': [0.15, 0.6], 'gpt-4o': [2.5, 10], 'gpt-4.1': [2, 8], 'gpt-4.1-mini': [0.4, 1.6], 'gpt-4.1-nano': [0.1, 0.4] };

function providerConfig(kind = 'openai') {
  if (kind === 'alt') return { kind, key: process.env.ALT_AI_API_KEY, base: (process.env.ALT_AI_BASE_URL || '').replace(/\/$/, ''), model: process.env.ALT_AI_MODEL };
  return { kind: 'openai', key: process.env.OPENAI_API_KEY, base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), model: process.env.OPENAI_MODEL || 'gpt-4o-mini' };
}
const isConnected = (kind) => { const c = providerConfig(kind); return !!(c.key && c.base && c.model); };

function estimateCost(model, pt, ct) {
  const p = PRICES[model];
  if (p) return { usd: (pt * p[0] + ct * p[1]) / 1e6, estimated: true };
  const i = Number(process.env.AI_PRICE_IN_PER_M), o = Number(process.env.AI_PRICE_OUT_PER_M);
  if (Number.isFinite(i) && Number.isFinite(o) && (i || o)) return { usd: (pt * i + ct * o) / 1e6, estimated: true };
  return { usd: 0, estimated: true, unknownPrice: true };
}

function extractJson(text) {
  try { return JSON.parse(text); } catch { /* lanjut */ }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* lanjut */ } }
  throw new HttpError(502, 'Respons AI bukan JSON valid', { code: 'AI_BAD_JSON' });
}

async function chatJSON({ provider = 'openai', model, messages, maxTokens = 2000, timeoutMs, temperature = 0.3 }) {
  const cfg = providerConfig(provider);
  const useModel = model || cfg.model;
  if (!cfg.key || !cfg.base || !useModel) throw new HttpError(503, `Provider AI "${provider}" belum tersambung (NOT CONNECTED)`, { code: 'NOT_CONNECTED' });
  const reasoning = /^(o\d|gpt-5)/.test(useModel);
  const body = { model: useModel, messages, response_format: { type: 'json_object' } };
  if (provider === 'openai') body.max_completion_tokens = maxTokens; else body.max_tokens = maxTokens;
  if (!reasoning) body.temperature = temperature;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || Number(process.env.AI_TIMEOUT_MS) || 40000);
  let resp;
  try {
    resp = await fetch(cfg.base + '/chat/completions', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key }, body: JSON.stringify(body) });
  } catch (e) {
    if (e.name === 'AbortError') throw new HttpError(504, 'Panggilan AI melewati batas waktu', { code: 'TIMEOUT' });
    throw new HttpError(502, 'Gagal menghubungi provider AI: ' + e.message, { code: 'AI_NETWORK' });
  } finally { clearTimeout(timer); }
  if (!resp.ok) {
    const txt = (await resp.text().catch(() => '')).slice(0, 300);
    if (resp.status === 401 || resp.status === 403) throw new HttpError(503, 'API key AI ditolak provider (NOT CONNECTED): ' + txt, { code: 'NOT_CONNECTED' });
    if (resp.status === 429) throw new HttpError(429, 'Provider AI membatasi permintaan / kuota habis: ' + txt, { code: 'AI_RATE' });
    throw new HttpError(502, `Provider AI error ${resp.status}: ${txt}`, { code: 'AI_ERROR' });
  }
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new HttpError(502, 'Respons AI kosong', { code: 'AI_EMPTY' });
  const u = data.usage || {};
  const prompt = u.prompt_tokens || 0, completion = u.completion_tokens || 0;
  return { parsed: extractJson(content), raw: content, model: useModel, provider, promptTokens: prompt, completionTokens: completion, cost: estimateCost(useModel, prompt, completion) };
}
module.exports = { chatJSON, providerConfig, isConnected, estimateCost, extractJson };
