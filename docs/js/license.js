// Licenza dell'app per PC (mbvisual/license.py): schermata di attivazione e finestra File -> Account.
// La schermata copre l'app finche' la licenza non e' attiva; compare all'avvio e ogni volta che il motore rifiuta
// una richiesta per licenza non attiva (evento "mbv-licenza" da core.js).
import { api, el, modal, toast, WEB } from "./core.js";

const STATI = {
  da_attivare: "Inserisci la chiave di licenza ricevuta per attivare MB Visual su questo PC.",
  sostituita: "La chiave usata su questo PC e' stata sostituita da un cambio dispositivo. Inserisci la chiave nuova.",
  revocata: "La licenza e' stata revocata. Contatta MB Engineering.",
  scaduta: "La licenza e' scaduta. Contatta MB Engineering.",
  dispositivo_revocato: "Questo PC non e' piu' attivo sulla licenza. Inserisci di nuovo la chiave o contatta MB Engineering.",
  offline_scaduta: "Sono passati piu' di 30 giorni senza collegamento a internet: collegati per rinnovare la licenza.",
};
const fmtKey = v => { const s = v.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^MBV/, "").slice(0, 20); return s ? "MBV-" + s.replace(/(.{5})(?=.)/g, "$1-") : ""; };

// sul PC si passa dal motore dell'app (mbvisual/license.py); sul cellulare (app servita dal server delle licenze)
// si parla direttamente con il server, con l'attivazione nel cookie
const MOBILE = () => WEB && window.MBV_MOBILE;
async function remote(kind, body = {}) {
  if (!MOBILE()) return api("license/" + kind, {}, kind === "account" ? {} : { json: body });
  const r = await fetch("/v1/" + kind, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({ ok: false, errore: "Server non raggiungibile" }));
  if (d.ok === false) throw new Error(d.errore || "Errore");
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
  const go = el("button", { class: "btn primary", style: { height: "38px", padding: "0 22px", fontSize: "14px" } }, "Attiva");
  const activate = async () => {
    if (input.value.replace(/[^A-Z0-9]/g, "").length < 23) { err.textContent = "Chiave incompleta"; return; }
    go.disabled = true; err.textContent = ""; extra.innerHTML = "";
    try {
      const r = await api("license/activate", {}, { json: { key: input.value }, allowFail: true });
      if (r.attiva) { hideGate(); toast(`Licenza attivata${r.cliente ? " · " + r.cliente : ""}`); window.dispatchEvent(new CustomEvent("mbv-licenza-ok")); return; }
      err.textContent = r.errore || "Attivazione non riuscita";
      if (r.stato === "limite") {
        // licenza occupata da un altro PC (cambio PC, PC perso o rotto): cambio dispositivo con la sola chiave
        extra.append(el("p", { class: "note", style: { margin: "0 0 8px" } }, r.suggerimento || ""),
          el("button", { class: "btn", onclick: () => changeWithKey(input.value) }, "Cambio dispositivo..."));
      }
    } catch (e) { err.textContent = e.message; } finally { go.disabled = false; }
  };
  go.addEventListener("click", activate);
  input.addEventListener("keydown", e => { if (e.key === "Enter") activate(); });
  const box = el("div", { style: { width: "min(520px, 92vw)", background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: "12px", padding: "28px 30px", boxShadow: "var(--shadow)", textAlign: "center" } },
    el("img", { src: "img/logo-512.png", alt: "MB Visual", style: { width: "96px", height: "96px", marginBottom: "10px" } }),
    el("h2", { style: { margin: "0 0 8px", fontFamily: "var(--display)" } }, "Attivazione di MB Visual"), msg, input, err,
    el("div", { style: { marginTop: "14px" } }, go), extra,
    el("p", { class: "note", style: { marginTop: "18px", fontSize: "12px" } }, "Una licenza vale per 1 PC e 2 cellulari. Serve internet per l'attivazione; poi l'app funziona anche offline fino a 30 giorni."));
  shown = el("div", { id: "license-gate", style: { position: "fixed", inset: 0, zIndex: 90, display: "grid", placeItems: "center", background: "var(--bg)" } }, box);
  document.body.append(shown);
  setTimeout(() => input.focus(), 50);
}

async function changeWithKey(key) {
  const ta = el("textarea", { rows: 3, class: "field", style: { width: "100%" }, placeholder: "Motivo (es. PC nuovo, PC guasto)" });
  const ok = await modal("Cambio dispositivo", el("div", { style: { display: "grid", gap: "8px", minWidth: "360px" } },
    el("p", { style: { margin: 0 } }, "Viene generata una chiave nuova: la chiave attuale smette di funzionare su tutti i PC e cellulari che la usano."),
    el("p", { class: "note", style: { margin: 0 } }, "Dovrai inserire la chiave nuova anche sui dispositivi che continui a usare."), ta),
    [{ label: "Annulla", value: false }, { label: "Genera chiave nuova", value: true, primary: true }]);
  if (!ok) return;
  try {
    const r = await api("license/request", {}, { json: { type: "change", message: ta.value, key } });
    await showNewKey(r);
  } catch (e) { toast(e.message, true, 8000); }
}

