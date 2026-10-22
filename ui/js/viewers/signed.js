// Documenti firmati (p7m, p7s, tsd, m7m, p7c/p7b): dati dei firmatari, verifica, documento contenuto.
import { api, button, el, loading, pickSavePath, readBytes, toast, WEB } from "../core.js";
import { t, tn } from "../i18n.js";

const yes = (v, okText, badText, nullText = t("v_signed.non_verificabile")) =>
  v === true ? el("span", { class: "chip ok" }, okText) : v === false ? el("span", { class: "chip bad" }, badText) : el("span", { class: "chip mute" }, nullText);

export function renderSigner(s, i) {
  const c = s.certificato || {};
  const box = el("div", { class: "panel", style: { display: "grid", gap: "10px" } });
  box.append(el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
    el("b", { style: { fontSize: "15px" } }, (i !== undefined ? t("v_signed.firma_0", i + 1) : "") + (c.nome || t("v_signed.firmatario_sconosciuto"))),
    yes(s.firma_valida, t("v_signed.firma_valida"), t("v_signed.firma_non_valida")),
    yes(s.integrita, t("v_signed.documento_integro"), t("v_signed.documento_alterato")),
    c.scaduto ? el("span", { class: "chip warn" }, t("v_signed.certificato_scaduto")) : c.non_ancora_valido ? el("span", { class: "chip warn" }, t("v_signed.certificato_non_ancora_valido")) : el("span", { class: "chip ok" }, t("v_signed.certificato_periodo_validita"))));
  const dl = el("dl", { class: "kv" });
  const add = (k, v) => { if (v) dl.append(el("dt", {}, k), el("dd", {}, v)); };
  add(t("common.nome"), [c.nome_proprio, c.cognome].filter(Boolean).join(" ") || c.nome);
  add(t("v_signed.codice_fiscale"), c.codice_fiscale);
  add(t("v_signed.organizzazione"), c.organizzazione);
  add(t("v_signed.ruolo"), c.ruolo);
  add(t("v_signed.email"), c.email);
  add(t("v_signed.paese"), c.paese);
  add(t("v_signed.data_firma"), s.data_firma);
  if (s.marca_temporale) add(t("v_signed.marca_temporale"), `${s.marca_temporale.data || ""}${s.marca_temporale.autorita ? " · " + s.marca_temporale.autorita : ""}`);
  add(t("v_signed.ente_certificatore"), c.emesso_da + (c.ente_certificatore && c.ente_certificatore !== c.emesso_da ? " (" + c.ente_certificatore + ")" : ""));
  add(t("v_signed.certificato_valido"), c.valido_dal && t("v_signed.0_1", c.valido_dal, c.valido_al));
  add(t("v_signed.numero_serie"), c.numero_serie);
  add(t("v_signed.tipo_firma"), s.tipo);
  add(t("v_signed.algoritmo"), s.algoritmo);
  add(t("v_signed.uso_chiave"), (c.usi_chiave || []).join(", "));
  if (s.errori?.length) add(t("v_signed.note_tecniche"), s.errori.join("; "));
  box.append(dl);
  return box;
}

export async function mount(ctx) {
  loading(ctx.el, t("v_signed.lettura_busta_firma"));
  const r = await api("signed", { path: ctx.path }, { allowFail: true });
  ctx.el.innerHTML = "";
  if (!r.ok) throw new Error(r.errore);

  const wrap = el("div", { style: { padding: "18px 22px", display: "grid", gap: "14px", maxWidth: "980px" } });
  const levels = r.livelli || [];
  const signers = levels.flatMap(l => l.firmatari || []);
  const allOk = signers.length && signers.every(s => s.firma_valida && s.integrita !== false);
  wrap.append(el("div", { style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
    el("h2", { style: { margin: 0, fontSize: "19px" } }, signers.length ? t("v_signed.documento_firmato") + " · " + tn("v_signed.n_firme", signers.length) : t("v_signed.certificati")),
    signers.length ? (allOk ? el("span", { class: "chip ok" }, t("v_signed.tutte_firme_sono_valide")) : el("span", { class: "chip bad" }, t("v_signed.attenzione_verifica_non_superata"))) : null));
  if (r.nota) wrap.append(el("p", { style: { margin: 0 } }, r.nota));

  if (r.contenuto) {
    wrap.append(el("div", { class: "panel", style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
      el("span", {}, t("v_signed.documento_contenuto"), el("b", {}, r.nome_contenuto)),
      el("span", { class: "grow", style: { flex: 1 } }),
      el("button", { class: "btn primary", onclick: () => ctx.openFile(r.contenuto) }, t("v_signed.apri_documento")),
      el("button", { class: "btn", onclick: async () => {
        const p = await pickSavePath(r.nome_contenuto, ctx.path.replace(/[\\/][^\\/]*$/, ""));
        if (!p) return;
        const bytes = await readBytes(r.contenuto);
        await api("save", { path: p }, { body: bytes });
        toast(t("v_signed.documento_estratto") + p);
      } }, t("v_signed.estrai_salva"))));
  } else if (signers.length) {
    wrap.append(el("p", { class: "err", style: { margin: 0 } }, t("v_signed.firma_separata_detached_documento_firmato")));
  }

  let n = 0;
  for (const l of levels) {
    if (levels.length > 1) wrap.append(el("div", { class: "chip mute", style: { justifySelf: "start" } }, l.tipo_busta + (l.marca_temporale ? t("v_signed.marca_temporale_2") + (l.marca_temporale.data || "") : "")));
    for (const s of l.firmatari || []) wrap.append(renderSigner(s, n++));
  }
  for (const c of r.certificati || []) wrap.append(renderSigner({ certificato: c, firma_valida: null, integrita: null }));
  wrap.append(el("p", { style: { color: "var(--muted)", fontSize: "12.5px", margin: 0 } }, r.avviso));
  ctx.el.append(wrap);

  if (!WEB && signers.length && r.contenuto) ctx.tb.append(button(t("v_signed.aggiungi_firma"), "sign", () => import("../firma.js").then(m => m.signDialog({ path: ctx.path, openFile: ctx.openFile })), { title: t("v_signed.firma_parallela_controfirma_smart_card") }));
  ctx.tb.append(r.contenuto ? button(t("v_signed.apri_documento_contenuto"), "open", () => ctx.openFile(r.contenuto)) : el("span"),
    el("span", { class: "grow" }), el("span", { class: "note" }, t("v_signed.documento_contenuto_si_modifica_suo")));
  // apertura automatica del contenuto in una scheda accanto
  if (r.contenuto) setTimeout(() => ctx.openFile(r.contenuto), 50);
  return {};
}
