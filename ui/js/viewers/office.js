// Altri formati Office/OpenDocument: conversione con LibreOffice in PDF per la vista, esportazione per la modifica.
import { api, button, el, loading, waitJob } from "../core.js";
import { t } from "../i18n.js";

const EDIT_TARGET = { doc: "docx", dot: "docx", rtf: "docx", odt: "docx", ott: "docx", fodt: "docx", wpd: "docx", wps: "docx", wpt: "docx",
  wri: "docx", sxw: "docx", abw: "docx", zabw: "docx", hwp: "docx", lwp: "docx", "602": "docx", pages: "docx",
  odp: "pptx", otp: "pptx", fodp: "pptx", ppt: "pptx", pps: "pptx", pot: "pptx", sxi: "pptx", key: "pptx",
  sxc: "xlsx", odg: "pdf", otg: "pdf", fodg: "pdf", vsd: "pdf", vsdx: "pdf", vsdm: "pdf", pub: "pdf", cdr: "pdf", sxd: "pdf" };

export async function mount(ctx) {
  if (!ctx.tools.libreoffice) {
    ctx.el.append(el("div", { class: "center" }, el("div", { class: "panel", style: { maxWidth: "620px", textAlign: "left", display: "grid", gap: "10px" } },
      el("h3", { style: { margin: 0 } }, t("v_office.serve_libreoffice_questo_formato")),
      el("p", { style: { margin: 0 } }, t("v_office.i_file_0_vengono_convertiti", ctx.ext) +
        t("v_office.installalo_volta_anche_versione_portatile")),
      el("p", { style: { margin: 0 }, class: "note" }, t("v_office.indirizzo_scaricarlo_https_www_libreoffice")),
      el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
        el("button", { class: "btn", onclick: () => ctx.openAs("text") }, t("v_office.apri_come_testo")),
        el("button", { class: "btn", onclick: () => ctx.openAs("hex") }, t("v_office.apri_come_esadecimale")),
        el("button", { class: "btn", onclick: () => api("open_external", { path: ctx.path }) }, t("v_office.apri_programma_windows"))))));
    return {};
  }
  const ld = loading(ctx.el, t("v_office.conversione_libreoffice"));
  const job = await api("office_convert", { path: ctx.path, to: "pdf" });
  const res = await waitJob(job.job, (p, m) => ld.set(p, m));
  ctx.el.innerHTML = "";
  const target = EDIT_TARGET[ctx.ext];
  if (target && target !== "pdf") {
    ctx.tb.append(button(t("v_office.modifica_converte_0", target.toUpperCase()), "edit", async () => {
      const j = await api("office_convert", { path: ctx.path, to: target });
      const r = await waitJob(j.job);
      ctx.openFile(r.path, null, { fresh: true });
    }), el("span", { class: "sep" }));
  }
  const pdf = await import("./pdf.js");
  const sub = { ...ctx, path: res.path };
  const api2 = await pdf.mount(sub);
  return { save: api2.save, saveInPlace: false, saveAsName: () => ctx.name.replace(/\.[^.]+$/, ".pdf") };
}
