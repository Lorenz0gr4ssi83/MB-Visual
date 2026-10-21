// Menu "IA" dell'editor di immagini (ui/js/imgedit.js): funzioni come quelle di Photoshop, eseguite dal motore IA locale
// (ia/engine.py, nessun servizio esterno). Riempimento generativo e Rimuovi creano un livello nuovo (l'originale non cambia),
// Seleziona soggetto/parti creano una selezione, Espansione generativa allarga il quadro e lo riempie.
// Controlli del motore: niente minori, niente atti sessuali espliciti (nudo artistico/moda, lingerie e pose sono ammessi).
import { api, el, modal, toast, waitJob, fileUrl } from "./core.js";
import { t } from "./i18n.js";

let STATUS = null;
async function engine(force = false) {
  if (!STATUS || force) STATUS = await api("ia_status", {}, { allowFail: true });
  return STATUS;
}

const toBlob = c => new Promise(r => c.toBlob(r, "image/png"));
async function put(canvas) { return (await api("ia_put", {}, { body: new Uint8Array(await (await toBlob(canvas)).arrayBuffer()) })).path; }
const loadImg = p => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(t("aiedit.risultato_non_leggibile"))); i.src = fileUrl(p) + "&v=" + Date.now(); });
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

// Elaborazioni in un riquadro in basso a destra, NON bloccante: mentre il motore calcola (minuti sul processore) si puo'
// lavorare negli altri file; a fine lavoro il risultato entra comunque nell'immagine da cui e' partito.
const CSS = `.ia-jobs{position:fixed;right:14px;bottom:34px;z-index:90;display:flex;flex-direction:column;gap:8px;width:330px;max-width:calc(100vw - 28px)}
.ia-job{background:var(--panel,#fff);color:var(--fg,#222);border:1px solid var(--line,#ccc);border-radius:8px;box-shadow:var(--shadow);padding:9px 11px;font-size:12.5px}
.ia-job-h{display:flex;gap:6px;align-items:center}.ia-job-h .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}
.ia-job .progress{margin-top:6px}.ia-job .msg{margin-top:4px;opacity:.85}.ia-job.bad{border-color:var(--bad,#c33)}
.ia-job .acts{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}.ia-job .x{border:0;background:none;color:inherit;font-size:15px;padding:0 3px}`;
function jobsPanel() {
  let p = document.getElementById("ia-jobs");
  if (!p) {
    document.head.append(el("style", {}, CSS));
    p = el("div", { id: "ia-jobs", class: "ia-jobs" });
    document.body.append(p);
  }
  return p;
}

async function run(host, title, params) {
  const s = await engine();
  if (!s?.installato) { await modal(t("aiedit.motore_ia_non_installato"), el("p", {}, t("aiedit.motore_ia_non_installato_questo"))); return null; }
  const tab = host.ctx.tab, name = host.ctx.name || t("aiedit.immagine");
  const bar = el("div", { class: "progress" }, el("span"));
  const msg = el("div", { class: "msg" }, t("aiedit.avvio_motore_ia_prima_volta"));
  const rid = Math.random().toString(36).slice(2) + Date.now().toString(36);  // id per l'interruzione
  // Interrompi: effetto immediato nell'app (il risultato, se arriva, si scarta); il motore si ferma al primo passo utile
  let stopped = false, onStop;
  const stopP = new Promise(r => (onStop = r));
  const stopBtn = el("button", { class: "btn small", onclick: () => {
    stopped = true;
    api("ia_cancel", { id: rid }, { allowFail: true });
    onStop();
  } }, t("aiedit.interrompi"));
  const acts = el("div", { class: "acts" }, stopBtn);
  const item = el("div", { class: "ia-job" },
    el("div", { class: "ia-job-h" }, el("b", {}, title), el("span", { class: "nm", title: name }, "· " + name),
      el("button", { class: "x", title: t("aiedit.nascondi_lavoro_continua"), onclick: () => item.remove() }, "×")), msg, bar, acts);
  jobsPanel().append(item);
  const t0 = Date.now(), sec = () => Math.round((Date.now() - t0) / 1000);
  const MB = window.MB;
  const isActive = () => !MB?.active || MB.active === tab;
  const goTo = () => { if (MB?.activate && MB.tabs.includes(tab)) MB.activate(tab); item.remove(); };
  try {
    const { job } = await api("ia_run", {}, { json: { ...params, _id: rid } });
    const r = await Promise.race([stopP.then(() => { throw new Error(t("aiedit.interrotto")); }), waitJob(job, (p, m) => { if (stopped) return; bar.firstChild.style.width = Math.round((p || 0) * 100) + "%"; msg.textContent = (m || t("aiedit.elaborazione")) + ` · ${sec()} s`; })]);
    bar.remove();
    stopBtn.remove();
    if (MB && !MB.tabs.includes(tab)) { msg.textContent = t("aiedit.completato_0_s_ma_scheda", sec()); return null; }
    msg.textContent = t("aiedit.completato_0_s", sec());
    host.ctx.status(`${title}: ${sec()} s`);
    if (isActive()) setTimeout(() => item.remove(), 5000);
    else {
      acts.append(el("button", { class: "btn small primary", onclick: goTo }, t("aiedit.vai_all_immagine")));
      toast(t("aiedit.0_completato_1", title, name));
    }
    return r;
  } catch (e) {
    bar.remove();
    stopBtn.remove();
    if (stopped || /Interrotto/.test(e.message)) {  // fermato da chi lavora: nessun errore, l'immagine resta com'era
      msg.textContent = t("aiedit.interrotto_dopo_0_s_l", sec());
      setTimeout(() => item.remove(), 4000);
      return null;
    }
    item.classList.add("bad");
    msg.textContent = e.message;
    if (!isActive()) acts.append(el("button", { class: "btn small", onclick: goTo }, t("aiedit.vai_all_immagine")));
    return null;
  }
}

