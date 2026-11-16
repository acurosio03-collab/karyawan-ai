'use strict';
const { HttpError } = require('../lib/http');

const provider = () => (process.env.SEARCH_PROVIDER || 'tavily').toLowerCase();
const isConnected = () => !!process.env.SEARCH_API_KEY;

async function jfetch(url, opts) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new HttpError(r.status === 401 || r.status === 403 ? 503 : 502, `API pencarian error ${r.status}`, { code: r.status === 401 || r.status === 403 ? 'NOT_CONNECTED' : 'SEARCH_ERROR' });
    return await r.json();
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'Gagal menghubungi API pencarian: ' + (e.name === 'AbortError' ? 'timeout' : e.message), { code: 'SEARCH_ERROR' }); }
  finally { clearTimeout(t); }
}

async function webSearch(query, max = 6) {
  const key = process.env.SEARCH_API_KEY;
  if (!key) throw new HttpError(503, 'API pencarian web belum tersambung (NOT CONNECTED). Isi SEARCH_API_KEY dan SEARCH_PROVIDER.', { code: 'NOT_CONNECTED' });
  const p = provider();
  if (p === 'brave') {
    const d = await jfetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}&country=ID`, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
    return ((d.web && d.web.results) || []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: r.description || '' }));
  }
  if (p === 'serper') {
    const d = await jfetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, num: max, gl: 'id', hl: 'id' }) });
    return (d.organic || []).slice(0, max).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || '' }));
  }
  const d = await jfetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ query, max_results: max, search_depth: 'basic' }) });
  return (d.results || []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: r.content || '' }));
}
module.exports = { webSearch, isConnected, provider };
