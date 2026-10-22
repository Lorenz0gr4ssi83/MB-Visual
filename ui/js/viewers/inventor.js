// Tavole (.idw) e presentazioni (.ipn) di Autodesk Inventor senza Inventor: anteprima salvata nel file,
// iProperties ed elenco dei modelli collegati (parti e assiemi si aprono nel visualizzatore 3D).
import { api, el, fileUrl, fmtSize, loading, toast, waitJob } from "../core.js";
import { t } from "../i18n.js";

export async function mount(ctx) {
  const ld = loading(ctx.el, t("v_inventor.lettura_file_inventor"));
  let res;
  try {
    const { job } = await api("inventor", { path: ctx.path });
    res = await waitJob(job, (p, m) => ld.set(p, m || t("v_inventor.lettura_file_inventor")));
  } finally { ld.done?.(); }
  ctx.el.innerHTML = "";
  const kind = res.tipo === "presentazione" ? t("v_inventor.presentazione_inventor") : t("v_inventor.tavola_inventor");
  const box = el("div", { style: { padding: "22px 28px", display: "grid", gap: "16px", maxWidth: "1100px" } });
  box.append(el("div", {},
    el("h2", { style: { margin: "0 0 6px", fontSize: "20px", fontFamily: "var(--display)", fontWeight: 600 } }, `${kind}: ${res.nome}`),
    el("p", { style: { margin: 0, color: "var(--muted)", maxWidth: "95ch" } },
      res.tipo === "presentazione"
        ? t("v_inventor.viste_esplose_animazioni_restano_formato")
        : t("v_inventor.viste_tavola_sono_calcolate_inventor"))));
  const row = el("div", { style: { display: "flex", gap: "18px", flexWrap: "wrap", alignItems: "flex-start" } });
  if (res.anteprima) {
    row.append(el("figure", { class: "panel", style: { margin: 0, padding: "10px", background: "#fff" } },
      el("img", { src: fileUrl(res.anteprima), alt: t("v_inventor.anteprima"), style: { display: "block", maxWidth: "min(520px, 100%)", imageRendering: "auto" } }),
      el("figcaption", { style: { color: "#555", fontSize: "12px", marginTop: "6px" } }, t("v_inventor.anteprima_salvata_inventor"))));
  } else {
    row.append(el("div", { class: "panel", style: { padding: "18px", color: "var(--muted)" } }, t("v_inventor.file_non_contiene_anteprima")));
  }
  const props = el("div", { style: { flex: "1 1 320px", display: "grid", gap: "10px" } });
  for (const g of res.gruppi || []) {
    const dl = el("dl", { class: "kv stack" });
    for (const [k, v] of g.voci) dl.append(el("dt", {}, k), el("dd", {}, v));
    props.append(el("details", { open: true, class: "panel" }, el("summary", {}, g.nome), dl));
  }
  if (!res.gruppi?.length) props.append(el("p", { class: "note" }, t("v_inventor.nessuna_proprieta_compilata")));
  row.append(props);
  box.append(row);

  const refs = res.riferimenti || [];
  const sec = el("section", { class: "panel", style: { display: "grid", gap: "6px" } }, el("b", {}, t("v_inventor.modelli_collegati_0", refs.length)));
  if (!refs.length) sec.append(el("p", { class: "note", style: { margin: 0 } }, t("v_inventor.nessun_modello_collegato_trovato_file")));
  for (const r of refs) {
    const name = r.originale.split(/[\\/]/).pop();
    sec.append(el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
      el("span", { style: { flex: 1, overflowWrap: "anywhere" }, title: r.originale }, name),
      r.file ? el("button", { class: "btn", onclick: () => ctx.openFile(r.file) }, t("v_inventor.apri_3d"))
        : el("span", { class: "chip warn", title: r.originale }, t("v_inventor.file_non_trovato"))));
  }
  box.append(sec);
  box.append(el("dl", { class: "kv panel" }, el("dt", {}, t("v_inventor.file")), el("dd", {}, ctx.name), el("dt", {}, t("v_inventor.dimensione")), el("dd", {}, fmtSize(ctx.info.size)),
    el("dt", {}, t("v_inventor.cartella")), el("dd", {}, ctx.info.cartella)));
  ctx.el.append(box);
  ctx.tb.append(el("button", { class: "btn", onclick: () => ctx.openAs("hex") }, t("v_inventor.vedi_byte_grezzi")));
  if (refs.some(r => !r.file)) toast(t("v_inventor.alcuni_modelli_collegati_non_sono"), true, 6000);
  return {};
}