function needSel(host) { if (!host.selMask()) { toast(t("aiedit.prima_seleziona_zona_lazo_selezione"), true); return false; } return true; }

async function promptDialog(title, label, opts = {}) {
  const ta = el("textarea", { rows: 3, class: "field", style: { width: "100%", minWidth: "420px" }, placeholder: opts.placeholder || "" }, opts.value || "");
  const q = el("select", { class: "field" },
    el("option", { value: "veloce" }, t("aiedit.veloce_bozza")),
    el("option", { value: "alta", selected: true }, t("aiedit.alta_consigliata")),
    el("option", { value: "massima" }, t("aiedit.massima_piu_dettagli_molto_lenta")));
  const pe = el("input", { type: "checkbox", checked: opts.persona || undefined });
  const ok = await modal(title, el("div", { style: { display: "grid", gap: "8px" } }, el("label", { style: { display: "grid", gap: "4px" } }, label, ta),
    el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, t("aiedit.qualita"), q),
    opts.fill ? el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, pe,
      t("aiedit.abiti_persona_mantieni_sagoma_forme")) : null,
    el("p", { class: "note", style: { margin: 0 } }, t("aiedit.scrivi_inglese_i_risultati_migliori"))),
  [{ label: t("common.annulla"), value: false }, { label: t("aiedit.genera"), value: true, primary: true }]);
  return ok ? { prompt: ta.value.trim(), qualita: q.value, persona: pe.checked } : null;
}

async function genFill(host, preset = null) {
  if (!needSel(host)) return;
  const p = preset || await promptDialog(t("aiedit.riempimento_generativo"), t("aiedit.cosa_mettere_selezione"), { fill: true, persona: partVer === host.version() });
  if (!p) return;
  const [W, H] = host.size();
  const image = await put(host.flatten()), mask = await put(alphaToMask(host.selMask()));
  const r = await run(host, t("aiedit.riempimento_generativo"), { op: "fill", image, mask, prompt: p.prompt, qualita: p.qualita, persona: !!p.persona });
  if (!r) return;
  host.addLayer(toCanvas(await loadImg(r.path)), r.x, r.y, (p.prompt ? "IA: " + p.prompt.slice(0, 40) : t("aiedit.riempimento_generativo")));
  void W; void H;
}

async function removeObj(host) {
  if (!needSel(host)) return;
  const image = await put(host.flatten()), mask = await put(alphaToMask(host.selMask()));
  const r = await run(host, t("aiedit.rimuovi"), { op: "erase", image, mask });
  if (r) host.addLayer(toCanvas(await loadImg(r.path)), r.x, r.y, t("aiedit.rimuovi"));
}

async function selectSubject(host) {
  const [W, H] = host.size();
  const r = await run(host, t("aiedit.seleziona_soggetto"), { op: "subject", image: await put(host.flatten()) });
  if (r) host.setSel(maskToAlpha(await loadImg(r.mask), W, H), t("aiedit.seleziona_soggetto"));
}

let partsCache = null, partVer = -1;  // partVer: versione dopo "Seleziona parti" (selezione ancora quella)
async function selectPart(host, part) {
  const [W, H] = host.size();
  const key = host.version();
  if (!partsCache || partsCache.key !== key) {
    const r = await run(host, t("aiedit.riconoscimento_parti"), { op: "segment", image: await put(host.flatten()) });
    if (!r) return;
    partsCache = { key, maschere: r.maschere };
  }
  const p = partsCache.maschere[part];
  if (!p) return toast(t("aiedit.nell_immagine_non_trovo_0", part), true);
  host.setSel(maskToAlpha(await loadImg(p), W, H), t("aiedit.seleziona") + part);
  partVer = host.version();
}

async function removeBg(host) {
  const r = await run(host, t("aiedit.rimuovi_sfondo"), { op: "removebg", image: await put(host.flatten()) });
  if (!r) return;
  host.addLayer(toCanvas(await loadImg(r.path)), 0, 0, t("aiedit.soggetto_senza_sfondo"));
  host.hideBelowTop();
}

