// Firme digitali nel browser (web app): lettura BER/DER, buste CMS/PKCS#7 (CAdES), TSD, M7M, firme PAdES nei PDF.
// Verifica integrita' (impronta) e firma crittografica con WebCrypto; catena di fiducia AgID e revoca non verificate.

// ---------------------------------------------------------------- lettore ASN.1 BER/DER
function readNode(b, pos) {
  const start = pos;
  const t = b[pos++];
  let tag = t & 0x1f;
  if (tag === 0x1f) { tag = 0; let c; do { c = b[pos++]; tag = (tag << 7) | (c & 0x7f); } while (c & 0x80); }
  let len = b[pos++];
  let indefinite = false;
  if (len === 0x80) indefinite = true;
  else if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[pos++]; }
  const node = { cls: t >> 6, constructed: !!(t & 0x20), tag, start, hdr: pos - start, children: null, b };
  if (node.constructed) {
    node.children = [];
    if (indefinite) {
      while (!(b[pos] === 0 && b[pos + 1] === 0)) { const ch = readNode(b, pos); node.children.push(ch); pos = ch.end; }
      pos += 2;
    } else {
      const end = pos + len;
      while (pos < end) { const ch = readNode(b, pos); node.children.push(ch); pos = ch.end; }
    }
    node.end = pos;
    node.vstart = start + node.hdr;
  } else {
    node.vstart = pos;
    node.end = pos + len;
  }
  return node;
}
const parse = b => readNode(b, 0);
const val = n => n.b.subarray(n.vstart, n.end);
const raw = n => n.b.subarray(n.start, n.end);
// contenuto di un OCTET STRING anche se spezzato in parti (BER costruito)
function octets(n) {
  if (!n.constructed) return val(n);
  const parts = n.children.map(octets);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function oid(n) {
  const v = val(n);
  const out = [Math.floor(v[0] / 40), v[0] % 40];
  let x = 0;
  for (let i = 1; i < v.length; i++) { x = x * 128 + (v[i] & 0x7f); if (!(v[i] & 0x80)) { out.push(x); x = 0; } }
  return out.join(".");
}
function str(n) {
  const v = val(n);
  if (n.tag === 30) { let s = ""; for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i] << 8) | v[i + 1]); return s; } // BMPString
  try { return new TextDecoder("utf-8", { fatal: true }).decode(v); } catch { return new TextDecoder("latin1").decode(v); }
}
function time(n) {
  const s = str(n);
  let y, rest;
  if (n.tag === 23) { y = +s.slice(0, 2); y += y < 50 ? 2000 : 1900; rest = s.slice(2); } else { y = +s.slice(0, 4); rest = s.slice(4); }
  return new Date(Date.UTC(y, +rest.slice(0, 2) - 1, +rest.slice(2, 4), +rest.slice(4, 6), +rest.slice(6, 8), +(rest.slice(8, 10) || 0)));
}
const fmtDate = d => (d ? d.toLocaleString("it-IT") : null);
const hex = u => [...u].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();

// ---------------------------------------------------------------- certificati
const NAMES = { "2.5.4.3": "common_name", "2.5.4.5": "serial_number", "2.5.4.42": "given_name", "2.5.4.4": "surname", "2.5.4.10": "organization_name",
  "2.5.4.12": "title", "2.5.4.6": "country_name", "1.2.840.113549.1.9.1": "email_address", "2.5.4.11": "ou" };
