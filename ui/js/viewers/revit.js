// Autodesk Revit (.rvt/.rfa/.rte/.rft) senza Revit: anteprima incorporata, versione e build di Revit, condivisione,
// file centrale, riferimenti esterni; per le famiglie categoria, parametri e tipi. Motore: mbvisual/fx_revit.py (solo PC).
import { api, el, loadCss, loading } from "../core.js";

export async function mount(ctx) {
  loadCss("css/formati.css");
  loading(ctx.el, "Lettura delle informazioni del file Revit");
  const r = await api("fx", { op: "revit_read", path: ctx.path });
  ctx.el.innerHTML = "";
  const page = el("div", { class: "fx-page" });
  ctx.el.append(page);
  const fam = r.famiglia;
  page.append(el("div", { class: "fx-row" }, el("h2", {}, `${r.tipo} Revit${r.versione ? " " + r.versione : ""}`),
    fam?.categorie?.length ? el("span", { class: "chip mute" }, fam.categorie.join(", ")) : null));
  page.append(el("p", { class: "fx-muted", style: { margin: 0 } }, "La geometria del modello e' in formato proprietario Autodesk e si apre solo con Revit (o con un IFC esportato da Revit); qui si vedono l'anteprima e i dati descrittivi salvati nel file."));

  const top = el("div", { style: { display: "grid", gridTemplateColumns: "minmax(200px, 360px) 1fr", gap: "16px", alignItems: "start" } });
  const prev = el("div", { class: "panel", style: { display: "grid", placeItems: "center", minHeight: "160px", background: "#fff" } });
  if (r.anteprima) prev.append(el("img", { src: "/api/fx?" + new URLSearchParams({ op: "revit_preview", path: ctx.path }), alt: "Anteprima", style: { maxWidth: "100%", imageRendering: "auto" } }));
  else prev.append(el("span", { class: "fx-muted" }, "Nessuna anteprima nel file"));
  const dl = el("dl", { class: "kv" });
  const add = (k, v) => { if (v !== undefined && v !== null && v !== "") dl.append(el("dt", {}, k), el("dd", {}, String(v))); };
  add("Versione di Revit", r.versione);
  for (const i of r.info) add(i.campo, i.valore);
  if (fam) { add("Famiglia", fam.titolo); add("Ospite", fam.ospite); add("Numero di tipi", fam.numero_tipi); add("Aggiornata il", fam.aggiornato); }
  add("Partizioni dei dati", r.partizioni);
  top.append(prev, el("div", { class: "panel" }, el("h3", {}, "Informazioni del file"), dl));
  page.append(top);

  if (fam?.parametri?.length) {
    const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, ...["Gruppo", "Parametro", "Valore", "Tipo"].map(h => el("th", {}, h)))));
    const tb = el("tbody");
    for (const p of fam.parametri) tb.append(el("tr", {}, el("td", {}, p.gruppo), el("td", {}, p.nome), el("td", {}, p.valore), el("td", { class: "fx-muted" }, p.tipo || p.origine)));
    t.append(tb);
    page.append(el("div", { class: "panel" }, el("h3", {}, "Parametri della famiglia"), t));
  }
  if (fam?.tipi?.some(x => x.parametri.length)) {
    for (const ty of fam.tipi) {
      const t = el("table", { class: "fx-table" });
      for (const p of ty.parametri) t.append(el("tr", {}, el("td", {}, p.nome), el("td", {}, p.valore, p.unita ? " " + p.unita : "")));
      page.append(el("div", { class: "panel" }, el("h3", {}, "Tipo: " + ty.nome), t));
    }
  }
  if (r.riferimenti.length) {
    const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, ...["Tipo", "Percorso", "Stato"].map(h => el("th", {}, h)))));
    const tb = el("tbody");
    for (const x of r.riferimenti) tb.append(el("tr", {}, el("td", {}, x.tipo), el("td", { style: { overflowWrap: "anywhere" } }, x.percorso), el("td", {}, x.stato)));
    t.append(tb);
    page.append(el("div", { class: "panel" }, el("h3", {}, "Riferimenti esterni (collegamenti)"), t));
  }
  ctx.status(`${r.tipo} Revit ${r.versione}`);
  return {
    saveInPlace: false,
    saveFormats: [...(r.anteprima ? ["png"] : []), "txt", "json"],
    saveLabels: { png: "Anteprima incorporata", txt: "Informazioni in testo", json: "Informazioni in JSON" },
    async save(target) { await api("fx", { op: "revit_export", path: ctx.path }, { json: { out: target } }); return { switchTo: false }; },
  };
}
