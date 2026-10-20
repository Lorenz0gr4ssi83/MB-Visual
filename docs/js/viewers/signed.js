// Documenti firmati (p7m, p7s, tsd, m7m, p7c/p7b): dati dei firmatari, verifica, documento contenuto.
import { api, button, el, loading, pickSavePath, readBytes, toast } from "../core.js";

const yes = (v, okText, badText, nullText = "Non verificabile") =>
  v === true ? el("span", { class: "chip ok" }, okText) : v === false ? el("span", { class: "chip bad" }, badText) : el("span", { class: "chip mute" }, nullText);

export function renderSigner(s, i) {
  const c = s.certificato || {};
  const box = el("div", { class: "panel", style: { display: "grid", gap: "10px" } });
  box.append(el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
    el("b", { style: { fontSize: "15px" } }, (i !== undefined ? `Firma ${i + 1}: ` : "") + (c.nome || "Firmatario sconosciuto")),
    yes(s.firma_valida, "Firma valida", "Firma NON valida"),
    yes(s.integrita, "Documento integro", "Documento ALTERATO"),
    c.scaduto ? el("span", { class: "chip warn" }, "Certificato scaduto") : c.non_ancora_valido ? el("span", { class: "chip warn" }, "Certificato non ancora valido") : el("span", { class: "chip ok" }, "Certificato nel periodo di validita'")));
  const dl = el("dl", { class: "kv" });
  const add = (k, v) => { if (v) dl.append(el("dt", {}, k), el("dd", {}, v)); };
  add("Nome", [c.nome_proprio, c.cognome].filter(Boolean).join(" ") || c.nome);
  add("Codice fiscale", c.codice_fiscale);
  add("Organizzazione", c.organizzazione);
  add("Ruolo", c.ruolo);
  add("Email", c.email);
  add("Paese", c.paese);
  add("Data della firma", s.data_firma);
  if (s.marca_temporale) add("Marca temporale", `${s.marca_temporale.data || ""}${s.marca_temporale.autorita ? " · " + s.marca_temporale.autorita : ""}`);
  add("Ente certificatore", c.emesso_da + (c.ente_certificatore && c.ente_certificatore !== c.emesso_da ? " (" + c.ente_certificatore + ")" : ""));
  add("Certificato valido", c.valido_dal && `dal ${c.valido_dal} al ${c.valido_al}`);
  add("Numero di serie", c.numero_serie);
  add("Tipo firma", s.tipo);
  add("Algoritmo", s.algoritmo);
  add("Uso della chiave", (c.usi_chiave || []).join(", "));
  if (s.errori?.length) add("Note tecniche", s.errori.join("; "));
  box.append(dl);
  return box;
}

export async function mount(ctx) {
  loading(ctx.el, "Lettura della busta di firma");
  const r = await api("signed", { path: ctx.path }, { allowFail: true });
  ctx.el.innerHTML = "";
  if (!r.ok) throw new Error(r.errore);

  const wrap = el("div", { style: { padding: "18px 22px", display: "grid", gap: "14px", maxWidth: "980px" } });
  const levels = r.livelli || [];
  const signers = levels.flatMap(l => l.firmatari || []);
  const allOk = signers.length && signers.every(s => s.firma_valida && s.integrita !== false);
  wrap.append(el("div", { style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
    el("h2", { style: { margin: 0, fontSize: "19px" } }, signers.length ? `Documento firmato digitalmente · ${signers.length} firm${signers.length > 1 ? "e" : "a"}` : "Certificati"),
    signers.length ? (allOk ? el("span", { class: "chip ok" }, "Tutte le firme sono valide") : el("span", { class: "chip bad" }, "Attenzione: verifica non superata")) : null));
  if (r.nota) wrap.append(el("p", { style: { margin: 0 } }, r.nota));

  if (r.contenuto) {
    wrap.append(el("div", { class: "panel", style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
      el("span", {}, "Documento contenuto: ", el("b", {}, r.nome_contenuto)),
      el("span", { class: "grow", style: { flex: 1 } }),
      el("button", { class: "btn primary", onclick: () => ctx.openFile(r.contenuto) }, "Apri il documento"),
      el("button", { class: "btn", onclick: async () => {
        const p = await pickSavePath(r.nome_contenuto, ctx.path.replace(/[\\/][^\\/]*$/, ""));
        if (!p) return;
        const bytes = await readBytes(r.contenuto);
        await api("save", { path: p }, { body: bytes });
        toast("Documento estratto: " + p);
      } }, "Estrai e salva")));
  } else if (signers.length) {
    wrap.append(el("p", { class: "err", style: { margin: 0 } }, "Firma separata (detached): il documento firmato non e' incluso. Mettilo nella stessa cartella con lo stesso nome senza .p7s per verificarlo."));
  }

  let n = 0;
  for (const l of levels) {
    if (levels.length > 1) wrap.append(el("div", { class: "chip mute", style: { justifySelf: "start" } }, l.tipo_busta + (l.marca_temporale ? " · marca temporale " + (l.marca_temporale.data || "") : "")));
    for (const s of l.firmatari || []) wrap.append(renderSigner(s, n++));
  }
  for (const c of r.certificati || []) wrap.append(renderSigner({ certificato: c, firma_valida: null, integrita: null }));
  wrap.append(el("p", { style: { color: "var(--muted)", fontSize: "12.5px", margin: 0 } }, r.avviso));
  ctx.el.append(wrap);

  ctx.tb.append(r.contenuto ? button("Apri il documento contenuto", "open", () => ctx.openFile(r.contenuto)) : el("span"),
    el("span", { class: "grow" }), el("span", { class: "note" }, "Il documento contenuto si modifica nel suo editor e si salva come nuovo file (la firma non resta valida sul file modificato)."));
  // apertura automatica del contenuto in una scheda accanto
  if (r.contenuto) setTimeout(() => ctx.openFile(r.contenuto), 50);
  return {};
}
