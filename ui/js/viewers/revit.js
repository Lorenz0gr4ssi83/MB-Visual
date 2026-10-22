// Autodesk Revit (.rvt/.rfa/.rte/.rft) senza Revit: anteprima incorporata, versione e build di Revit, condivisione,
// file centrale, riferimenti esterni; per le famiglie categoria, parametri e tipi. Motore: mbvisual/fx_revit.py (solo PC).
import { api, el, loadCss, loading } from "../core.js";
import { t as tr } from "../i18n.js";

export async function mount(ctx) {
  loadCss("css/formati.css");
  loading(ctx.el, tr("v_revit.lettura_informazioni_file_revit"));
  const r = await api("fx", { op: "revit_read", path: ctx.path });
  ctx.el.innerHTML = "";
  const page = el("div", { class: "fx-page" });
  ctx.el.append(page);
  const fam = r.famiglia;
  page.append(el("div", { class: "fx-row" }, el("h2", {}, tr("v_revit.0_revit_1", r.tipo, r.versione ? " " + r.versione : "")),
    fam?.categorie?.length ? el("span", { class: "chip mute" }, fam.categorie.join(", ")) : null));
  page.append(el("p", { class: "fx-muted", style: { margin: 0 } }, tr("v_revit.geometria_modello_formato_proprietario_autodesk")));

  const top = el("div", { style: { display: "grid", gridTemplateColumns: "minmax(200px, 360px) 1fr", gap: "16px", alignItems: "start" } });
  const prev = el("div", { class: "panel", style: { display: "grid", placeItems: "center", minHeight: "160px", background: "#fff" } });
  if (r.anteprima) prev.append(el("img", { src: "/api/fx?" + new URLSearchParams({ op: "revit_preview", path: ctx.path }), alt: tr("v_revit.anteprima"), style: { maxWidth: "100%", imageRendering: "auto" } }));
  else prev.append(el("span", { class: "fx-muted" }, tr("v_revit.nessuna_anteprima_file")));
  const dl = el("dl", { class: "kv" });
  const add = (k, v) => { if (v !== undefined && v !== null && v !== "") dl.append(el("dt", {}, k), el("dd", {}, String(v))); };
  add(tr("v_revit.versione_revit"), r.versione);
  for (const i of r.info) add(i.campo, i.valore);
  if (fam) { add(tr("v_revit.famiglia"), fam.titolo); add(tr("v_revit.ospite"), fam.ospite); add(tr("v_revit.numero_tipi"), fam.numero_tipi); add(tr("v_revit.aggiornata"), fam.aggiornato); }
  add(tr("v_revit.partizioni_dati"), r.partizioni);
  top.append(prev, el("div", { class: "panel" }, el("h3", {}, tr("v_revit.informazioni_file")), dl));
  page.append(top);

  if (fam?.parametri?.length) {
    const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, ...[tr("v_revit.gruppo"), tr("v_revit.parametro"), tr("v_revit.valore"), tr("v_revit.tipo")].map(h => el("th", {}, h)))));
    const tb = el("tbody");
    for (const p of fam.parametri) tb.append(el("tr", {}, el("td", {}, p.gruppo), el("td", {}, p.nome), el("td", {}, p.valore), el("td", { class: "fx-muted" }, p.tipo || p.origine)));
    t.append(tb);
    page.append(el("div", { class: "panel" }, el("h3", {}, tr("v_revit.parametri_famiglia")), t));
  }
  if (fam?.tipi?.some(x => x.parametri.length)) {
    for (const ty of fam.tipi) {
      const t = el("table", { class: "fx-table" });
      for (const p of ty.parametri) t.append(el("tr", {}, el("td", {}, p.nome), el("td", {}, p.valore, p.unita ? " " + p.unita : "")));
      page.append(el("div", { class: "panel" }, el("h3", {}, tr("v_revit.tipo_2") + ty.nome), t));
    }
  }
  if (r.riferimenti.length) {
    const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, ...[tr("v_revit.tipo"), tr("v_revit.percorso"), tr("v_revit.stato")].map(h => el("th", {}, h)))));
    const tb = el("tbody");
    for (const x of r.riferimenti) tb.append(el("tr", {}, el("td", {}, x.tipo), el("td", { style: { overflowWrap: "anywhere" } }, x.percorso), el("td", {}, x.stato)));
    t.append(tb);
    page.append(el("div", { class: "panel" }, el("h3", {}, tr("v_revit.riferimenti_esterni_collegamenti")), t));
  }
  ctx.status(tr("v_revit.0_revit_1_2", r.tipo, r.versione));
  return {
    saveInPlace: false,
    saveFormats: [...(r.anteprima ? ["png"] : []), "txt", "json"],
    saveLabels: { png: tr("v_revit.anteprima_incorporata"), txt: tr("v_revit.informazioni_testo"), json: tr("v_revit.informazioni_json") },
    async save(target) { await api("fx", { op: "revit_export", path: ctx.path }, { json: { out: target } }); return { switchTo: false }; },
  };
}