async function expand(host) {
  const inp = (l, v) => { const i = el("input", { type: "number", class: "field", value: v, min: 0, max: 4000, style: { width: "90px" } }); return [el("span", {}, l), i]; };
  const [lt, li] = inp(t("aiedit.sinistra"), 0), [rt, ri] = inp(t("aiedit.destra"), 0), [tt, ti] = inp(t("aiedit.sopra"), 0), [bt, bi] = inp(t("aiedit.sotto"), 0);
  const ta = el("input", { type: "text", class: "field", style: { width: "100%" }, placeholder: t("aiedit.facoltativo_cosa_aggiungere_lati_es") });
  const ok = await modal(t("aiedit.espansione_generativa"), el("div", { style: { display: "grid", gap: "8px", minWidth: "380px" } },
    el("p", { class: "note", style: { margin: 0 } }, t("aiedit.pixel_aggiungere_lato_l_ia")),
    el("div", { style: { display: "grid", gridTemplateColumns: "auto auto auto auto", gap: "6px 10px", alignItems: "center" } }, lt, li, rt, ri, tt, ti, bt, bi), ta),
  [{ label: t("common.annulla"), value: false }, { label: t("aiedit.espandi"), value: true, primary: true }]);
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
  host.setSel(c, t("aiedit.espansione_selezione_bordi"));
  await genFill(host, { prompt: ta.value.trim(), qualita: "alta" });
}

async function upscale(host, scale) {
  const r = await run(host, t("aiedit.aumenta_risoluzione_0", scale), { op: "upscale", image: await put(host.flatten()), scale });
  if (r) host.openResult(r.path, `${scale}x`);
}

async function generate(host) {
  const p = await promptDialog(t("aiedit.genera_immagine"), t("aiedit.descrivi_l_immagine_creare"), { placeholder: t("aiedit.es_raw_photo_female_fitness") });
  if (!p) return;
  const [W, H] = host.size();
  const r = await run(host, t("aiedit.genera_immagine"), { op: "generate", prompt: p.prompt, width: W, height: H, qualita: p.qualita });
  if (r) host.addLayer(toCanvas(await loadImg(r.path)), 0, 0, "IA: " + (p.prompt || "immagine").slice(0, 40));
}

async function engineInfo() {
  const s = await engine(true);
  const NAMES = { generativo: t("aiedit.riempimento_generazione_realistic_vision_6"), veloce_lcm: t("aiedit.acceleratore_lcm"), soggetto: t("aiedit.soggetto_sfondo_birefnet"),
    parti: "Parti: abbigliamento, pelle, capelli (SegFormer)", cancella: t("aiedit.rimuovi_oggetti_lama"), risoluzione: t("aiedit.aumento_risoluzione_real_esrgan"), controllo_eta: t("aiedit.controllo_eta_clip"), forme: t("aiedit.rispetto_forme_corpo_controlnet_depth") };
  const box = el("div", { style: { minWidth: "420px" } });
  if (!s?.installato) box.append(el("p", {}, t("aiedit.motore_ia_non_installato_questo_2")), el("p", { class: "note" }, t("aiedit.serve_cartella_l_ambiente_python")));
  else {
    if (s.errore) box.append(el("p", {}, t("aiedit.errore") + s.errore));
    const dl = el("dl", { class: "kv" });
    for (const [k, v] of Object.entries(s.modelli || {})) dl.append(el("dt", {}, NAMES[k] || k), el("dd", {}, v ? "pronto" : "mancante"));
    box.append(dl, el("p", { class: "note" }, t("aiedit.tutto_gira_questo_pc_senza")));
  }
  await modal(t("aiedit.motore_ia"), box);
}

// voci del menu IA (formato dei menu di imgedit.js)
export function aiMenu(host) {
  const noSel = () => !host.selMask();
  return [
    { label: t("aiedit.riempimento_generativo_2"), keys: "Ctrl+Shift+G", run: () => genFill(host), disabled: noSel },
    { label: t("aiedit.rimuovi_cancella_oggetto"), keys: "Ctrl+Shift+R", run: () => removeObj(host), disabled: noSel },
    { label: t("aiedit.espansione_generativa_2"), run: () => expand(host) }, "-",
    { label: t("aiedit.seleziona_soggetto"), run: () => selectSubject(host) },
    { label: t("aiedit.seleziona_parti"), sub: () => ["abbigliamento", "pelle", "capelli", "viso", "braccia", "gambe", "scarpe", "accessori", "persona"]
      .map(p => ({ label: p[0].toUpperCase() + p.slice(1), run: () => selectPart(host, p) })) },
    { label: t("aiedit.rimuovi_sfondo"), run: () => removeBg(host) }, "-",
    { label: t("aiedit.genera_immagine_2"), run: () => generate(host) },
    { label: t("aiedit.aumenta_risoluzione"), sub: () => [{ label: "2×", run: () => upscale(host, 2) }, { label: "4×", run: () => upscale(host, 4) }] }, "-",
    { label: t("aiedit.motore_ia_2"), run: engineInfo },
  ];
}
export const AI_KEYS = [["Ctrl+Shift+G", t("aiedit.riempimento_generativo")], ["Ctrl+Shift+R", t("aiedit.rimuovi_cancella_oggetto")]];
export { genFill, removeObj };
