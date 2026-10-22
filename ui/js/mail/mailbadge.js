// Posta in background (app per PC): all'avvio parte il motore della posta (sincronizzazione, invii programmati), il
// pulsante Posta della barra laterale mostra i messaggi da leggere e, se la scheda Posta non e' aperta, arrivano gli
// avvisi dei messaggi nuovi, dei promemoria e degli eventi in arrivo.
import { api, el, loadCss } from "../core.js";
import { t as tr } from "../i18n.js";

const seen = new Set();

export function setupMailBadge() {
  loadCss("css/mail.css");
  const btn = document.getElementById("btn-mail");
  if (!btn) return;
  const badge = el("span", { class: "mbadge", hidden: true });
  btn.append(badge);
  const tick = async () => {
    const open = (window.MB?.tabs || []).some(t => t.viewer === "mail");
    try {
      const st = await api("mail", { op: "status", ...(open ? {} : { nuovi: 1 }) });
      const n = st.nonletti || 0;
      badge.hidden = !n;
      badge.textContent = n > 99 ? "99+" : String(n);
      btn.title = tr("mail.posta_titolo") + (n ? ` · ${n}` : "");
      if (!open) {
        for (const m of st.nuovi || []) note("posta", m.from_name || m.from_addr, m.subject || tr("mail.senza_oggetto"), m.id);
        for (const r of st.promemoria || []) if (!seen.has("r" + r.id + r.remind_at)) { seen.add("r" + r.id + r.remind_at); note("sveglia", tr("mail.promemoria"), r.subject, r.id); }
        for (const e of st.eventi || []) if (!seen.has("e" + e.id + e.start)) {
          seen.add("e" + e.id + e.start);
          note("cal", e.summary, new Date(e.start * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) + (e.location ? " · " + e.location : ""));
        }
      }
    } catch { /* motore non pronto */ }
  };
  setTimeout(tick, 4000);
  setInterval(tick, 30000);
}

const ICON = {
  posta: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/></svg>',
  sveglia: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2M4 5l3-2M20 5l-3-2"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
};

function note(kind, title, text, id) {
  const box = document.querySelector(".ml-notes") || document.body.appendChild(el("div", { class: "ml-notes" }));
  const card = el("div", { class: "ml-note" + (kind !== "posta" ? " remind" : ""), onclick: async () => {
    card.remove();
    await window.MB.openMail();
    if (id) setTimeout(() => import("./mailapp.js").then(m => m.openMessage(id)), 600);
  } }, el("span", { class: "mi", html: ICON[kind] }), el("div", {}, el("b", {}, title || ""), el("div", {}, text || "")));
  box.append(card);
  setTimeout(() => card.remove(), kind === "posta" ? 8000 : 60000);
}
