// Tavole (.idw) e presentazioni (.ipn) di Autodesk Inventor senza Inventor: anteprima salvata nel file,
// iProperties ed elenco dei modelli collegati (parti e assiemi si aprono nel visualizzatore 3D).
import { api, el, fileUrl, fmtSize, loading, toast, waitJob } from "../core.js";

export async function mount(ctx) {
  const ld = loading(ctx.el, "Lettura del file Inventor");
  let res;
  try {
    const { job } = await api("inventor", { path: ctx.path });
    res = await waitJob(job, (p, m) => ld.set(p, m || "Lettura del file Inventor"));
  } finally { ld.done?.(); }
  ctx.el.innerHTML = "";
  const kind = res.tipo === "presentazione" ? "Presentazione Inventor" : "Tavola Inventor";
  const box = el("div", { style: { padding: "22px 28px", display: "grid", gap: "16px", maxWidth: "1100px" } });
  box.append(el("div", {},
    el("h2", { style: { margin: "0 0 6px", fontSize: "20px", fontFamily: "var(--display)", fontWeight: 600 } }, `${kind}: ${res.nome}`),
    el("p", { style: { margin: 0, color: "var(--muted)", maxWidth: "95ch" } },
      res.tipo === "presentazione"
        ? "Le viste esplose e le animazioni restano nel formato di Inventor; MB Visual mostra l'anteprima salvata nel file, le proprieta' e i modelli collegati, che si aprono in 3D senza Inventor."
        : "Le viste della tavola sono calcolate da Inventor al momento dell'apertura; MB Visual mostra l'anteprima salvata nel file, le proprieta' e i modelli collegati, che si aprono in 3D senza Inventor.")));
  const row = el("div", { style: { display: "flex", gap: "18px", flexWrap: "wrap", alignItems: "flex-start" } });
  if (res.anteprima) {
    row.append(el("figure", { class: "panel", style: { margin: 0, padding: "10px", background: "#fff" } },
      el("img", { src: fileUrl(res.anteprima), alt: "Anteprima", style: { display: "block", maxWidth: "min(520px, 100%)", imageRendering: "auto" } }),
      el("figcaption", { style: { color: "#555", fontSize: "12px", marginTop: "6px" } }, "Anteprima salvata da Inventor")));
  } else {
    row.append(el("div", { class: "panel", style: { padding: "18px", color: "var(--muted)" } }, "Il file non contiene un'anteprima."));
  }
  const props = el("div", { style: { flex: "1 1 320px", display: "grid", gap: "10px" } });
  for (const g of res.gruppi || []) {
    const dl = el("dl", { class: "kv stack" });
    for (const [k, v] of g.voci) dl.append(el("dt", {}, k), el("dd", {}, v));
    props.append(el("details", { open: true, class: "panel" }, el("summary", {}, g.nome), dl));
  }
  if (!res.gruppi?.length) props.append(el("p", { class: "note" }, "Nessuna proprieta' compilata."));
  row.append(props);
  box.append(row);

  const refs = res.riferimenti || [];
  const sec = el("section", { class: "panel", style: { display: "grid", gap: "6px" } }, el("b", {}, `Modelli collegati (${refs.length})`));
  if (!refs.length) sec.append(el("p", { class: "note", style: { margin: 0 } }, "Nessun modello collegato trovato nel file."));
  for (const r of refs) {
    const name = r.originale.split(/[\\/]/).pop();
    sec.append(el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
      el("span", { style: { flex: 1, overflowWrap: "anywhere" }, title: r.originale }, name),
      r.file ? el("button", { class: "btn", onclick: () => ctx.openFile(r.file) }, "Apri in 3D")
        : el("span", { class: "chip warn", title: r.originale }, "File non trovato")));
  }
  box.append(sec);
  box.append(el("dl", { class: "kv panel" }, el("dt", {}, "File"), el("dd", {}, ctx.name), el("dt", {}, "Dimensione"), el("dd", {}, fmtSize(ctx.info.size)),
    el("dt", {}, "Cartella"), el("dd", {}, ctx.info.cartella)));
  ctx.el.append(box);
  ctx.tb.append(el("button", { class: "btn", onclick: () => ctx.openAs("hex") }, "Vedi byte grezzi"));
  if (refs.some(r => !r.file)) toast("Alcuni modelli collegati non sono nella cartella della tavola", true, 6000);
  return {};
}
