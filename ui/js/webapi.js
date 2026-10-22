// MB Visual web app: motore nel browser al posto del motore Python del PC.
// I file aperti restano nella memoria del dispositivo (nessun invio a server); il salvataggio avviene scaricando il file.
// Espone window.MBV_API, usato da core.js quando window.MBV_WEB e' attivo.
import { loadScript } from "./core.js";
import { t as tr, LOCALE } from "./i18n.js";

const V = p => window.MBV_ROOT + "vendor/" + p;
const files = new Map(); // id -> { name, blob, mtime }
const urls = new Map();  // id -> object URL dell'ultima versione
let seq = 0;

// ---------------------------------------------------------------- file virtuali
function register(blob, name) {
  const id = (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
  files.set(id, { name, blob, mtime: Date.now() });
  return `web://${id}/${name}`;
}
function entry(path) {
  const m = /^web:\/\/([^/]+)\//.exec(path || "");
  const f = m && files.get(m[1]);
  if (!f) throw new Error(tr("webapi.file_non_disponibile_riaprilo"));
  return [m[1], f];
}
function replace(path, blob) {
  const [id, f] = entry(path);
  f.blob = blob;
  f.mtime = Date.now();
  if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
}
function urlFor(path) {
  const [id, f] = entry(path);
  if (!urls.has(id)) urls.set(id, URL.createObjectURL(f.blob));
  return urls.get(id);
}
const bytesOf = async path => new Uint8Array(await entry(path)[1].blob.arrayBuffer());
const nameOf = path => (path.startsWith("download://") ? path.slice(11) : entry(path)[1].name);
const toBlob = b => (b instanceof Blob ? b : new Blob([b]));

function download(name, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(toBlob(data));
  a.download = name || "file";
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

// scrittura: un file aperto viene aggiornato in memoria e scaricato; "download://nome" viene solo scaricato
async function writeOut(path, data) {
  const blob = toBlob(data);
  if (path.startsWith("download://")) { download(path.slice(11), blob); return path; }
  replace(path, blob);
  download(nameOf(path), blob);
  return path;
}

function pickFiles() {
  return new Promise(resolve => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.multiple = true;
    inp.style.display = "none";
    inp.addEventListener("change", () => { resolve([...inp.files].map(f => register(f, f.name))); inp.remove(); });
    inp.addEventListener("cancel", () => { resolve([]); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

// ---------------------------------------------------------------- tipo reale dal contenuto
function sniff(h) {
  const s = new TextDecoder("latin1").decode(h.subarray(0, 64));
  const at = (o, str) => new TextDecoder("latin1").decode(h.subarray(o, o + str.length)) === str;
  const T = [
    [s.startsWith("%PDF"), "pdf", tr("webapi.documento_pdf")], [s.startsWith("PK\x03\x04"), "zip", tr("webapi.archivio_zip_documento_office")],
    [s.startsWith("7z\xbc\xaf"), "archive", tr("webapi.archivio_7_zip")], [s.startsWith("Rar!"), "archive", tr("webapi.archivio_rar")], [h[0] === 0x1f && h[1] === 0x8b, "archive", tr("webapi.archivio_gzip")],
    [s.startsWith("\x89PNG"), "image", tr("webapi.immagine_png")], [h[0] === 0xff && h[1] === 0xd8, "image", tr("webapi.immagine_jpeg")], [s.startsWith("GIF8"), "image", tr("webapi.immagine_gif")],
    [s.startsWith("II*\0") || s.startsWith("MM\0*"), "image", tr("webapi.immagine_tiff")], [s.startsWith("RIFF") && at(8, "WEBP"), "image", tr("webapi.immagine_webp")],
    [/^ftyp(heic|heix|mif1|msf1)/.test(s.slice(4)), "image", tr("webapi.immagine_heic")], [s.startsWith("RIFF") && at(8, "WAVE"), "media", tr("webapi.audio_wav")],
    [s.slice(4, 8) === "ftyp", "media", "Video/Audio MP4"], [h[0] === 0x1a && h[1] === 0x45, "media", tr("webapi.video_mkv_webm")], [s.startsWith("OggS"), "media", "Audio/Video OGG"],
    [s.startsWith("fLaC"), "media", tr("webapi.audio_flac")], [s.startsWith("ID3"), "media", tr("webapi.audio_mp3")], [s.startsWith("\xd0\xcf\x11\xe0"), "ole", tr("webapi.documento_office_97_2003_msg")],
    [s.startsWith("SQLite format 3"), "sqlite", tr("webapi.database_sqlite")], [s.startsWith("AC10"), "cad2d", tr("webapi.disegno_autocad_dwg")], [s.startsWith("glTF"), "mesh3d", tr("webapi.modello_gltf")],
    [s.includes("ISO-10303-21") && new TextDecoder("latin1").decode(h.subarray(0, 4000)).toUpperCase().includes("IFC"), "ifc", tr("webapi.modello_bim_ifc")],
    [s.includes("ISO-10303-21"), "cad3d", tr("webapi.modello_cad_step")], [s.startsWith("MZ"), "exe", tr("webapi.programma_windows")],
    [h[0] === 0x30 && hasSigned(h), "signed", tr("webapi.busta_firmata_pkcs_7_cades")],
  ];
  for (const [c, kind, descr] of T) if (c) return { kind, descr };
  const sample = h.subarray(0, 8192);
  if (sample.length && !sample.includes(0)) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(sample); } catch { /* testo non UTF-8 */ }
    const t = new TextDecoder("latin1").decode(sample).trimStart().toLowerCase();
    if (t.startsWith("<svg") || (t.startsWith("<?xml") && t.includes("<svg"))) return { kind: "svg", descr: tr("webapi.grafica_svg") };
    if (t.startsWith("<!doctype html") || t.startsWith("<html")) return { kind: "html", descr: tr("webapi.pagina_web_html") };
    return { kind: "text", descr: tr("webapi.file_testo") };
  }
  return { kind: null, descr: tr("webapi.dati_binari_non_riconosciuti") };
}
function hasSigned(h) {
  const pat = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
  outer: for (let i = 0; i < Math.min(64, h.length - pat.length); i++) { for (let j = 0; j < pat.length; j++) if (h[i + j] !== pat[j]) continue outer; return true; }
  return false;
}

// ---------------------------------------------------------------- testo
const CP1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
function encode(text, enc) {
  if (enc !== "cp1252") return new TextEncoder().encode(text);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i), k = CP1252.indexOf(text[i]);
    out[i] = k >= 0 ? 0x80 + k : c < 256 ? c : 0x3f;
  }
  return out;
}
async function readText(path) {
  let b = await bytesOf(path);
  let enc = "utf-8", bom = false;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { bom = true; b = b.subarray(3); }
  else if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) { return { ok: true, text: new TextDecoder(b[0] === 0xff ? "utf-16le" : "utf-16be").decode(b), encoding: "utf-16", bom: true, eol: "\n" }; }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { enc = "cp1252"; text = new TextDecoder("windows-1252").decode(b); }
  return { ok: true, text, encoding: enc, bom, eol: text.slice(0, 100000).includes("\r\n") ? "\r\n" : "\n" };
}

// ---------------------------------------------------------------- immagini non native (TIFF, HEIC)
async function imageToPng(path) {
  const name = nameOf(path).toLowerCase();
  const b = await bytesOf(path);
  let blob, info = {};
  if (/\.(tif|tiff)$/.test(name)) {
    await loadScript(V("utif/UTIF.js"));
    const ifds = window.UTIF.decode(b.buffer);
    window.UTIF.decodeImage(b.buffer, ifds[0]);
    const rgba = window.UTIF.toRGBA8(ifds[0]);
    const c = document.createElement("canvas");
    c.width = ifds[0].width; c.height = ifds[0].height;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), c.width, c.height), 0, 0);
    blob = await new Promise(r => c.toBlob(r, "image/png"));
    info = { formato: "TIFF", pagine: ifds.length, larghezza: c.width, altezza: c.height };
  } else if (/\.(heic|heif|hif|heics|heifs)$/.test(name)) {
    await loadScript(V("heic2any/heic2any.min.js"));
    const out = await window.heic2any({ blob: new Blob([b]), toType: "image/png" });
    blob = Array.isArray(out) ? out[0] : out;
    info = { formato: "HEIC" };
  } else throw new Error(tr("webapi.questo_formato_immagine_si_apre"));
  return { ok: true, path: register(blob, name.replace(/\.[^.]+$/, ".png")), info };
}
async function saveImage(path, png) {
  const ext = nameOf(path).split(".").pop().toLowerCase();
  if (ext === "png") return writeOut(path, png);
  const bmp = await createImageBitmap(new Blob([png]));
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext("2d");
  if (["jpg", "jpeg", "jpe", "jfif"].includes(ext)) { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(bmp, 0, 0);
  if (["tif", "tiff"].includes(ext)) {
    await loadScript(V("utif/UTIF.js"));
    const data = g.getImageData(0, 0, c.width, c.height).data;
    return writeOut(path, new Uint8Array(window.UTIF.encodeImage(data.buffer, c.width, c.height)));
  }
  const type = { jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg", webp: "image/webp" }[ext];
  if (!type) throw new Error(tr("webapi.web_app_si_salva_png", ext));
  return writeOut(path, await new Promise(r => c.toBlob(r, type, 0.93)));
}

// ---------------------------------------------------------------- audio / video (solo formati del browser)
function mediaProbe(path) {
  return new Promise(resolve => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve({ ok: true, video: v.videoWidth > 0, audio: true, durata: v.duration, flussi: [] });
    v.onerror = () => resolve({ ok: true, video: /\.(mp4|m4v|mov|webm|ogv|3gp|mkv)$/i.test(nameOf(path)), audio: true, durata: null, flussi: [] });
    v.src = urlFor(path);
  });
}
async function waveform(path, points = 1200) {
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 2, 44100);
  const buf = await ctx.decodeAudioData((await bytesOf(path)).buffer);
  const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / points)), peaks = [];
  for (let i = 0; i < d.length; i += step) { let m = 0; for (let j = i; j < Math.min(d.length, i + step); j++) m = Math.max(m, Math.abs(d[j])); peaks.push(m); }
  return { ok: true, peaks: peaks.slice(0, points) };
}
function frame(path, t, out) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.src = urlFor(path);
    v.onloadeddata = () => { v.currentTime = t; };
    v.onseeked = () => {
      const c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0);
      c.toBlob(b => { writeOut(out, b); resolve({ ok: true, path: out }); }, "image/png");
    };
    v.onerror = () => reject(new Error(tr("webapi.fotogramma_non_disponibile")));
  });
}

