// Menu "IA" dell'editor di immagini (ui/js/imgedit.js): funzioni come quelle di Photoshop, eseguite dal motore IA locale
// (ia/engine.py, nessun servizio esterno). Riempimento generativo e Rimuovi creano un livello nuovo (l'originale non cambia),
// Seleziona soggetto/parti creano una selezione, Espansione generativa allarga il quadro e lo riempie.
// Controlli del motore: niente minori, niente atti sessuali espliciti (nudo artistico/moda, lingerie e pose sono ammessi).
import { api, el, modal, toast, waitJob, fileUrl } from "./core.js";

let STATUS = null;
async function engine(force = false) {
  if (!STATUS || force) STATUS = await api("ia_status", {}, { allowFail: true });
  return STATUS;
}

const toBlob = c => new Promise(r => c.toBlob(r, "image/png"));
async function put(canvas) { return (await api("ia_put", {}, { body: new Uint8Array(await (await toBlob(canvas)).arrayBuffer()) })).path; }
const loadImg = p => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Risultato non leggibile")); i.src = fileUrl(p) + "&v=" + Date.now(); });
function toCanvas(img) { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext("2d").drawImage(img, 0, 0); return c; }
// maschera bianca/nera del motore -> canvas alfa (formato della selezione dell'editor)
function maskToAlpha(img, W, H) {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H), p = d.data;
  for (let i = 0; i < p.length; i += 4) { const v = p[i]; p[i] = p[i + 1] = p[i + 2] = 255; p[i + 3] = v; }
  g.putImageData(d, 0, 0);
  return c;
}
// selezione dell'editor (alfa) -> maschera bianco/nero per il motore
function alphaToMask(sel) {
  const c = document.createElement("canvas"); c.width = sel.width; c.height = sel.height;
  const g = c.getContext("2d");
  g.drawImage(sel, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
  for (let i = 0; i < p.length; i += 4) { const a = p[i + 3]; p[i] = p[i + 1] = p[i + 2] = a; p[i + 3] = 255; }
  g.putImageData(d, 0, 0);
  return c;
}

// esecuzione con finestra di avanzamento (le operazioni generative sul processore richiedono minuti)
async function run(host, title, params) {
  const s = await engine();
  if (!s?.installato) { await modal("Motore IA non installato", el("p", {}, "Il motore IA non e' installato su questo PC. Vedi il menu IA > Motore IA.")); return null; }
  const bar = el("div", { class: "progress" }, el("span"));
  const msg = el("p", { class: "note" }, "Avvio del motore IA...");
  const back = document.getElementById("modal"), body = document.getElementById("modal-body");
  body.innerHTML = "";
  body.append(el("h3", {}, title), msg, bar, el("p", { class: "note" }, "Elaborazione sul tuo PC: la prima volta il modello si carica in memoria (piu' lento), poi resta pronto."));
  back.hidden = false;
  const t0 = Date.now();
  try {
    const { job } = await api("ia_run", {}, { json: params });
    const r = await waitJob(job, (p, m) => { bar.firstChild.style.width = Math.round((p || 0) * 100) + "%"; msg.textContent = (m || "Elaborazione") + ` · ${Math.round((Date.now() - t0) / 1000)} s`; });
    back.hidden = true;
    host.ctx.status(`${title}: ${Math.round((Date.now() - t0) / 1000)} s`);
    return r;
  } catch (e) {
    back.hidden = true;
    await modal(title, el("p", {}, e.message));
    return null;
  }
}

function needSel(host) { if (!host.selMask()) { toast("Prima seleziona la zona (lazo, selezione rettangolare, Seleziona soggetto...)", true); return false; } return true; }

async function promptDialog(title, label, opts = {}) {
  const ta = el("textarea", { rows: 3, class: "field", style: { width: "100%", minWidth: "420px" }, placeholder: opts.placeholder || "" }, opts.value || "");
  const q = el("select", { class: "field" }, el("option", { value: "512" }, "Veloce (512 px)"), el("option", { value: "768", selected: opts.side === 768 || undefined }, "Qualita' (768 px, piu' lento)"));
  const pe = el("input", { type: "checkbox", checked: opts.persona || undefined });
  const ok = await modal(title, el("div", { style: { display: "grid", gap: "8px" } }, el("label", { style: { display: "grid", gap: "4px" } }, label, ta),
    el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, "Dettaglio di lavoro", q),
    opts.fill ? el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, pe,
      "Abiti su una persona: mantieni la sagoma e le forme del corpo (si rigenera solo dentro il corpo)") : null,
    el("p", { class: "note", style: { margin: 0 } }, "Scrivi in inglese per i risultati migliori (es. \"black bikini, toned abs, studio lighting\"). Lascia vuoto per completare la scena in modo naturale.")),
  [{ label: "Annulla", value: false }, { label: "Genera", value: true, primary: true }]);
  return ok ? { prompt: ta.value.trim(), side: +q.value, persona: pe.checked } : null;
}

