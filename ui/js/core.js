// Funzioni condivise: chiamate al motore interno, dialoghi, messaggi, elementi di interfaccia.
import { t as tr, LANG, fmtNum } from "./i18n.js";

export const isDesktop = () => !!(window.pywebview && window.pywebview.api);
// Web app (cellulare): nessun motore Python, le stesse funzioni sono in js/webapi.js e i file restano nel browser
export const WEB = !!window.MBV_WEB;
const W = () => window.MBV_API;

export function fileUrl(path, extra = "") {
  if (WEB) return W().urlFor(path);
  return "/api/file?path=" + encodeURIComponent(path) + extra;
}

export async function api(route, params = {}, opts = {}) {
  if (WEB) {
    const data = await W().handle(route, params, opts);
    if (data && data.ok === false && !opts.allowFail) throw new Error(data.errore || tr("core.errore"));
    return data;
  }
  const qs = new URLSearchParams(params).toString();
  // X-MBV-Lang: lingua dei messaggi del motore (mbvisual/i18n.py)
  const init = { method: opts.method || (opts.body !== undefined || opts.json !== undefined ? "POST" : "GET"), credentials: "same-origin", headers: { "X-MBV-Lang": LANG } };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers["Content-Type"] = "application/json";
  } else if (opts.body !== undefined) {
    init.body = opts.body;
  }
  const res = await fetch("/api/" + route + (qs ? "?" + qs : ""), init);
  if (opts.raw) return res;
  let data;
  try { data = await res.json(); } catch { data = { ok: false, errore: tr("core.risposta_non_valida_motore") + res.status + ")" }; }
  if (res.status === 402 && data.licenza) window.dispatchEvent(new CustomEvent("mbv-licenza")); // licenza non attiva (ui/js/license.js)
  if (data.ok === false && !opts.allowFail) throw new Error(data.errore || tr("core.errore"));
  return data;
}

export async function readBytes(path) {
  if (WEB) return W().readBytes(path);
  const r = await fetch(fileUrl(path), { credentials: "same-origin" });
  if (!r.ok) throw new Error(tr("core.impossibile_leggere_file"));
  return new Uint8Array(await r.arrayBuffer());
}

export async function readRange(path, start, end) {
  if (WEB) return W().readRange(path, start, end);
  const r = await fetch(fileUrl(path), { headers: { Range: `bytes=${start}-${end}` }, credentials: "same-origin" });
  return new Uint8Array(await r.arrayBuffer());
}

export async function saveBytes(path, bytes) {
  return api("save", { path }, { body: bytes });
}

// lavoro lungo in background: attende la fine aggiornando una funzione di avanzamento
export async function waitJob(id, onProgress) {
  for (;;) {
    const j = await api("job", { id }, { allowFail: true });
    if (!j.ok) throw new Error(j.errore || tr("core.lavoro_non_trovato"));
    if (onProgress) onProgress(j.progress || 0, j.message || "");
    if (j.status === "done") return j.result;
    if (j.status === "error") throw new Error(j.error || tr("core.errore"));
    await new Promise(r => setTimeout(r, 400));
  }
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith("--")) e.style.setProperty(sk, sv); else e.style[sk] = sv; } // variabili CSS con setProperty
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const ICONS = {
  zoomIn: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6M11 8v6"/></svg>',
  zoomOut: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/></svg>',
  fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  rotate: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  rotateL: '<svg viewBox="0 0 24 24"><path d="M4 11a8 8 0 1 1 2.3 5.7M4 4v7h7"/></svg>',
  flipH: '<svg viewBox="0 0 24 24"><path d="M12 3v18M8 7l-5 5 5 5zM16 7l5 5-5 5z"/></svg>',
  flipV: '<svg viewBox="0 0 24 24"><path d="M3 12h18M7 8l5-5 5 5zM7 16l5 5 5-5z"/></svg>',
  crop: '<svg viewBox="0 0 24 24"><path d="M6 2v16h16M2 6h16v16"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M5 5h14M12 5v14M9 19h6"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  scissors: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  ruler: '<svg viewBox="0 0 24 24"><path d="M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/></svg>',
  cube: '<svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12v10M12 12L3 7"/></svg>',
  wire: '<svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7zM3 7l18 10M21 7L3 17M12 2v20"/></svg>',
  section: '<svg viewBox="0 0 24 24"><path d="M3 12h18M6 6l12 12M12 3v4M12 17v4"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8M5 9v12h14V9"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  sign: '<svg viewBox="0 0 24 24"><path d="M3 17c3-1 4-7 6-7s1 6 3 6 3-4 5-4 2 3 4 3M3 21h18"/></svg>',
  table: '<svg viewBox="0 0 24 24"><path d="M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/></svg>',
};

export function button(label, icon, onclick, opts = {}) {
  const b = el("button", { title: opts.title || label, class: opts.class, type: "button" });
  if (icon) b.insertAdjacentHTML("beforeend", ICONS[icon] || icon);
  if (label && !opts.iconOnly) b.append(label);
  if (opts.iconOnly) b.classList.add("icon");
  b.addEventListener("click", onclick);
  return b;
}

export function loading(container, text = tr("core.apertura_corso")) {
  container.innerHTML = "";
  const bar = el("div", { class: "progress" }, el("span"));
  const msg = el("div", {}, text);
  container.append(el("div", { class: "center" }, el("div", {}, el("div", { class: "spinner" }), msg, bar)));
  return {
    set(p, m) { bar.firstChild.style.width = Math.round((p || 0) * 100) + "%"; if (m) msg.textContent = m; },
  };
}

export function toast(text, bad = false, ms = 3200) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), ms);
}

