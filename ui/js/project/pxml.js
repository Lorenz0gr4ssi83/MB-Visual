// Lettore XML minimo per i piani di progetto (MSPDI, Primavera P6 XML, GanttProject): puro JavaScript, funziona anche in
// Node per i collaudi. Ogni nodo conserva la posizione nel testo (s, e) per riscrivere tali e quali gli elementi che
// l'app non gestisce (salvataggio senza perdite).
//   node = { n: "Task", a: { attr: "v" }, c: [nodi o testo], s, e }

const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export function unescapeXml(s) {
  return s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, k) => {
    if (k[0] === "#") return String.fromCodePoint(k[1] === "x" || k[1] === "X" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return ENT[k] ?? m;
  });
}
export const escapeXml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

export function parseXml(text) {
  const root = { n: "#doc", a: {}, c: [], s: 0, e: text.length };
  const stack = [root];
  let i = 0;
  const L = text.length;
  while (i < L) {
    const lt = text.indexOf("<", i);
    if (lt < 0) { addText(text.slice(i)); break; }
    if (lt > i) addText(text.slice(i, lt));
    if (text.startsWith("<!--", lt)) { const e = text.indexOf("-->", lt + 4); i = e < 0 ? L : e + 3; continue; }
    if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt + 9);
      top().c.push(text.slice(lt + 9, e < 0 ? L : e));
      i = e < 0 ? L : e + 3; continue;
    }
    if (text[lt + 1] === "?") { const e = text.indexOf("?>", lt + 2); i = e < 0 ? L : e + 2; continue; }
    if (text[lt + 1] === "!") { // DOCTYPE (anche con sottoinsieme interno tra [ ])
      let j = lt + 2, depth = 0;
      for (; j < L; j++) { const ch = text[j]; if (ch === "[") depth++; else if (ch === "]") depth--; else if (ch === ">" && depth <= 0) break; }
      i = j + 1; continue;
    }
    if (text[lt + 1] === "/") {
      const e = text.indexOf(">", lt);
      const name = text.slice(lt + 2, e).trim();
      // chiude fino al nodo con lo stesso nome (XML malformato: si tollera)
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].n === name) { while (stack.length > k) { const nd = stack.pop(); nd.e = e + 1; } break; }
      i = e + 1; continue;
    }
    // tag di apertura
    let j = lt + 1;
    while (j < L && !/[\s/>]/.test(text[j])) j++;
    const node = { n: text.slice(lt + 1, j), a: {}, c: [], s: lt, e: 0 };
    // attributi
    for (;;) {
      while (j < L && /\s/.test(text[j])) j++;
      if (text[j] === ">" || text[j] === "/" || j >= L) break;
      let k = j;
      while (k < L && !/[\s=/>]/.test(text[k])) k++;
      const an = text.slice(j, k);
      while (k < L && /\s/.test(text[k])) k++;
      if (text[k] === "=") {
        k++;
        while (k < L && /\s/.test(text[k])) k++;
        const q = text[k];
        if (q === '"' || q === "'") { const e = text.indexOf(q, k + 1); node.a[an] = unescapeXml(text.slice(k + 1, e)); j = e + 1; }
        else { let e = k; while (e < L && !/[\s>]/.test(text[e])) e++; node.a[an] = unescapeXml(text.slice(k, e)); j = e; }
      } else { node.a[an] = ""; j = k; }
    }
    top().c.push(node);
    if (text[j] === "/") { const e = text.indexOf(">", j); node.e = e + 1; i = e + 1; }
    else { stack.push(node); i = j + 1; }
  }
  while (stack.length > 1) stack.pop().e = L;
  return root;
  function top() { return stack[stack.length - 1]; }
  function addText(s) { const t = top(); if (t !== root) t.c.push(unescapeXml(s)); }
}

// nome senza prefisso dello spazio dei nomi
export const local = n => { const i = n.indexOf(":"); return i < 0 ? n : n.slice(i + 1); };
export const kids = (node, name) => node ? node.c.filter(x => typeof x === "object" && (!name || local(x.n) === name)) : [];
export const kid = (node, name) => node ? node.c.find(x => typeof x === "object" && local(x.n) === name) || null : null;
export const text = node => node ? node.c.map(x => typeof x === "string" ? x : text(x)).join("") : "";
export const val = (node, name) => { const k = kid(node, name); return k ? text(k).trim() : null; };
export function find(node, name) { // primo discendente con quel nome
  if (!node) return null;
  for (const x of node.c) if (typeof x === "object") { if (local(x.n) === name) return x; const r = find(x, name); if (r) return r; }
  return null;
}

// scrittura: [nome, valore] o elementi annidati
export function tag(name, value, attrs = null) {
  const at = attrs ? Object.entries(attrs).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join("") : "";
  if (value == null || value === "") return `<${name}${at}/>`;
  return `<${name}${at}>${Array.isArray(value) ? value.join("") : escapeXml(value)}</${name}>`;
}
