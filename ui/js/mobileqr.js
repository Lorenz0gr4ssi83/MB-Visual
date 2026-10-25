// QR della home (solo app per PC con licenza): installa MB Desk sul cellulare senza scrivere la chiave.
// Il QR contiene un link monouso del server delle licenze (mbvisual/license.py mobile_link -> /v1/mlink). Sotto: quanti
// cellulari si possono ancora attivare; a posti finiti il riquadro sparisce. Dopo ogni attivazione dal QR il server blocca
// la licenza per un minuto: il QR si spegne e mostra il conto alla rovescia (il blocco vale anche sul server).
// Aggiornamento ogni 6 s mentre la home e' visibile (cosi' il QR si spegne subito dopo la scansione), fermo altrimenti.
import { api, el, WEB } from "./core.js";
import { t, tn } from "./i18n.js";

let qrcode = null;
async function qrSvg(text, px) {
  qrcode ??= (await import("../vendor/qrcode-generator/dist/qrcode.mjs")).default;
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 2; // margine minimo (zona di rispetto) in moduli
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
  const s = n + 2 * m;
  return `<svg viewBox="0 0 ${s} ${s}" width="${px}" height="${px}" shape-rendering="crispEdges" aria-hidden="true"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}

export function setupMobileQr() {
  if (WEB) return;
  const home = document.getElementById("home");
  if (!home) return;
  const code = el("div", { class: "mqr-code" });
  const label = el("div", { class: "mqr-label" });
  const card = el("button", { type: "button", class: "mqr", hidden: true, title: t("mqr.ingrandisci") },
    el("div", { class: "mqr-title" }, t("mqr.titolo")), code, label);
  home.append(card);
  let state = null, lastUrl = "", timer = 0, tick = 0;

  const minutesLeft = () => Math.max(1, Math.ceil((state.attesa_fino - Date.now()) / 60000));
  function render() {
    const show = state?.attivo && state.liberi > 0;
    card.hidden = !show;
    if (!show) return;
    const waiting = state.attesa_fino && state.attesa_fino > Date.now();
    card.classList.toggle("waiting", !!waiting);
    card.disabled = !!waiting;
    label.textContent = waiting ? tn("mqr.attesa", minutesLeft()) : tn("mqr.puoi", state.liberi);
  }
  async function refresh() {
    if (!document.body.classList.contains("at-home") || document.hidden) return;
    let r;
    try { r = await api("license/mobile", {}, { allowFail: true }); } catch { return; }
    state = r;
    if (r.attivo && r.url && r.url !== lastUrl) { lastUrl = r.url; code.innerHTML = await qrSvg(r.url, 104); }
    if (r.attivo && !r.url && r.attesa_fino) code.classList.add("off"); else code.classList.remove("off");
    render();
  }
  // conto alla rovescia del blocco (si aggiorna ogni secondo senza chiedere al server)
  tick = setInterval(() => { if (state?.attesa_fino) { if (state.attesa_fino <= Date.now()) { state.attesa_fino = 0; refresh(); } else render(); } }, 1000);
  timer = setInterval(refresh, 6000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  window.addEventListener("mbv-licenza-ok", refresh);
  new MutationObserver(() => { if (document.body.classList.contains("at-home")) refresh(); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  refresh();

  // clic: QR grande con le istruzioni
  card.addEventListener("click", async () => {
    if (!state?.url || card.disabled) return;
    const big = el("div", { class: "mqr-big" });
    big.innerHTML = await qrSvg(state.url, 280);
    const txt = el("div", { class: "mqr-big-txt" }, el("b", {}, tn("mqr.puoi", state.liberi)), el("span", {}, t("mqr.istruzioni")), el("span", { class: "note" }, t("mqr.monouso")));
    const back = el("div", { class: "mqr-back", onclick: e => { if (e.target === back) back.remove(); } }, el("div", { class: "mqr-panel" }, big, txt,
      el("button", { type: "button", class: "btn", onclick: () => back.remove() }, t("common.chiudi"))));
    document.body.append(back);
    // il QR grande si chiude da solo appena il telefono lo usa (blocco) o quando il link cambia
    const watch = setInterval(() => { if (!document.body.contains(back)) return clearInterval(watch); if (!state?.url || state.url !== lastUrl || card.disabled) { back.remove(); clearInterval(watch); } }, 1000);
  });
  return () => { clearInterval(timer); clearInterval(tick); };
}
