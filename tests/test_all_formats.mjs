// Collaudo di TUTTE le estensioni del registro (ui/formats.json) nell'app vera: server dell'app con dati di prova
// (tests/format_server.py) + Edge senza finestra pilotato con il DevTools Protocol. Per ogni campione apre il file come
// fa l'utente (MB.openFile), aspetta che il visualizzatore abbia finito e controlla che il contenuto si veda: niente
// schermata di recupero, niente errore, niente rotella ferma, audio/video con i metadati letti, pagine PDF disegnate.
// Dove il visualizzatore sa salvare prova anche "Salva con nome" nel formato del file (save(), se c'e').
//
// Campioni: python tools/make_format_samples.py <cartella>  (scrive <cartella>/manifest.json)
// Uso:      node tests/test_all_formats.mjs <cartella campioni> [--out <cartella risultati>] [--only ext,ext] [--cat id,id]
//                [--timeout 60] [--shots] [--keep-going] [--libreoffice <cartella con soffice.exe>] [--from N]
// Esito:    <out>/risultati.json, <out>/risultati.md e, con --shots, una schermata per campione in <out>/schermate.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i < 0 ? def : args[i + 1]; };
const flag = name => args.includes("--" + name);
const POS = args.filter((a, i) => !a.startsWith("--") && !["--out", "--only", "--cat", "--timeout", "--libreoffice", "--from"].includes(args[i - 1]));
const SAMPLES = POS[0] ? path.resolve(POS[0]) : "";
if (!SAMPLES || !fs.existsSync(path.join(SAMPLES, "manifest.json"))) {
  console.error("Uso: node tests/test_all_formats.mjs <cartella campioni con manifest.json> [--out cartella] [--only ext,...] [--cat id,...] [--shots]");
  process.exit(2);
}
const OUT = path.resolve(opt("out", path.join(os.tmpdir(), "mbv-formati-esito")));
const TIMEOUT = Number(opt("timeout", 60)) * 1000;
const ONLY = opt("only", "") ? new Set(opt("only").split(",")) : null;
const CATS = opt("cat", "") ? new Set(opt("cat").split(",")) : null;
fs.mkdirSync(path.join(OUT, "schermate"), { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, "manifest.json"), "utf8"));
const VIEWER_OF = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, "ui", "formats.json"), "utf8")).categories.map(c => [c.id, c.viewer]));
const items = manifest.items.filter(it => it.file && (!ONLY || ONLY.has(it.ext)) && (!CATS || CATS.has(it.cat)));

