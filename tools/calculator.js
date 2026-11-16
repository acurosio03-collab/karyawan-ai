'use strict';
// Kalkulator aman: parser rekursif, tanpa eval/Function. Mendukung + - * / % ^ (), sqrt abs round min max.
const FUNCS = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max };

function tokenize(src) {
  const out = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const s = src.slice(i, j);
      if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) throw new Error('Angka tidak valid: ' + s);
      out.push({ t: 'num', v: parseFloat(s) }); i = j; continue;
    }
    if (/[a-z]/i.test(c)) { let j = i; while (j < src.length && /[a-z]/i.test(src[j])) j++; out.push({ t: 'id', v: src.slice(i, j).toLowerCase() }); i = j; continue; }
    if ('+-*/%^(),'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error('Karakter tidak diizinkan: ' + c);
  }
  return out;
}

function evaluate(src) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('Ekspresi kosong');
  if (src.length > 200) throw new Error('Ekspresi terlalu panjang');
  const tk = tokenize(src);
  let p = 0;
  const peek = () => tk[p]; const next = () => tk[p++];
  const expect = (t) => { const x = next(); if (!x || x.t !== t) throw new Error('Sintaks tidak valid, diharapkan ' + t); };
  function expr() { let v = term(); while (peek() && (peek().t === '+' || peek().t === '-')) { const o = next().t; const r = term(); v = o === '+' ? v + r : v - r; } return v; }
  function term() {
    let v = power();
    while (peek() && ['*', '/', '%'].includes(peek().t)) {
      const o = next().t; const r = power();
      if ((o === '/' || o === '%') && r === 0) throw new Error('Pembagian dengan nol');
      v = o === '*' ? v * r : o === '/' ? v / r : v % r;
    }
    return v;
  }
  function power() { const b = unary(); if (peek() && peek().t === '^') { next(); const e = power(); return Math.pow(b, e); } return b; }
  function unary() { if (peek() && peek().t === '-') { next(); return -unary(); } if (peek() && peek().t === '+') { next(); return unary(); } return primary(); }
  function primary() {
    const x = next();
    if (!x) throw new Error('Ekspresi tidak lengkap');
    if (x.t === 'num') return x.v;
    if (x.t === '(') { const v = expr(); expect(')'); return v; }
    if (x.t === 'id') {
      if (x.v === 'pi') return Math.PI;
      const f = FUNCS[x.v]; if (!f) throw new Error('Fungsi tidak dikenal: ' + x.v);
      expect('('); const args = [expr()]; while (peek() && peek().t === ',') { next(); args.push(expr()); } expect(')');
      return f(...args);
    }
    throw new Error('Sintaks tidak valid');
  }
  const v = expr();
  if (p < tk.length) throw new Error('Sintaks tidak valid');
  if (!Number.isFinite(v)) throw new Error('Hasil tidak terhingga');
  return v;
}
module.exports = { evaluate };