async function genFill(host, preset = null) {
  if (!needSel(host)) return;
  const p = preset || await promptDialog("Riempimento generativo", "Cosa mettere nella selezione", { fill: true, persona: partVer === host.version() });
  if (!p) return;
  const [W, H] = host.size();
  const image = await put(host.flatten()), mask = await put(alphaToMask(host.selMask()));
  const r = await run(host, "Riempimento generativo", { op: "fill", image, mask, prompt: p.prompt, side: p.side, persona: !!p.persona });
  if (!r) return;
  host.addLayer(toCanvas(await loadImg(r.path)), r.x, r.y, (p.prompt ? "IA: " + p.prompt.slice(0, 40) : "Riempimento generativo"));
  void W; void H;
}

async function removeObj(host) {
  if (!needSel(host)) return;
  const image = await put(host.flatten()), mask = await put(alphaToMask(host.selMask()));
  const r = await run(host, "Rimuovi", { op: "erase", image, mask });
  if (r) host.addLayer(toCanvas(await loadImg(r.path)), r.x, r.y, "Rimuovi");
}

async function selectSubject(host) {
  const [W, H] = host.size();
  const r = await run(host, "Seleziona soggetto", { op: "subject", image: await put(host.flatten()) });
  if (r) host.setSel(maskToAlpha(await loadImg(r.mask), W, H), "Seleziona soggetto");
}

let partsCache = null, partVer = -1;  // partVer: versione dopo "Seleziona parti" (selezione ancora quella)
async function selectPart(host, part) {
  const [W, H] = host.size();
  const key = host.version();
  if (!partsCache || partsCache.key !== key) {
    const r = await run(host, "Riconoscimento delle parti", { op: "segment", image: await put(host.flatten()) });
    if (!r) return;
    partsCache = { key, maschere: r.maschere };
  }
  const p = partsCache.maschere[part];
  if (!p) return toast(`Nell'immagine non trovo: ${part}`, true);
  host.setSel(maskToAlpha(await loadImg(p), W, H), "Seleziona " + part);
  partVer = host.version();
}

async function removeBg(host) {
  const r = await run(host, "Rimuovi sfondo", { op: "removebg", image: await put(host.flatten()) });
  if (!r) return;
  host.addLayer(toCanvas(await loadImg(r.path)), 0, 0, "Soggetto senza sfondo");
  host.hideBelowTop();
}

async function expand(host) {
  const inp = (l, v) => { const i = el("input", { type: "number", class: "field", value: v, min: 0, max: 4000, style: { width: "90px" } }); return [el("span", {}, l), i]; };
  const [lt, li] = inp("Sinistra", 0), [rt, ri] = inp("Destra", 0), [tt, ti] = inp("Sopra", 0), [bt, bi] = inp("Sotto", 0);
  const ta = el("input", { type: "text", class: "field", style: { width: "100%" }, placeholder: "facoltativo: cosa aggiungere ai lati (es. \"stage with spotlights\")" });
  const ok = await modal("Espansione generativa", el("div", { style: { display: "grid", gap: "8px", minWidth: "380px" } },
    el("p", { class: "note", style: { margin: 0 } }, "Pixel da aggiungere per lato: l'IA completa la scena (utile per banner, formati orizzontali, stampa)."),
    el("div", { style: { display: "grid", gridTemplateColumns: "auto auto auto auto", gap: "6px 10px", alignItems: "center" } }, lt, li, rt, ri, tt, ti, bt, bi), ta),
  [{ label: "Annulla", value: false }, { label: "Espandi", value: true, primary: true }]);
  if (!ok) return;
  const [L, R, T, B] = [li, ri, ti, bi].map(i => Math.max(0, parseInt(i.value, 10) || 0));
  if (!L && !R && !T && !B) return;
  const [W, H] = host.size();
  host.canvasSize(W + L + R, H + T + B, L + R ? L / (L + R) : 0.5, T + B ? T / (T + B) : 0.5);
  // selezione = la cornice nuova (con un piccolo bordo sull'immagine per raccordare)
  const nw = W + L + R, nh = H + T + B, c = document.createElement("canvas");
  c.width = nw; c.height = nh;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, nw, nh);
  const b = 8;
  g.clearRect(L + (L ? b : 0), T + (T ? b : 0), W - (L ? b : 0) - (R ? b : 0), H - (T ? b : 0) - (B ? b : 0));
  host.setSel(c, "Espansione: selezione bordi");
  await genFill(host, { prompt: ta.value.trim(), side: 512 });
}

