// "File non supportato": cosa si vede quando un file non si puo' aprire. Nessuna opzione tecnica, solo la segnalazione a MB Desk Admin.
// Alla segnalazione vanno estensione e motivo tecnico, mai il file, il suo nome o i percorsi.
import { el, loadCss } from "./core.js";
import { t as tr } from "./i18n.js";
import { sendFeedback } from "./license.js";

const ICON = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9.5 12.5l5 5M14.5 12.5l-5 5"/></svg>';

// il messaggio di errore puo' citare il file: nome e percorsi si tolgono prima dell'invio
export function cleanDetail(error, name) {
  let s = String(error?.message || error || "");
  if (name) s = s.split(name).join("<file>");
  return s.replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|Volumes|private|tmp)\/)[^"'<>|\r\n]*/g, "<percorso>").slice(0, 300);
}

export function reportUnsupported(ext, detail) {
  return sendFeedback({ topic: "unsupported", title: tr("feedback.titolo_non_supportato"), intro: tr("feedback.cosa_viene_inviato"), placeholder: tr("feedback.nota_facoltativa"), ext, detail });
}

export function mountUnsupported(ctx, error) {
  loadCss("css/recover.css");
  const ext = ctx.ext || "", detail = [error ? ctx.tab?.viewer : "", cleanDetail(error, ctx.name)].filter(Boolean).join(": ");
  const send = el("button", { class: "btn primary", type: "button" }, tr("feedback.segnala"));
  send.addEventListener("click", async () => {
    if (!(await reportUnsupported(ext, detail))) return;
    send.disabled = true;
    send.textContent = tr("feedback.segnalato");
  });
  ctx.el.append(el("div", { class: "ns" }, el("div", { class: "ns-ico", html: ICON }),
    el("h2", {}, tr("feedback.file_non_supportato")), el("p", { class: "ns-name", title: ctx.name }, ctx.name), send));
  return {};
}
