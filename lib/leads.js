'use strict';
// Utilitas prospek bersama (tool AI + API CRM): klasifikasi domain dan kunci deduplikasi.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

const SOCIAL = ['instagram.com', 'facebook.com', 'tiktok.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'threads.net'];
const DIRECTORY = ['google.com', 'maps.google.com', 'tripadvisor.com', 'yelp.com', 'yellowpages.co.id', 'foursquare.com', 'jakartanotebook.com', 'wikipedia.org', 'detik.com', 'kompas.com', 'tribunnews.com', 'traveloka.com', 'tiket.com'];
const MARKET = ['tokopedia.com', 'shopee.co.id', 'bukalapak.com', 'lazada.co.id', 'blibli.com', 'gojek.com', 'grab.com', 'olx.co.id'];
function domainType(d) {
  const m = (list) => list.some((x) => d === x || d.endsWith('.' + x));
  if (m(SOCIAL)) return 'social'; if (m(MARKET)) return 'marketplace'; if (m(DIRECTORY)) return 'directory'; return 'own_site';
}
// Normalisasi nomor Indonesia: 08xx -> 628xx
function normalizeWa(v) {
  const d = digits(v);
  if (!d) return '';
  return d.startsWith('0') ? '62' + d.slice(1) : d;
}
function leadDedupeKey({ whatsapp, website, business_name }) {
  const wa = normalizeWa(whatsapp);
  if (wa) return 'wa:' + wa;
  const dom = website ? domainOf(website) : '';
  if (dom && domainType(dom) === 'own_site') return 'd:' + dom;
  return 'n:' + norm(business_name);
}
module.exports = { norm, digits, domainOf, domainType, normalizeWa, leadDedupeKey };
