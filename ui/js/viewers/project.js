// Piani di progetto nell'editor in stile Microsoft Project (ui/js/project/pedit.js).
// Si aprono: .mpp/.mpt (Project 2007-2024, motore mbvisual/mpp.py, solo app per PC), XML di Project (MSPDI), .mpx,
// Primavera P6 (.xer e XML), GanttProject (.gan). Si salvano: XML di Project (si riapre in Project con tutto quello
// che l'app non gestisce conservato), .mpx, .gan, .mpp solo con Microsoft Project installato, PDF, Excel, PNG.
import { api, loading, readBytes, toast, waitJob, withExt, extOf, loadCss, WEB } from "../core.js";
import { t } from "../i18n.js";
import { readProject, fromEngine, writeMspdi, writeMpx, writeGan } from "../project/pio.js";
import { schedule } from "../project/pmodel.js";
import { createEditor } from "../project/pedit.js";
import * as X from "../project/pexport.js";

const L = k => t("proj." + k);
const enc = s => new TextEncoder().encode(s);

export async function mount(ctx) {
  loadCss("css/project.css");
  const ld = loading(ctx.el, L("apertura"));
  let P;
  const binary = ["mpp", "mpt"].includes(ctx.ext);
  if (binary) {
    if (WEB) throw new Error(L("mpp_solo_pc"));
    const { job } = await api("mpp_read", { path: ctx.path });
    P = fromEngine(await waitJob(job, (p, m) => ld.set?.(p, m || L("lettura_mpp"))));
  } else {
    P = readProject(await readBytes(ctx.path), ctx.ext);
  }
  schedule(P);
  const phone = document.documentElement.classList.contains("phone");
  const E = createEditor(ctx, P, { view: phone ? "progress" : "gantt" });
  const src = P.src || P.x?.fmt;
  if (binary) toast(L("mpp_aperto"), false, 7000);
  else if (src === "xer" || src === "p6xml") toast(L("primavera_aperto"), false, 7000);
  if (P.warnings?.length) toast(L("ciclo_avviso"), true, 6000);

  const project = !WEB && ctx.tools?.msproject;
  const native = { mspdi: "xml", mpx: "mpx", gan: "gan", mpp: project ? ctx.ext : "xml" }[src] || "xml";
  const fmts = [...new Set([native, "xml", ...(project ? ["mpp"] : []), "mpx", "gan", "pdf", "xlsx", "png"])];
  return {
    saveFormats: fmts,
    saveLabels: { xml: L("fmt_xml"), mpp: L("fmt_mpp"), mpt: L("fmt_mpp"), mpx: L("fmt_mpx"), gan: L("fmt_gan"), pdf: L("fmt_pdf"), xlsx: L("fmt_xlsx"), png: L("fmt_png") },
    saveNote: project ? L("nota_salva_project") : L("nota_salva"),
    saveInPlace: ["xml", "mpx", "gan"].includes(ctx.ext) && src !== "p6xml" || (binary && project),
    saveAsName: () => withExt(ctx.tab.name, native),
    async save(path) {
      const ext = extOf(path);
      const Pn = E.S.P;
      if (ext === "pdf") { const { blob } = await X.ganttPdf(E, { kind: "pdf", paper: "A3", fitWidth: false, links: true, res: true, base: E.S.o.base, crit: E.S.o.crit, ppd: Math.max(1, E.ganttState().zoom * 0.75) }); await api("save", { path }, { body: new Uint8Array(await blob.arrayBuffer()) }); return { switchTo: false }; }
      if (ext === "xlsx") { const b = await X.excel(E); await api("save", { path }, { body: new Uint8Array(await b.arrayBuffer()) }); return { switchTo: false }; }
      if (ext === "png") { const b = await X.ganttPng(E, { kind: "png", links: true, res: true, base: E.S.o.base, crit: E.S.o.crit, ppd: Math.max(1, E.ganttState().zoom * 0.75) }); await api("save", { path }, { body: new Uint8Array(await b.arrayBuffer()) }); return { switchTo: false }; }
      if (ext === "mpp" || ext === "mpt") {
        const { job } = await api("mpp_write", { path }, { body: enc(writeMspdi(Pn)) });
        await waitJob(job);
      } else {
        const text = ext === "mpx" ? writeMpx(Pn) : ext === "gan" ? writeGan(Pn) : writeMspdi(Pn);
        await api("save", { path }, { body: enc(text) });
      }
      if (path === ctx.tab.path || ["xml", "mpx", "gan", "mpp", "mpt"].includes(ext)) ctx.setDirty(false);
    },
    onShow() { E.onShow(); },
    onBack() { if (E.S.view !== "gantt" && !document.documentElement.classList.contains("phone")) { E.setView("gantt"); return true; } return false; },
    _pj: E,
  };
}