const PY = process.env.MBV_PYTHON || path.join(os.homedir(), ".mbvisual", "venv", "Scripts", "python.exe");
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- server e browser
function startServer() {
  const data = path.join(OUT, "dati-app");
  // --libreoffice <cartella di soffice.exe>: prova anche i formati che passano da LibreOffice senza installarlo nel sistema
  const lo = opt("libreoffice", "");
  const env = lo ? { ...process.env, PATH: path.resolve(lo) + path.delimiter + process.env.PATH } : process.env;
  const p = spawn(PY, [path.join(ROOT, "tests", "format_server.py"), data], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  p.stderr.on("data", d => fs.appendFileSync(path.join(OUT, "server.log"), d));
  return new Promise((res, rej) => {
    let buf = "";
    p.stdout.on("data", d => { buf += d; const m = buf.match(/http:\/\/\S+/); if (m) res({ proc: p, url: m[0] }); });
    p.on("exit", c => rej(new Error("server terminato " + c)));
  });
}

async function startEdge() {
  // profilo in un percorso corto: con percorsi lunghi IndexedDB da' "Internal error"
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "mbvf-"));
  const p = spawn(EDGE, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${prof}`, "--window-size=1400,900",
    "--no-first-run", "--no-default-browser-check", "--disable-features=msEdgeSidebarV2", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(prof, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  await sleep(200);
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === "page");
  return { proc: p, prof, ws: page.webSocketDebuggerUrl };
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.wait = new Map(); this.handlers = []; }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; this.ws.onmessage = e => this.msg(JSON.parse(e.data)); }); }
  msg(m) {
    if (m.id && this.wait.has(m.id)) { const { res, rej } = this.wait.get(m.id); this.wait.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const h of this.handlers) h(m);
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.wait.set(id, { res, rej })); }
  async eval(expr, timeout = TIMEOUT + 30000) {
    const r = await Promise.race([this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }),
      sleep(timeout).then(() => ({ timeout: true }))]);
    if (r.timeout) return { stato: "bloccato", motivo: "la pagina non risponde" };
    if (r.exceptionDetails) return { stato: "errore", motivo: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  }
}

// ---------------------------------------------------------------- controllo nella pagina
// Gira nella pagina: apre il file e decide l'esito. Restituisce { stato: "ok"|"fallito"|..., motivo, viewer, cat, ... }
const PAGE_CHECK = async (file, timeout, expectCat, expectViewer, trySave, password, accept) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const { t } = await import("./js/i18n.js");
  const t0 = performance.now();
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const modalBack = document.getElementById("modal");
  const modals = [];
  // finestra che chiede la password (certificati .p12): si scrive quella del campione e si conferma
  const typePassword = () => {
    const inp = password && [...document.querySelectorAll("input[type=password]")].find(visible);
    if (!inp || inp.value) return false;
    inp.value = password;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    const box = inp.closest(".modal, .panel, form, [role=dialog]") || document;
    const ok = [...box.querySelectorAll("button.primary, .btn.primary")].find(visible);
    if (ok) ok.click(); else inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  };
  // finestre da confermare con i valori proposti (parametri dei file grezzi .pcm/.yuv): pulsante principale
  const acceptModal = () => {
    if (!accept || !modalBack || modalBack.hidden) return false;
    const b = [...modalBack.querySelectorAll("button.primary, .btn.primary")].find(visible);
    if (!b) return false;
    modals.push("confermato: " + modalBack.innerText.trim().split(/\n/)[0].slice(0, 80));
    b.click();
    return true;
  };
  const closeModal = () => { if (typePassword() || acceptModal()) return; if (modalBack && !modalBack.hidden) { modals.push(modalBack.innerText.trim().slice(0, 200)); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } };
  // avvisi rossi (es. ONLYOFFICE che rifiuta il documento): l'editor gira in un riquadro di un'altra origine
  const toasts = [];
  const toastEl = document.getElementById("toast");
  const toastObs = new MutationObserver(() => { if (!toastEl.hidden && toastEl.classList.contains("bad")) toasts.push(toastEl.textContent.trim().slice(0, 300)); });
  toastObs.observe(toastEl, { attributes: true, childList: true, characterData: true, subtree: true });
  const before = new Set(MB.tabs);
  const opening = MB.openFile(file, null, { fresh: true });
  let tab = null;
  while (!tab && performance.now() - t0 < timeout) { tab = MB.tabs.find(x => !before.has(x) && x.path === file); if (!tab) { closeModal(); await sleep(100); } }
  if (!tab) return { stato: "fallito", motivo: "nessuna scheda aperta" + (modals.length ? " (" + modals.join(" | ") + ")" : ""), modals };
  await Promise.race([opening, sleep(timeout)]);
  const labels = [t("app.apri_come_esadecimale"), t("v_office.serve_libreoffice_questo_formato")];
  let res = null, stable = 0, lastSig = "";
  while (performance.now() - t0 < timeout) {
    closeModal();
    const v = tab.view;
    const out = { viewer: tab.viewer, cat: tab.cat?.id || null };
    const rc = v.querySelector(".rc");
    if (tab.viewer === "recover" || rc) { res = { ...out, stato: "fallito", motivo: "schermata di recupero: " + (v.querySelector(".rc-head")?.innerText || "").replace(/\s+/g, " ").slice(0, 300) }; break; }
    const errs = [...v.querySelectorAll(".err, .error, .v-error")].filter(visible).map(e => e.innerText.trim()).filter(Boolean);
    if (errs.length) { res = { ...out, stato: "fallito", motivo: "errore: " + errs.join(" | ").slice(0, 300) }; break; }
    if (toasts.length) { res = { ...out, stato: "fallito", motivo: "avviso: " + toasts[0] }; break; }
    const txt = v.innerText || "";
    if (labels.some(l => l && txt.includes(l)) && v.querySelector(".center .panel")) { res = { ...out, stato: "fallito", motivo: "ripiego: " + v.querySelector(".center .panel").innerText.replace(/\s+/g, " ").slice(0, 300) }; break; }
    const spin = [...v.querySelectorAll(".spinner, .progress")].filter(visible).length;
    // audio e video: servono i metadati letti dal browser (anche dopo la conversione)
    const media = v.querySelector("video, audio");
    let mediaOk = true;
    if (tab.viewer === "media") {
      mediaOk = !!media && media.readyState >= 1 && !media.error;
      if (media?.error) { res = { ...out, stato: "fallito", motivo: "il browser non riproduce: codice " + media.error.code }; break; }
    }
    // pdf.js nel suo iframe: pagine disegnate o messaggio di errore
    let pdfOk = true;
    const ifr = [...v.querySelectorAll("iframe")].find(f => { try { return !!f.contentWindow.PDFViewerApplication; } catch { return false; } });
    if (ifr) {
      const app = ifr.contentWindow.PDFViewerApplication;
      const ew = ifr.contentDocument.querySelector("#errorWrapper");
      if (ew && visible(ew) && !ew.hidden) { res = { ...out, stato: "fallito", motivo: "pdf.js: " + ew.innerText.slice(0, 200) }; break; }
      pdfOk = app.pdfDocument && app.pagesCount > 0 && !!ifr.contentDocument.querySelector(".page canvas, .page .canvasWrapper canvas");
    }
    const sig = `${spin}|${v.querySelectorAll("*").length}|${txt.length}|${mediaOk}|${pdfOk}`;
    if (!spin && mediaOk && pdfOk) { if (sig === lastSig) stable++; else stable = 0; } else stable = 0;
    lastSig = sig;
    if (stable >= 6) {
      const content = v.querySelectorAll("canvas, img, video, audio, iframe, svg, table, tr, .monaco-editor, li").length + 4 * v.querySelectorAll("iframe").length + Math.min(txt.length, 2000) / 40;
      res = { ...out, stato: content > 1 ? "ok" : "vuoto", motivo: content > 1 ? "" : "nessun contenuto visibile", ms: Math.round(performance.now() - t0) };
      break;
    }
    await sleep(250);
  }
  if (!res) res = { viewer: tab.viewer, cat: tab.cat?.id || null, stato: "fallito", motivo: "ancora in caricamento dopo " + Math.round(timeout / 1000) + " s" };
  // stessa categoria, oppure lo stesso visualizzatore (GeoTIFF e zip con shapefile: categoria immagine/archivio, mappa GIS)
  if (expectCat && res.cat !== expectCat && res.viewer !== expectViewer && !(res.viewer === "oo" && ["docx", "sheet", "pptx", "office"].includes(expectViewer))) { res.atteso = expectCat; if (res.stato === "ok") { res.stato = "fallito"; res.motivo = `categoria ${res.cat} invece di ${expectCat}`; } }
  res.modals = modals;
  toastObs.disconnect();
  // salvataggio nel formato del file (dove il visualizzatore lo prevede): stessi byte o un file nuovo leggibile
  if (res.stato === "ok" && trySave && typeof tab.api?.save === "function") {
    try {
      const r = await Promise.race([tab.api.save(trySave), sleep(30000).then(() => "tempo")]);
      res.salva = r === "tempo" ? "tempo scaduto" : "ok";
    } catch (e) { res.salva = "errore: " + String(e?.message || e).slice(0, 200); }
  }
  window.__lastTab = tab;
  return res;
};

const CLOSE = `(async () => { const t = window.__lastTab; if (t) { t.dirty = false; try { await MB.closeTab(t); } catch {} } for (const x of [...MB.tabs]) { x.dirty = false; try { await MB.closeTab(x); } catch {} } return MB.tabs.length; })()`;

// ---------------------------------------------------------------- giro
const results = [];
const srv = await startServer();
const edge = await startEdge();
const cdp = new Cdp(edge.ws);
await cdp.open();
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
let cur = null;
cdp.handlers.push(m => {
  if (!cur) return;
  if (m.method === "Runtime.exceptionThrown") cur.eccezioni.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").split("\n")[0].slice(0, 200));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") cur.console.push(m.params.args.map(a => a.value ?? a.description ?? "").join(" ").split("\n")[0].slice(0, 200));
});
await cdp.send("Page.navigate", { url: srv.url });
for (let i = 0; i < 100; i++) { if (await cdp.eval("!!(window.MB && MB.tabs)", 5000) === true) break; await sleep(200); }
await sleep(1500);
console.log(`${items.length} campioni, server ${srv.url.replace(/\?.*/, "")}`);

// --from N: si riparte dal campione N (numerazione del registro di un giro interrotto)
const FROM = Number(opt("from", 1));
for (const [n, it] of items.entries()) {
  if (n + 1 < FROM) continue;
  const file = path.resolve(SAMPLES, it.file);
  cur = { ext: it.ext, cat: it.cat, file: it.file, fonte: it.fonte || "", eccezioni: [], console: [] };
  const t0 = Date.now();
  let r = await cdp.eval(`(${PAGE_CHECK})(${JSON.stringify(file)}, ${TIMEOUT}, ${JSON.stringify(it.cat || null)}, ${JSON.stringify(VIEWER_OF[it.cat] || null)}, ${JSON.stringify(it.save ? path.join(OUT, "salvati", `${it.ext}-${n}.${it.save}`) : null)}, ${JSON.stringify(it.password || null)}, ${JSON.stringify(!!it.accept)})`);
  if (!r || typeof r !== "object") r = { stato: "errore", motivo: String(r) };
  Object.assign(cur, r, { secondi: Math.round((Date.now() - t0) / 100) / 10 });
  if (flag("shots") || cur.stato !== "ok") {
    try {
      const s = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 45 });
      fs.writeFileSync(path.join(OUT, "schermate", `${it.ext}${it.cat ? "-" + it.cat : ""}.jpg`), Buffer.from(s.data, "base64"));
    } catch { /* */ }
  }
  results.push(cur);
  console.log(`[${n + 1}/${items.length}] .${it.ext} (${it.cat}) ${cur.stato}${cur.motivo ? " - " + cur.motivo : ""}${cur.salva && cur.salva !== "ok" ? " | salva: " + cur.salva : ""}`);
  cur = null;
  if (r.stato === "bloccato") { await cdp.send("Page.reload"); await sleep(4000); }
  else await cdp.eval(CLOSE, 15000);
}

// ---------------------------------------------------------------- resoconto
fs.writeFileSync(path.join(OUT, "risultati.json"), JSON.stringify(results, null, 1));
const ok = results.filter(r => r.stato === "ok");
const bad = results.filter(r => r.stato !== "ok");
const md = [`# Collaudo di tutti i formati`, "", `Campioni: ${results.length} - riusciti: ${ok.length} - non riusciti: ${bad.length}`, "",
  "| Estensione | Categoria | Visualizzatore | Esito | Motivo | s |", "|---|---|---|---|---|---|",
  ...results.map(r => `| .${r.ext} | ${r.cat || ""} | ${r.viewer || ""} | ${r.stato}${r.salva ? " / salva " + r.salva : ""} | ${(r.motivo || "").replace(/\|/g, "/")} | ${r.secondi} |`)];
fs.writeFileSync(path.join(OUT, "risultati.md"), md.join("\n") + "\n");
console.log(`\nRiusciti ${ok.length} su ${results.length}. Esito in ${OUT}`);
for (const r of bad) console.log(`  .${r.ext} (${r.cat}): ${r.stato} - ${r.motivo}`);
cdp.ws.close();
edge.proc.kill();
srv.proc.kill();
try { fs.rmSync(edge.prof, { recursive: true, force: true }); } catch { /* */ }
process.exit(bad.length && !flag("keep-going") ? 1 : 0);