// ---------------------------------------------------------------- archivi (libarchive per leggere, JSZip per modificare gli ZIP)
let archiveLib = null;
async function openArchive(path) {
  if (!archiveLib) {
    archiveLib = (async () => {
      const m = await import(V("libarchive/libarchive.js"));
      m.Archive.init({ workerUrl: V("libarchive/worker-bundle.js") });
      return m.Archive;
    })();
  }
  const Archive = await archiveLib;
  const f = entry(path)[1];
  const file = f.blob instanceof File ? f.blob : new File([f.blob], f.name);
  return Archive.open(file);
}
const ZIP_EDIT = /\.(zip|jar|war|ear|xpi|cbz|apk|nupkg|vsix|whl|egg|kmz)$/i;
async function archiveList(path, password) {
  const a = await openArchive(path);
  if (password) await a.usePassword(password);
  const list = await a.getFilesArray();
  const items = list.map(x => ({ path: (x.path || "") + x.file.name, dir: false, size: x.file.size || 0, packed: x.file.size || 0,
    modified: x.file.lastModified ? new Date(x.file.lastModified).toLocaleString(LOCALE) : "", encrypted: false, _f: x.file }));
  archCache.set(path, items);
  return { ok: true, items: items.map(({ _f, ...i }) => i), type: nameOf(path).split(".").pop(), editable: ZIP_EDIT.test(nameOf(path)) };
}
const archCache = new Map();
async function archiveExtract(path, entryPath, dest) {
  if (!archCache.has(path)) await archiveList(path);
  const items = archCache.get(path);
  const pick = entryPath ? items.filter(i => i.path === entryPath) : items;
  const outs = [];
  for (const it of pick) {
    const f = await it._f.extract();
    if (dest) download(it.path.split("/").pop(), f); else outs.push(register(f, it.path.split("/").pop()));
  }
  return { ok: true, path: outs[0] || dest || "" };
}
async function zipEdit(path, fn) {
  await loadScript(V("jszip/dist/jszip.min.js"));
  const z = await window.JSZip.loadAsync(await bytesOf(path));
  await fn(z);
  const out = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  archCache.delete(path);
  await writeOut(path, out);
  return { ok: true };
}