async function upscale(host, scale) {
  const r = await run(host, `Aumenta risoluzione ${scale}×`, { op: "upscale", image: await put(host.flatten()), scale });
  if (r) host.openResult(r.path, `${scale}x`);
}

async function generate(host) {
  const p = await promptDialog("Genera immagine", "Descrivi l'immagine da creare", { placeholder: "es. RAW photo, female fitness model on competition stage, bikini, dramatic spotlights" });
  if (!p) return;
  const [W, H] = host.size();
  const r = await run(host, "Genera immagine", { op: "generate", prompt: p.prompt, width: W, height: H, side: p.side });
  if (r) host.addLayer(toCanvas(await loadImg(r.path)), 0, 0, "IA: " + (p.prompt || "immagine").slice(0, 40));
}

async function engineInfo() {
  const s = await engine(true);
  const NAMES = { generativo: "Riempimento e generazione (Realistic Vision 6)", veloce_lcm: "Acceleratore LCM", soggetto: "Soggetto e sfondo (BiRefNet)",
    parti: "Parti: abbigliamento, pelle, capelli (SegFormer)", cancella: "Rimuovi oggetti (LaMa)", risoluzione: "Aumento risoluzione (Real-ESRGAN)", controllo_eta: "Controllo eta' (CLIP)" };
  const box = el("div", { style: { minWidth: "420px" } });
  if (!s?.installato) box.append(el("p", {}, "Il motore IA non e' installato su questo PC."), el("p", { class: "note" }, "Serve una cartella con l'ambiente Python e i modelli in %LOCALAPPDATA%\\MBVisual\\ia (circa 8 GB): chiedi a chi gestisce MB Visual."));
  else {
    if (s.errore) box.append(el("p", {}, "Errore: " + s.errore));
    const dl = el("dl", { class: "kv" });
    for (const [k, v] of Object.entries(s.modelli || {})) dl.append(el("dt", {}, NAMES[k] || k), el("dd", {}, v ? "pronto" : "mancante"));
    box.append(dl, el("p", { class: "note" }, "Tutto gira su questo PC, senza servizi esterni. Controlli attivi: niente minori, niente atti sessuali espliciti."));
  }
  await modal("Motore IA", box);
}

// voci del menu IA (formato dei menu di imgedit.js)
export function aiMenu(host) {
  const noSel = () => !host.selMask();
  return [
    { label: "Riempimento generativo...", keys: "Ctrl+Shift+G", run: () => genFill(host), disabled: noSel },
    { label: "Rimuovi (cancella oggetto)", keys: "Ctrl+Shift+R", run: () => removeObj(host), disabled: noSel },
    { label: "Espansione generativa...", run: () => expand(host) }, "-",
    { label: "Seleziona soggetto", run: () => selectSubject(host) },
    { label: "Seleziona parti", sub: () => ["abbigliamento", "pelle", "capelli", "viso", "braccia", "gambe", "scarpe", "accessori", "persona"]
      .map(p => ({ label: p[0].toUpperCase() + p.slice(1), run: () => selectPart(host, p) })) },
    { label: "Rimuovi sfondo", run: () => removeBg(host) }, "-",
    { label: "Genera immagine...", run: () => generate(host) },
    { label: "Aumenta risoluzione", sub: () => [{ label: "2×", run: () => upscale(host, 2) }, { label: "4×", run: () => upscale(host, 4) }] }, "-",
    { label: "Motore IA...", run: engineInfo },
  ];
}
export const AI_KEYS = [["Ctrl+Shift+G", "Riempimento generativo"], ["Ctrl+Shift+R", "Rimuovi (cancella oggetto)"]];
export { genFill, removeObj };