// finestra modale; buttons: [{label, value, primary, danger}]
export function modal(title, content, buttons = [{ label: "OK", value: true, primary: true }]) {
  return new Promise(resolve => {
    const back = document.getElementById("modal");
    const body = document.getElementById("modal-body");
    body.innerHTML = "";
    body.append(el("h3", {}, title));
    if (typeof content === "string") body.append(el("div", { html: content }));
    else if (content) body.append(content);
    const row = el("div", { class: "row" });
    const close = v => { back.hidden = true; document.removeEventListener("keydown", onKey); resolve(v); };
    for (const b of buttons) {
      row.append(el("button", { class: "btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : ""), onclick: () => close(typeof b.value === "function" ? b.value() : b.value) }, b.label));
    }
    body.append(row);
    const onKey = e => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    back.hidden = false;
    const first = body.querySelector("input, .btn.primary");
    if (first) first.focus();
  });
}

export async function askText(title, label, value = "") {
  const input = el("input", { type: "text", value, id: "ask-input" });
  const wrap = el("label", { style: { display: "grid", gap: "6px" } }, label, input);
  input.addEventListener("keydown", e => { if (e.key === "Enter") document.querySelector("#modal .btn.primary").click(); });
  return modal(title, wrap, [{ label: tr("common.annulla"), value: null }, { label: "OK", primary: true, value: () => input.value }]);
}

export async function confirmBox(title, text, okLabel = tr("core.conferma"), danger = false) {
  return modal(title, el("p", {}, text), [{ label: tr("common.annulla"), value: false }, { label: okLabel, value: true, primary: !danger, danger }]);
}

// dialoghi di sistema (in modalita' browser: richiesta del percorso a mano)
export async function pickFiles() {
  if (isDesktop()) return await window.pywebview.api.open_files(true);
  if (WEB) return W().pickFiles();
  // app per PC nel ripiego in Edge (finestra nativa bloccata): finestre di Windows aperte dal motore
  try { return (await api("dialog", { kind: "open" })).result || []; } catch { /* sotto */ }
  const p = await askText(tr("core.apri_file"), tr("core.percorso_completo_file"), "");
  return p ? [p] : [];
}

export async function pickSavePath(suggested, dir = "") {
  if (isDesktop()) return await window.pywebview.api.save_as(suggested, dir);
  if (WEB) {
    // nel browser si salva scaricando il file: si sceglie solo il nome
    const n = await askText(tr("core.salva_nome"), tr("core.nome_file_scaricare"), suggested);
    return n ? "download://" + n : null;
  }
  try { return (await api("dialog", { kind: "save", suggested, dir })).result || null; } catch { /* sotto */ }
  return await askText(tr("core.salva_nome"), tr("core.percorso_completo_nuovo_file"), (dir ? dir + "\\" : "") + suggested);
}

export async function pickFolder() {
  if (isDesktop()) return await window.pywebview.api.choose_folder();
  if (WEB) return "download://";
  try { return (await api("dialog", { kind: "folder" })).result || null; } catch { /* sotto */ }
  return await askText(tr("core.scegli_cartella"), tr("core.percorso_cartella"), "");
}

export function fmtSize(n) {
  if (n === null || n === undefined) return "";
  const u = ["byte", "KB", "MB", "GB", "TB"]; // nomi nella lingua scelta: units.* (in francese octet, Ko, Mo...)
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? fmtNum(n, n < 10 ? 2 : 1) : fmtNum(n)) + " " + tr("units." + u[i]);
}

export function fmtTime(s) {
  if (!isFinite(s)) return "--:--";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function extOf(name) {
  const n = name.toLowerCase();
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i + 1) : n.startsWith(".") ? n.slice(1) : "";
}

export function baseName(p) {
  return p.split(/[\\/]/).pop();
}

export function dirName(p) {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : "";
}

export function withExt(name, ext) {
  const i = name.lastIndexOf(".");
  return (i > 0 ? name.slice(0, i) : name) + "." + ext;
}

// Caricamento di librerie UMD. Il caricatore AMD di Monaco (window.define) le intercetterebbe, quindi ogni
// libreria viene eseguita in un ambito dove define/module/exports non esistono: si registra come variabile globale.
const SCRIPTS = new Map();
export function loadScript(src) {
  if (SCRIPTS.has(src)) return SCRIPTS.get(src);
  let p;
  if (src.endsWith("/vs/loader.js")) {
    p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(tr("core.impossibile_caricare") + src));
      document.head.append(s);
    });
  } else {
    p = fetch(src).then(r => {
      if (!r.ok) throw new Error(tr("core.impossibile_caricare") + src);
      return r.text();
    }).then(code => {
      // eslint-disable-next-line no-new-func
      // le librerie che dichiarano "var NOME" restano locali alla funzione: le riportiamo su window
      const hoist = ["XLSX", "JSZip", "docx", "mammoth", "ePub", "marked", "PDFLib", "initSqlJs", "UTIF", "heic2any", "htmlDocx"].map(n => `if(typeof ${n}!=="undefined"&&!window.${n})window.${n}=${n};`).join("");
      new Function("define", "module", "exports", code + "\n;" + hoist + "\n//# sourceURL=" + location.origin + src).call(window, undefined, undefined, undefined);
    });
  }
  p.catch(() => SCRIPTS.delete(src));
  SCRIPTS.set(src, p);
  return p;
}

export function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

export function download(name, blob) {
  // nell'app desktop si usa sempre "Salva con nome"; qui solo come ripiego
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export async function saveBlobAs(suggested, blob, dir = "") {
  const path = await pickSavePath(suggested, dir);
  if (!path) return null;
  await saveBytes(path, new Uint8Array(await blob.arrayBuffer()));
  toast(tr("core.salvato") + baseName(path));
  return path;
}