// ---------------------------------------------------------------- email
async function readEmail(path) {
  const name = nameOf(path).toLowerCase();
  if (name.endsWith(".msg")) throw new Error(tr("webapi.i_messaggi_msg_outlook_si"));
  const { default: PostalMime } = await import(V("postal-mime/src/postal-mime.js"));
  const b = await bytesOf(path);
  const chunks = [];
  if (/\.(mbox|mbx)$/.test(name)) {
    const text = new TextDecoder("latin1").decode(b);
    for (const part of text.split(/\r?\n(?=From [^\r\n]*\r?\n)/)) if (part.trim()) chunks.push(Uint8Array.from(part.replace(/^From [^\n]*\n/, ""), c => c.charCodeAt(0)));
  } else chunks.push(b);
  const msgs = [];
  for (const c of chunks.slice(0, 2000)) {
    const m = await PostalMime.parse(c);
    const addr = l => (l || []).map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
    const cid = {}, allegati = [];
    for (const a of m.attachments || []) {
      const p = register(new Blob([a.content], { type: a.mimeType }), a.filename || "allegato");
      if (a.contentId) cid[a.contentId.replace(/[<>]/g, "")] = p;
      if (a.disposition !== "inline" || !a.contentId) allegati.push({ nome: a.filename || "allegato", path: p, size: a.content.byteLength || a.content.length || 0, tipo: a.mimeType });
    }
    msgs.push({ da: m.from ? addr([m.from]) : "", a: addr(m.to), cc: addr(m.cc), data: m.date || "", oggetto: m.subject || "", html: m.html || null, testo: m.text || "", allegati, cid });
  }
  return { ok: true, messaggi: msgs };
}

