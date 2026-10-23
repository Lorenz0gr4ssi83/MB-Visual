// Licenza dell'app per PC (mbvisual/license.py): schermata di attivazione e finestra File -> Account.
// La schermata copre l'app finche' la licenza non e' attiva; compare all'avvio e ogni volta che il motore rifiuta
// una richiesta per licenza non attiva (evento "mbv-licenza" da core.js).
import { t as tr, LOCALE } from "./i18n.js";
import { api, el, modal, toast, WEB } from "./core.js";

const STATI = {
  da_attivare: tr("license.inserisci_chiave_licenza_ricevuta_attivare"),
  sostituita: tr("license.chiave_usata_questo_pc_stata"),
  revocata: tr("license.licenza_stata_revocata_contatta_mb"),
  scaduta: tr("license.licenza_scaduta_contatta_mb_engineering"),
  dispositivo_revocato: tr("license.questo_pc_non_piu_attivo"),
  offline_scaduta: tr("license.sono_passati_piu_30_giorni"),
};
const fmtKey = v => { const s = v.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^MBV/, "").slice(0, 20); return s ? "MBV-" + s.replace(/(.{5})(?=.)/g, "$1-") : ""; };

// sul PC si passa dal motore dell'app (mbvisual/license.py); sul cellulare (app servita dal server delle licenze)
// si parla direttamente con il server, con l'attivazione nel cookie
const MOBILE = () => WEB && window.MBV_MOBILE;
async function remote(kind, body = {}) {
  if (!MOBILE()) return api("license/" + kind, {}, kind === "account" ? {} : { json: body });
  const r = await fetch("/v1/" + kind, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({ ok: false, errore: tr("license.server_non_raggiungibile") }));
  if (d.ok === false) throw new Error(d.errore || tr("license.errore"));
  return d;
}
const toActivation = reason => location.replace("/attiva" + (reason ? "?motivo=" + encodeURIComponent(reason) : ""));

let shown = null;
export async function licenseGate() {
  if (WEB) return true;
  let st;
  try { st = await api("license/status", {}, { allowFail: true }); } catch { return true; }
  if (st.attiva) { hideGate(); return true; }
  showGate(st);
  return false;
}
window.addEventListener("mbv-licenza", () => { if (!shown) licenseGate(); });

function hideGate() { shown?.remove(); shown = null; }

function showGate(st) {
  hideGate();
  const msg = el("p", { style: { margin: "0 0 14px", color: "var(--muted)" } }, st.errore || STATI[st.stato] || STATI.da_attivare);
  const input = el("input", { type: "text", class: "field", placeholder: "MBV-XXXXX-XXXXX-XXXXX-XXXXX", spellcheck: "false", autocomplete: "off",
    style: { width: "100%", fontFamily: "Consolas, monospace", fontSize: "16px", letterSpacing: ".04em", padding: "10px 12px", textAlign: "center" } });
  input.addEventListener("input", () => { const p = input.selectionStart, before = input.value.length; input.value = fmtKey(input.value); input.selectionEnd = p + (input.value.length - before); });
  const err = el("p", { style: { color: "var(--bad)", minHeight: "1.2em", margin: "10px 0 0" } });
  const extra = el("div", { style: { marginTop: "10px" } });
  const go = el("button", { class: "btn primary", style: { height: "38px", padding: "0 22px", fontSize: "14px" } }, tr("license.attiva"));
  const activate = async () => {
    if (input.value.replace(/[^A-Z0-9]/g, "").length < 23) { err.textContent = tr("license.chiave_incompleta"); return; }
    go.disabled = true; err.textContent = ""; extra.innerHTML = "";
    try {
      const r = await api("license/activate", {}, { json: { key: input.value }, allowFail: true });
      if (r.attiva) { hideGate(); toast(tr("license.licenza_attivata_0", r.cliente ? " · " + r.cliente : "")); window.dispatchEvent(new CustomEvent("mbv-licenza-ok")); return; }
      err.textContent = r.errore || tr("license.attivazione_non_riuscita");
      if (r.stato === "limite") {
        // licenza occupata da un altro PC (cambio PC, PC perso o rotto): cambio dispositivo con la sola chiave
        extra.append(el("p", { class: "note", style: { margin: "0 0 8px" } }, r.suggerimento || ""),
          el("button", { class: "btn", onclick: () => changeWithKey(input.value) }, tr("license.cambio_dispositivo")));
      }
    } catch (e) { err.textContent = e.message; } finally { go.disabled = false; }
  };
  go.addEventListener("click", activate);
  input.addEventListener("keydown", e => { if (e.key === "Enter") activate(); });
  const box = el("div", { style: { width: "min(520px, 92vw)", background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: "12px", padding: "28px 30px", boxShadow: "var(--shadow)", textAlign: "center" } },
    el("img", { src: "img/logo-512.png", alt: "MB Visual", style: { width: "96px", height: "96px", marginBottom: "10px" } }),
    el("h2", { style: { margin: "0 0 8px", fontFamily: "var(--display)" } }, tr("license.attivazione_mb_visual")), msg, input, err,
    el("div", { style: { marginTop: "14px" } }, go), extra,
    el("p", { class: "note", style: { marginTop: "18px", fontSize: "12px" } }, tr("license.licenza_vale_1_pc_2")));
  shown = el("div", { id: "license-gate", style: { position: "fixed", inset: 0, zIndex: 90, display: "grid", placeItems: "center", background: "var(--bg)" } }, box);
  document.body.append(shown);
  setTimeout(() => input.focus(), 50);
}

