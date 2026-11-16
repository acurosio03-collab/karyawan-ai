'use strict';
// Generator website statis berbasis template (deterministik). Konten diisi dari input nyata; tidak ada data kontak yang dikarang.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'situs';

function buildSite(p) {
  const primary = p.primary_color || '#0b1b3a', accent = p.accent_color || '#10b981';
  const wa = p.whatsapp ? p.whatsapp.replace(/\D/g, '') : '';
  const waLink = wa ? `https://wa.me/${wa.replace(/^0/, '62')}?text=${encodeURIComponent('Halo ' + p.business_name + ', saya ingin bertanya.')}` : '';
  const services = (p.services || []);
  const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.business_name)}${p.category ? ' - ' + esc(p.category) : ''}</title>
<meta name="description" content="${esc(p.tagline || p.description || p.business_name)}">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="top"><strong>${esc(p.business_name)}</strong>${waLink ? `<a class="btn" href="${esc(waLink)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</header>
<main>
<section class="hero"><h1>${esc(p.tagline || p.business_name)}</h1>${p.description ? `<p>${esc(p.description)}</p>` : ''}${waLink ? `<a class="btn big" href="${esc(waLink)}" target="_blank" rel="noopener">Hubungi Kami</a>` : ''}</section>
${services.length ? `<section class="sec"><h2>Layanan</h2><div class="grid">${services.map((s) => `<article class="card"><h3>${esc(s.name)}</h3>${s.desc ? `<p>${esc(s.desc)}</p>` : ''}</article>`).join('')}</div></section>` : ''}
${p.address ? `<section class="sec"><h2>Lokasi</h2><p>${esc(p.address)}</p></section>` : ''}
</main>
<footer>&copy; <span id="y"></span> ${esc(p.business_name)}</footer>
<script src="script.js"></script>
</body>
</html>
`;
  const css = `:root{--p:${primary};--a:${accent}}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.6}
.top{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;background:var(--p);color:#fff;position:sticky;top:0}
.btn{background:var(--a);color:#fff;text-decoration:none;padding:8px 16px;border-radius:999px;font-weight:600}.btn.big{display:inline-block;padding:12px 26px;margin-top:12px}
.hero{padding:64px 20px;text-align:center;background:linear-gradient(160deg,var(--p),#000);color:#fff}.hero h1{margin:0 0 10px;font-size:clamp(1.8rem,6vw,3rem)}.hero p{max-width:640px;margin:0 auto;opacity:.9}
.sec{padding:40px 20px;max-width:1000px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.card{border:1px solid #e2e8f0;border-radius:14px;padding:18px}.card h3{margin:0 0 6px;color:var(--p)}footer{text-align:center;padding:24px;color:#64748b;font-size:.9rem}
`;
  const js = `document.getElementById('y').textContent=new Date().getFullYear();\n`;
  const base = `sites/${slugify(p.business_name)}`;
  return [
    { name: `${base}/index.html`, content: html, mime: 'text/html' },
    { name: `${base}/style.css`, content: css, mime: 'text/css' },
    { name: `${base}/script.js`, content: js, mime: 'text/javascript' }
  ];
}
module.exports = { buildSite, slugify, esc };
