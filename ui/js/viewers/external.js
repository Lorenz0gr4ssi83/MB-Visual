// Navisworks (nwd/nwc/nwf): formato chiuso Autodesk con geometria compressa proprietaria.
// MB Desk offre: 1) il modello federato dai file sorgente (IFC/STEP/...) della stessa cartella, aperti insieme;
// 2) l'apertura in Navisworks Freedom se presente; 3) informazioni sul file e byte grezzi.
import { api, el, fmtSize, toast } from "../core.js";
import { t, LOCALE } from "../i18n.js";

const SOURCE_EXTS = new Set(["ifc", "step", "stp", "iges", "igs", "stl", "obj", "glb", "gltf", "fbx", "3ds", "dae"]);
const MAX_TOTAL = 300 * 1024 * 1024; // oltre questa somma il browser interno rischia di esaurire la memoria

export async function mount(ctx) {
  const has = ctx.tools.navisworks;
  const openNw = () => api("open_external", { path: ctx.path, app: "navisworks" }).catch(e => toast(e.message, true));
  const d = new Date(ctx.info.modificato * 1000).toLocaleString(LOCALE);
  let sources = [];
  try {
    const r = await api("list_dir", { path: ctx.info.cartella });
    sources = r.items.filter(i => !i.dir && SOURCE_EXTS.has(i.name.split(".").pop().toLowerCase()));
  } catch { /* cartella non leggibile */ }
  sources.sort((a, b) => a.size - b.size);

  const box = el("div", { style: { padding: "26px 30px", display: "grid", gap: "16px", maxWidth: "980px" } });
  box.append(el("div", {}, el("h2", { style: { margin: "0 0 6px", fontSize: "20px", fontFamily: "var(--display)", fontWeight: 600 } }, t("v_external.modello_navisworks")),
    el("p", { style: { margin: 0, color: "var(--muted)", maxWidth: "90ch" } }, t("v_external.formato_navisworks_chiuso_versione_2020") +
      t("v_external.che_nessun_programma_esterno_ad"))));

  // 1) modello federato dai file sorgente
  const fed = el("section", { class: "panel", style: { display: "grid", gap: "10px" } });
  fed.append(el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, el("span", { class: "chip ok" }, t("v_external.senza_navisworks")), el("b", {}, t("v_external.modello_federato_file_sorgente"))));
  if (sources.length) {
    fed.append(el("p", { style: { margin: 0 } }, t("v_external.file_navisworks_solito_riunisce_i", sources.length)));
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
        if (!sel.length) return toast(t("v_external.seleziona_almeno_modello"), true);
        ctx.openFile(sel[0], "model3d", { fresh: true, extraPaths: sel.slice(1), displayName: sel.length > 1 ? t("v_external.modello_federato") : undefined });
      } }, t("v_external.apri_i_modelli_selezionati_insieme")),
      el("span", { class: "note", style: { color: "var(--muted)", fontSize: "12px" } }, t("v_external.preselezionati_i_file_fino_circa"))));
  } else {
    fed.append(el("p", { style: { margin: 0 } }, t("v_external.stessa_cartella_non_ci_sono")));
  }
  box.append(fed);

  // 2) Navisworks Freedom
  const nw = el("section", { class: "panel", style: { display: "grid", gap: "8px" } },
    el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, el("span", { class: has ? "chip ok" : "chip warn" }, has ? t("v_external.installato_questo_pc") : t("v_external.non_installato")), el("b", {}, t("v_external.autodesk_navisworks_freedom_gratuito"))),
    el("p", { style: { margin: 0 } }, has ? t("v_external.apre_file_originale_tutte_viste") : t("v_external.si_scarica_gratis_autodesk_https")),
    has ? el("div", {}, el("button", { class: "btn", onclick: openNw }, t("v_external.apri_navisworks_freedom"))) : el("span"));
  box.append(nw);

  box.append(el("dl", { class: "kv panel" }, el("dt", {}, t("v_external.file")), el("dd", {}, ctx.name), el("dt", {}, t("v_external.dimensione")), el("dd", {}, fmtSize(ctx.info.size)),
    el("dt", {}, t("v_external.modificato")), el("dd", {}, d), el("dt", {}, t("v_external.cartella")), el("dd", {}, ctx.info.cartella)));
  ctx.el.append(box);
  if (has) ctx.tb.append(el("button", { class: "btn", onclick: openNw }, t("v_external.apri_navisworks_freedom")));
  ctx.tb.append(el("button", { class: "btn", onclick: () => ctx.openAs("hex") }, t("v_external.vedi_byte_grezzi")));
  return {};
}