async function changeWithKey(key) {
  const ta = el("textarea", { rows: 3, class: "field", style: { width: "100%" }, placeholder: tr("license.motivo_es_pc_nuovo_pc") });
  const ok = await modal(tr("license.cambio_dispositivo_2"), el("div", { style: { display: "grid", gap: "8px", minWidth: "360px" } },
    el("p", { style: { margin: 0 } }, tr("license.viene_generata_chiave_nuova_chiave")),
    el("p", { class: "note", style: { margin: 0 } }, tr("license.dovrai_inserire_chiave_nuova_anche")), ta),
    [{ label: tr("common.annulla"), value: false }, { label: tr("license.genera_chiave_nuova"), value: true, primary: true }]);
  if (!ok) return;
  try {
    const r = await api("license/request", {}, { json: { type: "change", message: ta.value, key } });
    await showNewKey(r);
  } catch (e) { toast(e.message, true, 8000); }
}

async function showNewKey(r) {
  if (r.in_attesa) return modal(tr("license.richiesta_inviata"), el("p", {}, r.messaggio));
  const k = el("div", { style: { fontFamily: "Consolas, monospace", fontSize: "20px", letterSpacing: ".05em", padding: "12px", background: "var(--panel)", border: "1px dashed var(--accent)", borderRadius: "8px", textAlign: "center", userSelect: "all" } }, r.nuova_chiave);
  const v = await modal(tr("license.nuova_chiave_licenza"), el("div", { style: { display: "grid", gap: "10px", minWidth: "380px" } },
    el("p", { style: { margin: 0 } }, r.messaggio || ""), k, el("p", { class: "note", style: { margin: 0 } }, tr("license.annotala_serve_ogni_dispositivo_che", MOBILE() ? tr("license.cellulare_min") : "PC"))),
    [{ label: tr("common.copia"), value: "copy" }, { label: MOBILE() ? tr("license.usala_questo_cellulare") : tr("license.usala_questo_pc"), value: "use", primary: true }, { label: tr("common.chiudi"), value: false }]);
  if (v === "copy") { await navigator.clipboard?.writeText(r.nuova_chiave); toast(tr("license.chiave_copiata")); return showNewKey(r); }
  if (MOBILE()) return toActivation(v === "use" ? tr("license.inserisci_chiave_nuova") + r.nuova_chiave : tr("license.chiave_stata_sostituita_inserisci_chiave"));
  if (v === "use") {
    const a = await api("license/activate", {}, { json: { key: r.nuova_chiave }, allowFail: true });
    if (a.attiva) { hideGate(); toast(tr("license.questo_pc_usa_chiave_nuova")); } else toast(a.errore || tr("license.attivazione_non_riuscita"), true, 8000);
    return;
  }
  licenseGate(); // senza la chiave nuova questo PC resta bloccato
}