function nameDict(n) {
  const out = {};
  for (const rdn of n.children || []) for (const atv of rdn.children || []) { const k = NAMES[oid(atv.children[0])]; if (k) out[k] = str(atv.children[1]); }
  return out;
}
function parseCert(c) {
  const tbs = c.children[0];
  let i = 0;
  if (tbs.children[0].cls === 2 && tbs.children[0].tag === 0) i = 1; // versione
  const serial = val(tbs.children[i]);
  const issuer = tbs.children[i + 2], validity = tbs.children[i + 3], subject = tbs.children[i + 4], spki = tbs.children[i + 5];
  const exts = tbs.children.find(x => x.cls === 2 && x.tag === 3);
  let ski = null, ku = [];
  for (const e of exts?.children[0]?.children || []) {
    const id = oid(e.children[0]);
    const v = parse(val(e.children[e.children.length - 1]));
    if (id === "2.5.29.14") ski = hex(val(v));
    if (id === "2.5.29.15") {
      const bits = val(v), names = ["digital_signature", "non_repudiation", "key_encipherment", "data_encipherment", "key_agreement", "key_cert_sign", "crl_sign"];
      names.forEach((nm, k) => { if (bits.length > 1 && bits[1] & (0x80 >> k)) ku.push(nm); });
    }
  }
  return { node: c, serialHex: hex(serial), issuerRaw: hex(raw(issuer)), ski, spki: raw(spki), spkiAlg: oid(spki.children[0].children[0]),
    curve: spki.children[0].children[1] && spki.children[0].children[1].tag === 6 ? oid(spki.children[0].children[1]) : null,
    subject: nameDict(subject), issuer: nameDict(issuer), notBefore: time(validity.children[0]), notAfter: time(validity.children[1]), ku };
}
function certInfo(c) {
  const s = c.subject, now = new Date();
  const sn = s.serial_number || "";
  return {
    nome: s.common_name || [s.given_name, s.surname].filter(Boolean).join(" "), nome_proprio: s.given_name, cognome: s.surname,
    codice_fiscale: sn.includes("-") ? sn.split("-").slice(1).join("-") : sn, organizzazione: s.organization_name, ruolo: s.title,
    paese: s.country_name, email: s.email_address, emesso_da: c.issuer.common_name || c.issuer.organization_name, ente_certificatore: c.issuer.organization_name,
    valido_dal: fmtDate(c.notBefore), valido_al: fmtDate(c.notAfter), scaduto: now > c.notAfter, non_ancora_valido: now < c.notBefore,
    numero_serie: c.serialHex.replace(/^0+/, ""), usi_chiave: c.ku,
  };
}

// ---------------------------------------------------------------- verifica firma
const HASH = { "1.3.14.3.2.26": "SHA-1", "2.16.840.1.101.3.4.2.1": "SHA-256", "2.16.840.1.101.3.4.2.2": "SHA-384", "2.16.840.1.101.3.4.2.3": "SHA-512" };
const SIGALG = { "1.2.840.113549.1.1.1": "rsa", "1.2.840.113549.1.1.5": "rsa", "1.2.840.113549.1.1.11": "rsa", "1.2.840.113549.1.1.12": "rsa", "1.2.840.113549.1.1.13": "rsa",
  "1.2.840.10045.4.3.2": "ecdsa", "1.2.840.10045.4.3.3": "ecdsa", "1.2.840.10045.4.3.4": "ecdsa", "1.2.840.10045.2.1": "ecdsa", "1.2.840.113549.1.1.10": "pss" };
const CURVES = { "1.2.840.10045.3.1.7": ["P-256", 32], "1.3.132.0.34": ["P-384", 48], "1.3.132.0.35": ["P-521", 66] };

function ecdsaDerToRaw(sig, size) {
  const n = parse(sig);
  const fix = v => { let x = val(v); while (x.length > size && x[0] === 0) x = x.subarray(1); const o = new Uint8Array(size); o.set(x, size - x.length); return o; };
  const out = new Uint8Array(size * 2);
  out.set(fix(n.children[0]), 0);
  out.set(fix(n.children[1]), size);
  return out;
}

async function verify(cert, data, sig, alg, hash) {
  const kind = SIGALG[alg] || (cert.spkiAlg === "1.2.840.10045.2.1" ? "ecdsa" : "rsa");
  if (kind === "pss") return null; // RSA-PSS: non verificato nel browser
  if (kind === "ecdsa") {
    const [curve, size] = CURVES[cert.curve] || [];
    if (!curve) return null;
    const key = await crypto.subtle.importKey("spki", cert.spki, { name: "ECDSA", namedCurve: curve }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash }, key, ecdsaDerToRaw(sig, size), data);
  }
  const key = await crypto.subtle.importKey("spki", cert.spki, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
}

