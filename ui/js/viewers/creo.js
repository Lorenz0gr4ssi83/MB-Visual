// PTC Creo Parametric / Pro/ENGINEER (.prt .asm .drw .frm, anche pezzo.prt.3) senza Creo: anteprima salvata nel file, tipo,
// nome del modello, versione di Creo, sezioni. La geometria e' in un formato proprietario compresso: si dice chiaramente e si
// propongono le strade che funzionano (STEP esportato accanto, Creo Parametric o Creo View installati). Motore: mbvisual/fx_creo.py.
import { api, button, el, loadCss, loading, toast } from "../core.js";
import { t as tr } from "../i18n.js";

export async function mount(ctx) {
  loadCss("css/formati.css");
  loading(ctx.el, tr("v_creo.lettura"));
  const r = await api("fx", { op: "creo_read", path: ctx.path });
  ctx.el.innerHTML = "";
  const page = el("div", { class: "fx-page" });
  ctx.el.append(page);
  const tipo = tr("v_creo.tipo_" + r.tipo_chiave);
  page.append(el("div", { class: "fx-row" }, el("h2", {}, r.nome || ctx.name),
    el("span", { class: "chip mute" }, tipo), r.versione ? el("span", { class: "chip mute" }, `${r.programma} ${r.versione}`) : null));

  const actions = el("div", { class: "fx-row" });
  for (const s of r.step || []) actions.append(el("button", { class: "btn primary", onclick: () => ctx.openFile(s) }, tr("v_creo.apri_step", s.split(/[\\/]/).pop())));
  for (const p of r.programmi || []) {
    actions.append(el("button", { class: "btn", onclick: () => api("fx", { op: "creo_open", path: ctx.path }, { json: { exe: p.path } }).then(() => toast(tr("v_creo.apertura_in", p.nome))).catch(e => toast(e.message, true)) },
      tr(p.tipo === "view" ? "v_creo.apri_creo_view" : "v_creo.apri_creo_parametric", p.nome)));
  }
  page.append(el("div", { class: "fx-notice" }, el("b", {}, tr("v_creo.avviso_titolo")),
    el("p", {}, tr("v_creo.avviso_geometria")),
    el("p", {}, r.step?.length ? tr("v_creo.avviso_step_trovato") : tr("v_creo.avviso_step")),
    actions.childNodes.length ? actions : null));

  const top = el("div", { style: { display: "grid", gridTemplateColumns: "minmax(200px, 300px) 1fr", gap: "16px", alignItems: "start" } });
  const prev = el("div", { class: "panel", style: { display: "grid", placeItems: "center", minHeight: "160px" } });
  if (r.anteprima) prev.append(el("img", { src: "/api/fx?" + new URLSearchParams({ op: "creo_preview", path: ctx.path }), alt: tr("v_creo.anteprima"), style: { maxWidth: "100%", borderRadius: "4px" } }));
  else prev.append(el("span", { class: "fx-muted", style: { textAlign: "center" } }, tr("v_creo.nessuna_anteprima")));
  const dl = el("dl", { class: "kv" });
  const add = (k, v) => { if (v !== undefined && v !== null && v !== "") dl.append(el("dt", {}, k), el("dd", {}, String(v))); };
  add(tr("v_creo.tipo"), tipo + (r.tipo ? ` (${r.tipo})` : ""));
  add(tr("v_creo.nome_modello"), r.nome);
  add(tr("v_creo.salvato_con"), [r.programma, r.versione, r.build].filter(Boolean).join(" "));
  add(tr("v_creo.piattaforma"), r.piattaforma);
  add(tr("v_creo.sezioni"), r.sezioni.length);
  top.append(prev, el("div", { class: "panel" }, el("h3", {}, tr("v_creo.informazioni")), dl));
  page.append(top);
  page.append(el("details", { class: "panel" }, el("summary", {}, tr("v_creo.elenco_sezioni", r.sezioni.length)),
    el("p", { class: "fx-muted", style: { fontFamily: "var(--mono)", fontSize: "12px", overflowWrap: "anywhere" } }, r.sezioni.join(" · "))));
  ctx.status(`${tipo} · ${[r.programma, r.versione].filter(Boolean).join(" ")}`);
  if (r.step?.length) ctx.tb.append(button(tr("v_creo.apri_3d"), "cube", () => ctx.openFile(r.step[0])));
  return {
    saveInPlace: false,
    saveFormats: [...(r.anteprima ? ["png"] : []), "txt", "json"],
    saveLabels: { png: tr("v_creo.anteprima_incorporata"), txt: tr("v_creo.informazioni_testo"), json: tr("v_creo.informazioni_json") },
    async save(target) { await api("fx", { op: "creo_export", path: ctx.path }, { json: { out: target } }); return { switchTo: false }; },
  };
}