// ---- File -> Account
export async function showAccount() {
  let a;
  try { a = await remote("account"); } catch (e) { toast(tr("license.account_non_disponibile") + e.message, true, 7000); return MOBILE() ? null : licenseGate(); }
  const fmtD = s => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleString(LOCALE, { dateStyle: "short", timeStyle: "short" }) : "");
  const devRow = d => el("tr", {}, el("td", {}, d.kind === "pc" ? "PC" : tr("license.cellulare")), el("td", {}, d.name || "-", d.questo ? el("b", {}, tr("license.questo")) : ""), el("td", {}, fmtD(d.activated)), el("td", {}, fmtD(d.last_seen)));
  const pcs = a.dispositivi.filter(d => d.kind === "pc").length, tels = a.dispositivi.filter(d => d.kind === "mobile").length;
  const stato = { open: tr("license.aperta"), pending: tr("license.attesa_approvazione"), done: tr("license.completata"), closed: tr("license.chiusa") };
  const content = el("div", { style: { display: "grid", gap: "12px", minWidth: "520px", maxWidth: "640px" } },
    el("dl", { class: "kv" }, el("dt", {}, tr("license.intestatario")), el("dd", {}, a.cliente || "-"), el("dt", {}, tr("license.chiave")), el("dd", { style: { fontFamily: "Consolas, monospace" } }, a.chiave),
      el("dt", {}, tr("license.dispositivi")), el("dd", {}, tr("license.pc_0_1_cellulari_2", pcs, a.pc, tels, a.cellulari)),
      el("dt", {}, tr("license.cambi_dispositivo")), el("dd", {}, tr("license.0_automatici_rimasti_quest_anno", a.cambi_rimasti)), a.scadenza ? [el("dt", {}, tr("license.scadenza")), el("dd", {}, fmtD(a.scadenza))] : null),
    el("table", { class: "grid-table", style: { width: "100%", fontSize: "12.5px" } }, el("thead", {}, el("tr", {}, ...[tr("license.tipo"), tr("common.nome"), tr("license.attivato"), tr("license.ultimo_uso")].map(t => el("th", { style: { textAlign: "left" } }, t)))), el("tbody", {}, ...a.dispositivi.map(devRow))),
    a.richieste.length ? el("details", {}, el("summary", {}, tr("license.richieste_segnalazioni_0", a.richieste.length)),
      el("ul", { style: { margin: "6px 0 0", paddingLeft: "18px", fontSize: "12.5px" } }, ...a.richieste.map(r => el("li", {}, `${fmtD(r.created)} · ${r.type === "change" ? tr("license.cambio_dispositivo_2") : tr("license.segnalazione")} · ${stato[r.status] || r.status}${r.message ? " · " + r.message : ""}`)))) : null);
  const v = await modal(tr("license.account_licenza"), content, [{ label: tr("license.segnalazione_2"), value: "report" }, { label: tr("license.cambio_pc_cellulare"), value: "change" }, { label: tr("license.inserisci_nuova_chiave"), value: "key" }, { label: tr("common.chiudi"), value: false, primary: true }]);
  if (v === "report") return report();
  if (v === "change") return changeFromAccount();
  if (v === "key") return MOBILE() ? toActivation(tr("license.inserisci_chiave_nuova_2")) : showGate({ stato: "da_attivare" });
}

// app per telefono (ui/js/phone.js): dati e comandi dell'account mostrati nella scheda Account
export const accountInfo = () => remote("account");
export const licenseReport = () => report();
export const licenseChange = () => changeFromAccount();
export const licenseNewKey = () => (MOBILE() ? toActivation(tr("license.inserisci_chiave_nuova_2")) : showGate({ stato: "da_attivare" }));

async function report() {
  const ta = el("textarea", { rows: 6, class: "field", style: { width: "100%" }, placeholder: tr("license.descrivi_problema_richiesta") });
  if (!(await modal(tr("license.segnalazione"), el("div", { style: { minWidth: "420px" } }, ta), [{ label: tr("common.annulla"), value: false }, { label: tr("license.invia"), value: true, primary: true }]))) return;
  if (!ta.value.trim()) return toast(tr("license.scrivi_testo_segnalazione"), true);
  try { const r = await remote("request", { type: "report", message: ta.value }); toast(r.messaggio || tr("license.segnalazione_inviata")); } catch (e) { toast(e.message, true, 7000); }
}

async function changeFromAccount() {
  const ta = el("textarea", { rows: 3, class: "field", style: { width: "100%" }, placeholder: tr("license.quale_dispositivo_cambi_perche_es") });
  const ok = await modal(tr("license.cambio_pc_cellulare_2"), el("div", { style: { display: "grid", gap: "8px", minWidth: "400px" } },
    el("p", { style: { margin: 0 } }, tr("license.viene_generata_chiave_nuova_quella", MOBILE() ? tr("license.cellulare_min") : "PC")),
    el("p", { class: "note", style: { margin: 0 } }, tr("license.inserisci_poi_chiave_nuova_sui")), ta),
    [{ label: tr("common.annulla"), value: false }, { label: tr("license.genera_chiave_nuova"), value: true, primary: true }]);
  if (!ok) return;
  try { await showNewKey(await remote("request", { type: "change", message: ta.value })); } catch (e) { toast(e.message, true, 8000); }
}