// ---------------------------------------------------------------- SQLite (sql.js)
let SQL = null;
const dbs = new Map();
async function db(path) {
  if (!SQL) { await loadScript(V("sqljs/sql-wasm.js")); SQL = await window.initSqlJs({ locateFile: f => V("sqljs/" + f) }); }
  if (!dbs.has(path)) dbs.set(path, new SQL.Database(await bytesOf(path)));
  return dbs.get(path);
}
const cell = v => (v instanceof Uint8Array ? { blob: v.length, hex: [...v.subarray(0, 32)].map(x => x.toString(16).padStart(2, "0")).join("") } : v);
async function sqliteSchema(path) {
  const d = await db(path);
  const res = d.exec("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const oggetti = (res[0]?.values || []).map(([tipo, nome, sql]) => {
    let righe = null;
    try { righe = d.exec(`SELECT COUNT(*) FROM "${nome}"`)[0].values[0][0]; } catch { /* */ }
    const colonne = (d.exec(`PRAGMA table_info("${nome}")`)[0]?.values || []).map(r => r[1]);
    return { tipo, nome, sql, righe, colonne };
  });
  return { ok: true, oggetti };
}
async function sqliteQuery(path, b) {
  const d = await db(path);
  if (b.write) {
    d.run(b.sql, b.params || []);
    const n = d.getRowsModified();
    replace(path, new Blob([d.export()])); // il file in memoria resta aggiornato; "Salva con nome" lo scarica
    return { ok: true, colonne: [], righe: [], modificate: n };
  }
  const st = d.prepare(b.sql);
  st.bind(b.params || []);
  const righe = [];
  const limit = b.limit || 1000;
  while (st.step() && righe.length < limit) righe.push(st.get().map(cell));
  const colonne = st.getColumnNames();
  st.free();
  return { ok: true, colonne, righe, troncato: righe.length >= limit };
}