function timestampOf(tokenNode) {
  try {
    const sd = tokenNode.children[1].children[0];
    const eci = sd.children.find(x => x.tag === 16 && x.children && x.children[0]?.tag === 6 && oid(x.children[0]) === "1.2.840.113549.1.9.16.1.4");
    const tst = parse(octets(eci.children[1].children[0]));
    const gen = tst.children.find(x => x.tag === 24);
    const certs = sd.children.find(x => x.cls === 2 && x.tag === 0);
    const tsa = certs ? certInfo(parseCert(certs.children[0])).nome : null;
    return { data: fmtDate(time(gen)), autorita: tsa };
  } catch { return null; }
}

const isSignedData = b => { try { const n = parse(b); return n.children && oid(n.children[0]) === "1.2.840.113549.1.7.2" ? n : null; } catch { return null; } };

async function analyze(ci, detached) {
  const sd = ci.children[1].children[0];
  const kids = sd.children;
  const eci = kids[2];
  let content = eci.children[1] ? octets(eci.children[1].children[0]) : null;
  if (!content && detached) content = detached;
  const certSet = kids.find(x => x.cls === 2 && x.tag === 0);
  const certs = (certSet?.children || []).filter(c => c.tag === 16).map(c => { try { return parseCert(c); } catch { return null; } }).filter(Boolean);
  const signerInfos = kids[kids.length - 1];
  const firmatari = [];
  for (const si of signerInfos.children || []) {
    const c = si.children;
    const sid = c[1];
    let cert = null;
    if (sid.tag === 16) { const iss = hex(raw(sid.children[0])), ser = hex(val(sid.children[1])); cert = certs.find(x => x.issuerRaw === iss && x.serialHex === ser); }
    else cert = certs.find(x => x.ski === hex(val(sid)));
    if (!cert && certs.length === 1) cert = certs[0];
    const hashOid = oid(c[2].children[0]);
    const hash = HASH[hashOid] || "SHA-256";
    let k = 3;
    const signedAttrs = c[k].cls === 2 && c[k].tag === 0 ? c[k++] : null;
    const sigAlg = oid(c[k++].children[0]);
    const sig = val(c[k++]);
    const unsigned = c[k] && c[k].cls === 2 && c[k].tag === 1 ? c[k] : null;
    const res = { certificato: cert ? certInfo(cert) : null, algoritmo: `${hash} / ${SIGALG[sigAlg] || sigAlg}`, integrita: null, firma_valida: null,
      data_firma: null, marca_temporale: null, tipo: "PKCS#7", errori: [] };
    try {
      let signedBytes;
      if (signedAttrs) {
        let md = null;
        for (const a of signedAttrs.children) {
          const t = oid(a.children[0]);
          if (t === "1.2.840.113549.1.9.4") md = val(a.children[1].children[0]);
          if (t === "1.2.840.113549.1.9.5") res.data_firma = fmtDate(time(a.children[1].children[0]));
          if (t === "1.2.840.113549.1.9.16.2.47" || t === "1.2.840.113549.1.9.16.2.12") res.tipo = "CAdES-BES";
        }
        if (content && md) res.integrita = hex(new Uint8Array(await crypto.subtle.digest(hash, content))) === hex(md);
        signedBytes = new Uint8Array(raw(signedAttrs));
        signedBytes[0] = 0x31; // [0] IMPLICIT -> SET OF
      } else { signedBytes = content || new Uint8Array(); res.integrita = !!content; }
      if (cert) res.firma_valida = await verify(cert, signedBytes, sig, sigAlg, hash);
    } catch (e) { res.errori.push(String(e.message || e)); }
    for (const a of unsigned?.children || []) if (oid(a.children[0]) === "1.2.840.113549.1.9.16.2.14") res.marca_temporale = timestampOf(a.children[1].children[0]);
    firmatari.push(res);
  }
  return { info: { tipo_busta: "SignedData", firmatari, contenuto_presente: !!content }, content, certs };
}

function maybeBase64(b) {
  const head = new TextDecoder("latin1").decode(b.subarray(0, 64)).trim();
  if (head.startsWith("-----BEGIN")) {
    const txt = new TextDecoder("latin1").decode(b).split(/\r?\n/).filter(l => l && !l.startsWith("-----")).join("");
    return Uint8Array.from(atob(txt), ch => ch.charCodeAt(0));
  }
  if (b[0] !== 0x30) {
    try { const d = Uint8Array.from(atob(new TextDecoder("latin1").decode(b).replace(/\s+/g, "")), ch => ch.charCodeAt(0)); if (d[0] === 0x30) return d; } catch { /* */ }
  }
  return b;
}

