'use strict';
// Validator skema ringan (tanpa dependensi). Dipakai untuk request API, input tool, dan output JSON dari AI.
class ValidationError extends Error {
  constructor(errors) {
    super('Validasi gagal: ' + Object.entries(errors).map(([k, v]) => `${k} ${v}`).join('; '));
    this.status = 400;
    this.code = 'VALIDATION';
    this.extra = { errors };
  }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkValue(key, rule, v, errors) {
  switch (rule.type) {
    case 'string': {
      if (typeof v !== 'string') { errors[key] = 'harus berupa teks'; return undefined; }
      const s = rule.trim === false ? v : v.trim();
      if (rule.min && s.length < rule.min) { errors[key] = `minimal ${rule.min} karakter`; return undefined; }
      if (s.length > (rule.max || 5000)) { errors[key] = `maksimal ${rule.max || 5000} karakter`; return undefined; }
      if (rule.pattern && !rule.pattern.test(s)) { errors[key] = rule.patternMsg || 'format tidak valid'; return undefined; }
      if (rule.values && !rule.values.includes(s)) { errors[key] = 'harus salah satu dari: ' + rule.values.join(', '); return undefined; }
      return s;
    }
    case 'number': case 'int': {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
      if (!Number.isFinite(n)) { errors[key] = 'harus berupa angka'; return undefined; }
      if (rule.type === 'int' && !Number.isInteger(n)) { errors[key] = 'harus bilangan bulat'; return undefined; }
      if (rule.min !== undefined && n < rule.min) { errors[key] = `minimal ${rule.min}`; return undefined; }
      if (rule.max !== undefined && n > rule.max) { errors[key] = `maksimal ${rule.max}`; return undefined; }
      return n;
    }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 0 || v === '0') return false;
      errors[key] = 'harus true/false'; return undefined;
    }
    case 'uuid': {
      if (typeof v !== 'string' || !UUID_RE.test(v)) { errors[key] = 'bukan UUID valid'; return undefined; }
      return v.toLowerCase();
    }
    case 'date': {
      const t = Date.parse(v);
      if (typeof v !== 'string' || Number.isNaN(t)) { errors[key] = 'tanggal tidak valid'; return undefined; }
      return new Date(t).toISOString();
    }
    case 'url': {
      try {
        const u = new URL(String(v));
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('x');
        if (String(v).length > (rule.max || 500)) throw new Error('x');
        return u.toString();
      } catch { errors[key] = 'URL http(s) tidak valid'; return undefined; }
    }
    case 'array': {
      if (!Array.isArray(v)) { errors[key] = 'harus berupa daftar'; return undefined; }
      if (v.length > (rule.max || 100)) { errors[key] = `maksimal ${rule.max || 100} item`; return undefined; }
      if (!rule.items) return v;
      const out = [];
      for (let i = 0; i < v.length; i++) {
        const sub = {};
        const r = rule.items.type === 'object'
          ? (() => { try { return validate(rule.items.shape, v[i]); } catch (e) { sub[`${key}[${i}]`] = e.message; return undefined; } })()
          : checkValue(`${key}[${i}]`, rule.items, v[i], sub);
        Object.assign(errors, sub);
        if (r !== undefined) out.push(r);
      }
      return out;
    }
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors[key] = 'harus berupa objek'; return undefined; }
      if (rule.shape) { try { return validate(rule.shape, v); } catch (e) { errors[key] = e.message; return undefined; } }
      if (JSON.stringify(v).length > (rule.maxBytes || 100000)) { errors[key] = 'terlalu besar'; return undefined; }
      return v;
    }
    case 'json': {
      if (v === null || typeof v !== 'object') { errors[key] = 'harus berupa objek/daftar JSON'; return undefined; }
      if (JSON.stringify(v).length > (rule.maxBytes || 100000)) { errors[key] = 'terlalu besar'; return undefined; }
      return v;
    }
    case 'any': return v;
    default: errors[key] = 'tipe skema tidak dikenal'; return undefined;
  }
}

function validate(schema, data, { partial = false } = {}) {
  const src = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const out = {}; const errors = {};
  for (const [key, rule] of Object.entries(schema)) {
    let v = src[key];
    if (v === undefined) {
      if (partial) continue;
      if (rule.default !== undefined) { out[key] = rule.default; continue; }
      if (rule.required) errors[key] = 'wajib diisi';
      continue;
    }
    if (v === null || (v === '' && rule.type !== 'string')) {
      if (rule.nullable || !rule.required) { out[key] = null; continue; }
      errors[key] = 'wajib diisi'; continue;
    }
    if (v === '' && rule.type === 'string') {
      if (rule.required) { errors[key] = 'wajib diisi'; continue; }
      out[key] = rule.nullable ? null : ''; continue;
    }
    const r = checkValue(key, rule, v, errors);
    if (r !== undefined) out[key] = r;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

// Ringkasan skema untuk ditampilkan ke AI / disimpan di tabel tools
function describeSchema(schema) {
  const o = {};
  for (const [k, r] of Object.entries(schema)) {
    let d = r.type + (r.required ? ' (wajib)' : '');
    if (r.values) d += ' ∈ ' + r.values.join('|');
    if (r.min !== undefined && r.type !== 'string') d += ` min=${r.min}`;
    if (r.max !== undefined && r.type !== 'string') d += ` max=${r.max}`;
    if (r.desc) d += ' — ' + r.desc;
    o[k] = d;
  }
  return o;
}
module.exports = { validate, ValidationError, describeSchema, UUID_RE };
