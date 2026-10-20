// Navisworks (nwd/nwc/nwf): formato chiuso Autodesk con geometria compressa proprietaria.
// MB Visual offre: 1) il modello federato dai file sorgente (IFC/STEP/...) della stessa cartella, aperti insieme;
// 2) l'apertura in Navisworks Freedom se presente; 3) informazioni sul file e byte grezzi.
import { api, el, fmtSize, toast } from "../core.js";

const SOURCE_EXTS = new Set(["ifc", "step", "stp", "iges", "igs", "stl", "obj", "glb", "gltf", "fbx", "3ds", "dae"]);
const MAX_TOTAL = 300 * 1024 * 1024; // oltre questa somma il browser interno rischia di esaurire la memoria

export async function mount(ctx) {
  const has = ctx.tools.navisworks;
  const openNw = () => api("open_external", { path: ctx.path, app: "navisworks" }).catch(e => toast(e.message, true));
  const d = new Date(ctx.info.modificato * 1000).toLocaleString("it-IT");
  let sources = [];
  try {
    const r = await api("list_dir", { path: ctx.info.cartella });
    sources = r.items.filter(i => !i.dir && SOURCE_EXTS.has(i.name.split(".").pop().toLowerCase()));
  } catch { /* cartella non leggibile */ }
  sources.sort((a, b) => a.size - b.size);

  const box = el("div", { style: { padding: "26px 30px", display: "grid", gap: "16px", maxWidth: "980px" } });
  box.append(el("div", {}, el("h2", { style: { margin: "0 0 6px", fontSize: "20px", fontFamily: "var(--display)", fontWeight: 600 } }, "Modello Navisworks"),
    el("p", { style: { margin: 0, color: "var(--muted)", maxWidth: "90ch" } }, "Il formato Navisworks e' chiuso: dalla versione 2020 la geometria e' salvata compressa con un algoritmo proprietario Autodesk, " +
      "che nessun programma esterno ad Autodesk sa decodificare. MB Visual offre due strade.")));

  // 1) modello federato dai file sorgente
  const fed = el("section", { class: "panel", style: { display: "grid", gap: "10px" } });
  fed.append(el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, el("span", { class: "chip ok" }, "Senza Navisworks"), el("b", {}, "Modello federato dai file sorgente")));
  if (sources.length) {
    fed.append(el("p", { style: { margin: 0 } }, `Un file Navisworks di solito riunisce i modelli di progetto. Nella stessa cartella ci sono ${sources.length} modelli che MB Visual apre direttamente, anche tutti insieme nella stessa scena 3D e con le stesse coordinate.`));
    const list = el("div", { style: { display: "grid", gap: "4px", maxHeight: "260px", overflow: "auto" } });
    const checks = [];
    let total = 0;
    for (const s of sources) {
      const on = total + s.size <= MAX_TOTAL;
      if (on) total += s.size;
      const cb = el("input", { type: "checkbox", checked: on });
      checks.push([cb, s]);
      list.append(el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, cb, el("span", { style: { flex: 1, overflowWrap: "anywhere" } }, s.name), el("span", { class: "mono", style: { color: "var(--muted)" } }, fmtSize(s.size))));
    }
    fed.append(list, el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
      el("button", { class: "btn primary", onclick: () => {
        const sel = checks.filter(([cb]) => cb.checked).map(([, s]) => s.path);
        if (!sel.length) return toast("Seleziona almeno un modello", true);
        ctx.openFile(sel[0], "model3d", { fresh: true, extraPaths: sel.slice(1), displayName: sel.length > 1 ? "Modello federato" : undefined });
      } }, "Apri i modelli selezionati insieme"),
      el("span", { class: "note", style: { color: "var(--muted)", fontSize: "12px" } }, "Preselezionati i file fino a circa 300 MB in totale: i modelli molto grandi richiedono molta memoria e tempo di caricamento.")));
  } else {
    fed.append(el("p", { style: { margin: 0 } }, "Nella stessa cartella non ci sono modelli sorgente (IFC, STEP, ecc.). Chiedi a chi ha prodotto il file Navisworks anche i modelli IFC o NWC di partenza: MB Visual li apre tutti, anche insieme."));
  }
  box.append(fed);

  // 2) Navisworks Freedom
  const nw = el("section", { class: "panel", style: { display: "grid", gap: "8px" } },
    el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, el("span", { class: has ? "chip ok" : "chip warn" }, has ? "Installato su questo PC" : "Non installato"), el("b", {}, "Autodesk Navisworks Freedom (gratuito)")),
    el("p", { style: { margin: 0 } }, has ? "Apre il file originale con tutte le viste salvate, i commenti e le proprieta'." : "Si scarica gratis da Autodesk (https://www.autodesk.com/viewers). Una volta installato, MB Visual lo usa con un clic."),
    has ? el("div", {}, el("button", { class: "btn", onclick: openNw }, "Apri in Navisworks Freedom")) : el("span"));
  box.append(nw);

  box.append(el("dl", { class: "kv panel" }, el("dt", {}, "File"), el("dd", {}, ctx.name), el("dt", {}, "Dimensione"), el("dd", {}, fmtSize(ctx.info.size)),
    el("dt", {}, "Modificato"), el("dd", {}, d), el("dt", {}, "Cartella"), el("dd", {}, ctx.info.cartella)));
  ctx.el.append(box);
  if (has) ctx.tb.append(el("button", { class: "btn", onclick: openNw }, "Apri in Navisworks Freedom"));
  ctx.tb.append(el("button", { class: "btn", onclick: () => ctx.openAs("hex") }, "Vedi byte grezzi"));
  return {};
}
