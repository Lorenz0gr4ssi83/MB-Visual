// Espressioni dei parametri del modello (es. "L/2 + 5", "2*pi*r", "sqrt(a^2+b^2)"): numeri, + - * / ^, parentesi,
// funzioni matematiche, costanti pi ed e, nomi dei parametri. Nessun eval: analisi a discesa ricorsiva.
// Unita': i numeri sono millimetri (lunghezze) o gradi (angoli); "mm", "cm", "m", "in", "deg" dopo un numero lo convertono.

const FN = {
  sin: x => Math.sin(x * Math.PI / 180), cos: x => Math.cos(x * Math.PI / 180), tan: x => Math.tan(x * Math.PI / 180),
  asin: x => Math.asin(x) * 180 / Math.PI, acos: x => Math.acos(x) * 180 / Math.PI, atan: x => Math.atan(x) * 180 / Math.PI,
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, ln: Math.log, log: Math.log10, exp: Math.exp,
  min: Math.min, max: Math.max,
};
const UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1, "°": 1 };

export class ExprError extends Error {}

function tokens(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    // virgola decimale (10,5) solo se seguita da una cifra: "min(2, 3)" resta una lista di argomenti
    if (/[0-9.]/.test(c) || (c === "," && /[0-9]/.test(s[i + 1] || "") && /[0-9]/.test(s[i - 1] || ""))) {
      let j = i;
      for (;;) {
        const d = s[j];
        if (d === undefined) break;
        if (/[0-9.]/.test(d) || (d === "," && /[0-9]/.test(s[j + 1] || ""))) { j++; continue; }
        if (/[eE]/.test(d) && /[0-9]/.test(s[j + 1] || "")) { j += 1; continue; }
        if (/[eE]/.test(d) && /[+-]/.test(s[j + 1] || "") && /[0-9]/.test(s[j + 2] || "")) { j += 2; continue; }
        break;
      }
      const v = parseFloat(s.slice(i, j).replace(",", "."));
      if (!isFinite(v)) throw new ExprError(s);
      out.push({ k: "n", v });
      i = j;
      continue;
    }
    if (/[A-Za-z_°]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_°]/.test(s[j])) j++;
      out.push({ k: "id", v: s.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/^(),;".includes(c)) { out.push({ k: c }); i++; continue; }
    throw new ExprError(s);
  }
  return out;
}

// valuta l'espressione; vars = nome -> numero (o funzione che lo calcola)
export function evalExpr(src, vars = {}) {
  if (typeof src === "number") return src;
  if (src === null || src === undefined || src === "") throw new ExprError("");
  const tk = tokens(String(src));
  let p = 0;
  const peek = () => tk[p], next = () => tk[p++];
  const want = k => { if (tk[p]?.k !== k) throw new ExprError(src); p++; };
  function primary() {
    const t = next();
    if (!t) throw new ExprError(src);
    if (t.k === "n") {
      // unita' subito dopo il numero
      if (peek()?.k === "id" && UNITS[peek().v.toLowerCase()] !== undefined) return t.v * UNITS[next().v.toLowerCase()];
      return t.v;
    }
    if (t.k === "(") { const v = sum(); want(")"); return v; }
    if (t.k === "-") return -factor();
    if (t.k === "+") return factor();
    if (t.k === "id") {
      const name = t.v;
      if (peek()?.k === "(") {
        next();
        const args = [sum()];
        while (peek()?.k === "," || peek()?.k === ";") { next(); args.push(sum()); }
        want(")");
        const f = FN[name.toLowerCase()];
        if (!f) throw new ExprError(name);
        return f(...args);
      }
      if (name.toLowerCase() === "pi") return Math.PI;
      if (name === "e") return Math.E;
      if (!(name in vars)) throw new ExprError(name);
      const v = vars[name];
      return typeof v === "function" ? v() : v;
    }
    throw new ExprError(src);
  }
  function factor() {
    let v = primary();
    if (peek()?.k === "^") { next(); v = Math.pow(v, factor()); }
    return v;
  }
  function term() {
    let v = factor();
    for (;;) {
      const t = peek();
      if (t?.k === "*") { next(); v *= factor(); }
      else if (t?.k === "/") { next(); v /= factor(); }
      else return v;
    }
  }
  function sum() {
    let v = term();
    for (;;) {
      const t = peek();
      if (t?.k === "+") { next(); v += term(); }
      else if (t?.k === "-") { next(); v -= term(); }
      else return v;
    }
  }
  const v = sum();
  if (p !== tk.length || !isFinite(v)) throw new ExprError(src);
  return v;
}

// parametri del documento [{name, expr}] -> nome -> valore (in ordine di dipendenza; cicli = errore sul parametro)
export function evalParams(params = []) {
  const byName = new Map(params.map(p => [p.name, p]));
  const vals = {}, errs = {}, busy = new Set();
  const get = name => {
    if (name in vals) return vals[name];
    if (busy.has(name)) throw new ExprError(name);
    busy.add(name);
    try { vals[name] = evalExpr(byName.get(name).expr, proxy); }
    finally { busy.delete(name); }
    return vals[name];
  };
  const proxy = new Proxy({}, { has: (_t, k) => byName.has(k), get: (_t, k) => () => get(k) });
  for (const p of params) { try { get(p.name); } catch (e) { errs[p.name] = e.message || "?"; } }
  return { vals, errs };
}

export const validName = s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !FN[s.toLowerCase()] && !["pi", "e"].includes(s.toLowerCase());