// ---------------------------------------------------------------- strumenti PDF (pdf-lib)
function parsePages(spec, n) {
  const out = [];
  for (let part of String(spec || "").replace(/;/g, ",").split(",")) {
    part = part.trim();
    if (!part) continue;
    if (part.includes("-")) { const [a, b] = part.split("-"); for (let i = +(a || 1); i <= +(b || n); i++) out.push(i); }
    else out.push(+part);
  }
  const pages = out.filter(p => p >= 1 && p <= n).map(p => p - 1);
  if (!pages.length) throw new Error(tr("webapi.nessuna_pagina_valida_documento_ha", n));
  return pages;
}
async function pdfTool(path, op, b) {
  await loadScript(V("pdf-lib/pdf-lib.min.js"));
  const { PDFDocument, degrees, rgb, StandardFonts } = window.PDFLib;
  const src = await PDFDocument.load(await bytesOf(path), { ignoreEncryption: true });
  const n = src.getPageCount();
  const finish = async doc => { const out = await doc.save(); await writeOut(b.out, out); return { ok: true, path: b.out, pagine: doc.getPageCount() }; };
  if (op === "merge") {
    const doc = await PDFDocument.create();
    for (const p of [path, ...(b.others || [])]) {
      const d = p === path ? src : await PDFDocument.load(await bytesOf(p), { ignoreEncryption: true });
      (await doc.copyPages(d, d.getPageIndices())).forEach(pg => doc.addPage(pg));
    }
    return finish(doc);
  }
  if (op === "extract" || op === "delete") {
    const sel = parsePages(b.pages, n);
    const keep = op === "extract" ? sel : src.getPageIndices().filter(i => !sel.includes(i));
    if (!keep.length) throw new Error(tr("webapi.non_si_possono_eliminare_tutte"));
    const doc = await PDFDocument.create();
    (await doc.copyPages(src, keep)).forEach(pg => doc.addPage(pg));
    return finish(doc);
  }
  if (op === "rotate") {
    const sel = new Set(parsePages(b.pages || `1-${n}`, n));
    src.getPages().forEach((pg, i) => { if (sel.has(i)) pg.setRotation(degrees((pg.getRotation().angle + (+b.angle || 90)) % 360)); });
    return finish(src);
  }
  if (op === "split") {
    await loadScript(V("jszip/dist/jszip.min.js"));
    const z = new window.JSZip();
    const stem = nameOf(path).replace(/\.pdf$/i, "");
    for (let i = 0; i < n; i++) {
      const doc = await PDFDocument.create();
      const [pg] = await doc.copyPages(src, [i]);
      doc.addPage(pg);
      z.file(`${stem}_pag${String(i + 1).padStart(3, "0")}.pdf`, await doc.save());
    }
    download(stem + "_pagine.zip", await z.generateAsync({ type: "blob" }));
    return { ok: true, files: new Array(n).fill("") };
  }
  if (op === "stamp") {
    const font = await src.embedFont(StandardFonts.HelveticaBold);
    const sel = new Set(parsePages(b.pages || `1-${n}`, n));
    const red = rgb(0.55, 0.1, 0.1);
    src.getPages().forEach((pg, i) => {
      if (!sel.has(i)) return;
      const { width: w, height: h } = pg.getSize();
      if (b.mode === "filigrana") {
        const size = Math.min(w, h) / 9, ang = Math.atan2(h, w);
        const tw = font.widthOfTextAtSize(b.text, size);
        pg.drawText(b.text, { x: w / 2 - Math.cos(ang) * tw / 2, y: h / 2 - Math.sin(ang) * tw / 2, size, font, color: red, opacity: +b.opacity || 0.25, rotate: degrees(ang * 180 / Math.PI) });
      } else {
        const lines = b.text.split("\n"), size = 13;
        const bw = Math.max(...lines.map(l => font.widthOfTextAtSize(l, size))) + 16, bh = lines.length * size * 1.3 + 10;
        const x0 = w - bw - 24, y0 = h - bh - 24;
        pg.drawRectangle({ x: x0, y: y0, width: bw, height: bh, color: rgb(1, 1, 1), borderColor: red, borderWidth: 1.5, opacity: 0.95 });
        lines.forEach((l, k) => pg.drawText(l, { x: x0 + 8, y: y0 + bh - 6 - size * (k + 1) * 1.15, size, font, color: red }));
      }
    });
    return finish(src);
  }
  throw new Error(tr("webapi.operazione_non_disponibile"));
}