function guessExt(c) {
  const s = new TextDecoder("latin1").decode(c.subarray(0, 8));
  if (s.startsWith("%PDF")) return ".pdf";
  if (s.startsWith("PK")) return ".zip";
  if (s.startsWith("<")) return ".xml";
  if (c[0] === 0xd0 && c[1] === 0xcf) return ".doc";
  if (c[0] === 0x89 && s.slice(1, 4) === "PNG") return ".png";
  if (c[0] === 0xff && c[1] === 0xd8) return ".jpg";
  return ".bin";
}

// apertura di un file firmato: ritorna la stessa struttura del motore Python
export async function openSigned(bytes, name, siblingBytes) {
  let data = bytes;
  const ext = name.toLowerCase().split(".").pop();
  const levels = [];
  if (ext === "m7m") {
    const text = new TextDecoder("latin1").decode(bytes);
    const boundary = (text.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];
    for (const part of boundary ? text.split("--" + boundary) : []) {
      if (/pkcs7-mime|\.p7m/i.test(part)) {
        const body = part.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
        data = Uint8Array.from(atob(body.replace(/[^A-Za-z0-9+/=]/g, "")), ch => ch.charCodeAt(0));
      } else if (/timestamp|\.tsr|\.tst/i.test(part)) levels.push({ tipo_busta: "Marca temporale M7M", firmatari: [], marca_temporale: null });
    }
  }
  data = maybeBase64(data);
  try { // TimeStampedData (.tsd)
    const n = parse(data);
    if (n.children && oid(n.children[0]) === "1.2.840.113549.1.9.16.1.31") {
      const tsd = n.children[1].children[0];
      const oct = tsd.children.find(x => x.tag === 4);
      levels.push({ tipo_busta: "TimeStampedData (TSD)", firmatari: [], marca_temporale: null });
      data = oct ? octets(oct) : new Uint8Array();
    }
  } catch { /* */ }
  let ci = isSignedData(data);
  if (!ci) return { ok: false, errore: "Il file non contiene una busta di firma CMS/PKCS#7 riconoscibile." };
  let content = null, certsOnly = [], detached = ext === "p7s" ? siblingBytes : null;
  while (ci) {
    const r = await analyze(ci, detached);
    if (!r.info.firmatari.length) certsOnly = r.certs.map(certInfo);
    levels.push(r.info);
    content = r.content;
    detached = null;
    ci = content ? isSignedData(content) : null;
  }
  let inner = name;
  while (/\.(p7m|p7s|tsd|m7m|p7c)$/i.test(inner)) inner = inner.replace(/\.(p7m|p7s|tsd|m7m|p7c)$/i, "");
  if (inner === name || !inner.includes(".")) inner += content ? guessExt(content) : "";
  return { ok: true, livelli: levels, certificati: certsOnly, content, nome_contenuto: content ? inner : null,
    nota: ext === "p7s" && siblingBytes ? "Firma separata verificata sul file con lo stesso nome" : null,
    avviso: "Verificate integrita' e firma crittografica. Catena di fiducia (elenco AgID/eIDAS) e revoca non verificate." };
}

// firme PAdES dentro un PDF
export async function pdfSignatures(bytes) {
  const text = new TextDecoder("latin1").decode(bytes);
  const firme = [];
  for (const m of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    const [a, b, c, d] = m.slice(1).map(Number);
    const hole = text.slice(a + b, c);
    const hm = hole.match(/<([0-9A-Fa-f\s]+)>/);
    if (!hm) continue;
    let h = hm[1].replace(/\s/g, "");
    const blob = new Uint8Array(h.length / 2);
    for (let i = 0; i < blob.length; i++) blob[i] = parseInt(h.substr(i * 2, 2), 16);
    const signed = new Uint8Array(b + d);
    signed.set(bytes.subarray(a, a + b), 0);
    signed.set(bytes.subarray(c, c + d), b);
    try {
      const ci = parse(blob);
      const r = await analyze(ci, signed);
      r.info.copre_intero_file = c + d === bytes.length;
      firme.push(r.info);
    } catch (e) { firme.push({ errore: String(e.message || e) }); }
  }
  return { ok: true, firme };
}