async function showNewKey(r) {
  if (r.in_attesa) return modal("Richiesta inviata", el("p", {}, r.messaggio));
  const k = el("div", { style: { fontFamily: "Consolas, monospace", fontSize: "20px", letterSpacing: ".05em", padding: "12px", background: "var(--panel)", border: "1px dashed var(--accent)", borderRadius: "8px", textAlign: "center", userSelect: "all" } }, r.nuova_chiave);
  const v = await modal("Nuova chiave di licenza", el("div", { style: { display: "grid", gap: "10px", minWidth: "380px" } },
    el("p", { style: { margin: 0 } }, r.messaggio || ""), k, el("p", { class: "note", style: { margin: 0 } }, `Annotala: serve su ogni dispositivo che continui a usare (questo ${MOBILE() ? "cellulare" : "PC"} compreso).`)),
    [{ label: "Copia", value: "copy" }, { label: MOBILE() ? "Usala su questo cellulare" : "Usala su questo PC", value: "use", primary: true }, { label: "Chiudi", value: false }]);
  if (v === "copy") { await navigator.clipboard?.writeText(r.nuova_chiave); toast("Chiave copiata"); return showNewKey(r); }
  if (MOBILE()) return toActivation(v === "use" ? "Inserisci la chiave nuova: " + r.nuova_chiave : "La chiave e' stata sostituita: inserisci la chiave nuova.");
  if (v === "use") {
    const a = await api("license/activate", {}, { json: { key: r.nuova_chiave }, allowFail: true });
    if (a.attiva) { hideGate(); toast("Questo PC usa la chiave nuova"); } else toast(a.errore || "Attivazione non riuscita", true, 8000);
    return;
  }
  licenseGate(); // senza la chiave nuova questo PC resta bloccato
}

// ---- File -> Account
export async function showAccount() {
  let a;
  try { a = await remote("account"); } catch (e) { toast("Account non disponibile: " + e.message, true, 7000); return MOBILE() ? null : licenseGate(); }
  const fmtD = s => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "");
  const devRow = d => el("tr", {}, el("td", {}, d.kind === "pc" ? "PC" : "Cellulare"), el("td", {}, d.name || "-", d.questo ? el("b", {}, " (questo)") : ""), el("td", {}, fmtD(d.activated)), el("td", {}, fmtD(d.last_seen)));
  const pcs = a.dispositivi.filter(d => d.kind === "pc").length, tels = a.dispositivi.filter(d => d.kind === "mobile").length;
  const stato = { open: "aperta", pending: "in attesa di approvazione", done: "completata", closed: "chiusa" };
  const content = el("div", { style: { display: "grid", gap: "12px", minWidth: "520px", maxWidth: "640px" } },
    el("dl", { class: "kv" }, el("dt", {}, "Intestatario"), el("dd", {}, a.cliente || "-"), el("dt", {}, "Chiave"), el("dd", { style: { fontFamily: "Consolas, monospace" } }, a.chiave),
      el("dt", {}, "Dispositivi"), el("dd", {}, `PC ${pcs} di ${a.pc} · cellulari ${tels} di ${a.cellulari}`),
      el("dt", {}, "Cambi dispositivo"), el("dd", {}, `${a.cambi_rimasti} automatici rimasti quest'anno`), a.scadenza ? [el("dt", {}, "Scadenza"), el("dd", {}, fmtD(a.scadenza))] : null),
    el("table", { class: "grid-table", style: { width: "100%", fontSize: "12.5px" } }, el("thead", {}, el("tr", {}, ...["Tipo", "Nome", "Attivato", "Ultimo uso"].map(t => el("th", { style: { textAlign: "left" } }, t)))), el("tbody", {}, ...a.dispositivi.map(devRow))),
    a.richieste.length ? el("details", {}, el("summary", {}, `Richieste e segnalazioni (${a.richieste.length})`),
      el("ul", { style: { margin: "6px 0 0", paddingLeft: "18px", fontSize: "12.5px" } }, ...a.richieste.map(r => el("li", {}, `${fmtD(r.created)} · ${r.type === "change" ? "Cambio dispositivo" : "Segnalazione"} · ${stato[r.status] || r.status}${r.message ? " · " + r.message : ""}`)))) : null);
  const v = await modal("Account e licenza", content, [{ label: "Segnalazione...", value: "report" }, { label: "Cambio PC / cellulare...", value: "change" }, { label: "Inserisci nuova chiave...", value: "key" }, { label: "Chiudi", value: false, primary: true }]);
  if (v === "report") return report();
  if (v === "change") return changeFromAccount();
  if (v === "key") return MOBILE() ? toActivation("Inserisci la chiave nuova.") : showGate({ stato: "da_attivare" });
}

async function report() {
  const ta = el("textarea", { rows: 6, class: "field", style: { width: "100%" }, placeholder: "Descrivi il problema o la richiesta" });
  if (!(await modal("Segnalazione", el("div", { style: { minWidth: "420px" } }, ta), [{ label: "Annulla", value: false }, { label: "Invia", value: true, primary: true }]))) return;
  if (!ta.value.trim()) return toast("Scrivi il testo della segnalazione", true);
  try { const r = await remote("request", { type: "report", message: ta.value }); toast(r.messaggio || "Segnalazione inviata"); } catch (e) { toast(e.message, true, 7000); }
}

async function changeFromAccount() {
  const ta = el("textarea", { rows: 3, class: "field", style: { width: "100%" }, placeholder: "Quale dispositivo cambi e perche' (es. nuovo cellulare)" });
  const ok = await modal("Cambio PC / cellulare", el("div", { style: { display: "grid", gap: "8px", minWidth: "400px" } },
    el("p", { style: { margin: 0 } }, `Viene generata una chiave nuova e quella attuale smette subito di funzionare su tutti i dispositivi, compreso questo ${MOBILE() ? "cellulare" : "PC"}.`),
    el("p", { class: "note", style: { margin: 0 } }, "Inserisci poi la chiave nuova sui dispositivi che continui a usare."), ta),
    [{ label: "Annulla", value: false }, { label: "Genera chiave nuova", value: true, primary: true }]);
  if (!ok) return;
  try { await showNewKey(await remote("request", { type: "change", message: ta.value })); } catch (e) { toast(e.message, true, 8000); }
}