// ---------------------------------------------------------------- smistamento delle richieste
const NOT_HERE = what => ({ ok: false, errore: tr("webapi.0_disponibile_mb_visual_pc", what) });

async function handle(route, p = {}, opts = {}) {
  const body = opts.json !== undefined ? opts.json : opts.body;
  const path = p.path;
  switch (route) {
    case "info": {
      const [, f] = entry(path);
      const head = new Uint8Array(await f.blob.slice(0, 65536).arrayBuffer());
      return { ok: true, path, nome: f.name, cartella: "", size: f.blob.size, modificato: f.mtime / 1000, creato: f.mtime / 1000, sniff: sniff(head), scrivibile: true };
    }
    case "tools": return { ok: true, tools: {} };
    case "upload": return { ok: true, path: register(body, p.name || "file") };
    case "save": await writeOut(path, body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob ? body : new Uint8Array(body)); return { ok: true, path };
    case "patch": {
      const b = await bytesOf(path);
      for (const pt of body.patches) { const hx = pt.hex.match(/../g).map(x => parseInt(x, 16)); b.set(hx, +pt.offset); }
      await writeOut(path, b);
      return { ok: true };
    }
    case "strings": {
      const t = new TextDecoder("latin1").decode((await bytesOf(path)).subarray(0, 32 * 1024 * 1024));
      return { ok: true, strings: (t.match(/[\x20-\x7e\xa0-\xff]{5,}/g) || []).slice(0, 20000) };
    }
    case "text": return readText(path);
    case "text_save": {
      let data = body.encoding === "utf-16" ? null : encode(body.eol === "\r\n" ? body.text.replace(/\r?\n/g, "\r\n") : body.text.replace(/\r\n/g, "\n"), body.encoding);
      if (!data) data = new TextEncoder().encode(body.text);
      if (body.bom && body.encoding === "utf-8") { const d = new Uint8Array(data.length + 3); d.set([0xef, 0xbb, 0xbf]); d.set(data, 3); data = d; }
      await writeOut(path, data);
      return { ok: true };
    }
    case "file_hash": return { ok: true, sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", await bytesOf(path)))].map(x => x.toString(16).padStart(2, "0")).join("") };
    case "image": return imageToPng(path);
    case "image_save": await saveImage(path, body); return { ok: true, path };
    case "media_probe": return mediaProbe(path);
    case "media_waveform": return waveform(path);
    case "media_frame": return frame(path, +body.t, body.out);
    case "media_playable": return NOT_HERE(tr("webapi.conversione_formati_audio_video_non"));
    case "media_edit": return NOT_HERE(tr("webapi.taglio_conversione_audio_video"));
    case "signed": {
      const { openSigned } = await import("./cms.js");
      const r = await openSigned(await bytesOf(path), nameOf(path));
      if (r.ok && r.content) r.contenuto = register(new Blob([r.content]), r.nome_contenuto);
      delete r.content;
      return r;
    }
    case "pdf_signatures": { const { pdfSignatures } = await import("./cms.js"); return pdfSignatures(await bytesOf(path)); }
    case "pdf_tool": return pdfTool(path, p.op, body);
    case "archive_list": return archiveList(path, p.password);
    case "archive_extract": return archiveExtract(path, body.entry, body.dest);
    case "archive_add":
      if (!ZIP_EDIT.test(nameOf(path))) return { ok: false, errore: tr("webapi.web_app_si_possono_modificare") };
      return zipEdit(path, async z => { for (const f of body.files) z.file((body.folder ? body.folder + "/" : "") + nameOf(f), await bytesOf(f)); });
    case "archive_delete": return zipEdit(path, async z => { for (const e of body.entries) { z.remove(e); } });
    case "archive_rename": return zipEdit(path, async z => { const f = z.file(body.old); if (f) { z.file(body.new, await f.async("uint8array")); z.remove(body.old); } });
    case "pptx": { await loadScript(V("jszip/dist/jszip.min.js")); const { readPptx } = await import("./pptxweb.js"); return readPptx(await bytesOf(path)); }
    case "pptx_save": {
      await loadScript(V("jszip/dist/jszip.min.js"));
      const { savePptx } = await import("./pptxweb.js");
      await writeOut(body.out || path, await savePptx(await bytesOf(path), body.edits || []));
      return { ok: true, path: body.out || path };
    }
    case "docx_save": {
      await loadScript(V("html-docx/html-docx.js"));
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body.html}</body></html>`;
      await writeOut(path, window.htmlDocx.asBlob(html));
      return { ok: true, path };
    }
    case "email": return readEmail(path);
    case "sqlite_schema": return sqliteSchema(path);
    case "sqlite_query": return sqliteQuery(path, body);
    case "office_convert": return NOT_HERE(tr("webapi.conversione_formati_office_libreoffice"));
    case "list_dir": return NOT_HERE(tr("webapi.l_esplorazione_cartelle"));
    case "reveal": case "open_external": return NOT_HERE(tr("webapi.l_apertura_altri_programmi"));
    case "job": return { ok: false, errore: tr("webapi.nessun_lavoro_corso") };
    default: return { ok: false, errore: tr("webapi.funzione_non_disponibile_web_app") + route };
  }
}

window.MBV_API = {
  handle, urlFor, register, pickFiles,
  readBytes: bytesOf,
  readRange: async (path, s, e) => new Uint8Array(await entry(path)[1].blob.slice(s, e + 1).arrayBuffer()),
};

// file condivisi da altre app del telefono ("Condividi > MB Visual"), messi in attesa dal service worker
async function sharedFiles() {
  if (!new URLSearchParams(location.search).has("condivisi") || !("caches" in window)) return;
  const cache = await caches.open("mbv-condivisi");
  const keys = await cache.keys();
  const paths = [];
  for (const k of keys) {
    const r = await cache.match(k);
    const name = decodeURIComponent(r.headers.get("X-Nome") || "file");
    paths.push(register(await r.blob(), name));
    await cache.delete(k);
  }
  history.replaceState(history.state, "", location.pathname); // mantiene la protezione del tasto indietro
  const wait = () => (window.MB ? window.MB.openPaths(paths) : setTimeout(wait, 100));
  if (paths.length) wait();
}
// file aperti dal sistema (Chrome su PC: "Apri con MB Visual")
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async params => {
    const paths = [];
    for (const h of params.files || []) { const f = await h.getFile(); paths.push(register(f, f.name)); }
    const wait = () => (window.MB ? window.MB.openPaths(paths) : setTimeout(wait, 100));
    if (paths.length) wait();
  });
}
sharedFiles();
