// Confronto tra due revisioni dello stesso documento (PDF, DWG/DXF, IFC): guscio comune, il lavoro e' in ui/js/compare/*.
import { api, baseName, button, dirName, el, loadCss, loading, toast } from "../core.js";
import { compareFamily, FAMILY_IT, saveOut, stamp, stem } from "../compare/common.js";
import { t } from "../i18n.js";

const MODULES = { pdf: "../compare/pdfcmp.js", cad: "../compare/cadcmp.js", ifc: "../compare/ifccmp.js" };
const ICON_SWAP = '<svg viewBox="0 0 24 24"><path d="M4 8h14l-4-4M20 16H6l4 4"/></svg>';

export async function mount(ctx) {
  loadCss("css/compare.css");
  const other = ctx.compareWith;
  if (!other) throw new Error(t("v_compare.manca_secondo_file_confrontare"));
  const fam = compareFamily(ctx.info?.nome || ctx.path);
  if (!fam || fam !== compareFamily(other)) throw new Error(t("v_compare.si_possono_confrontare_solo_due"));
  ctx.fillBody(true);
  // vecchia = la revisione salvata prima (si puo' invertire)
  let oldPath = ctx.path, newPath = other;
  if (!ctx.compareOrderFixed) {
    try {
      const b = await api("info", { path: other });
      if (b.modificato && ctx.info?.modificato && b.modificato < ctx.info.modificato) { oldPath = other; newPath = ctx.path; }
    } catch { /* */ }
  }
  let cur = null;
  const dir = dirName(ctx.path).startsWith("web:") ? "" : dirName(ctx.path);
  const suggested = ext => `Confronto ${stem(oldPath)} - ${stem(newPath)}.${ext}`;

  async function run() {
    try { cur?.dispose?.(); } catch { /* */ }
    cur = null;
    ctx.tb.innerHTML = "";
    ctx.el.innerHTML = "";
    const tools = el("span", { class: "cmp-tools" });
    ctx.tb.append(
      el("span", { class: "cmp-file old", title: oldPath }, el("i"), t("v_compare.vecchia"), el("b", {}, baseName(oldPath))),
      button("", ICON_SWAP, () => { [oldPath, newPath] = [newPath, oldPath]; run(); }, { iconOnly: true, title: t("v_compare.inverti_vecchia_nuova") }),
      el("span", { class: "cmp-file new", title: newPath }, el("i"), t("v_compare.nuova"), el("b", {}, baseName(newPath))),
      el("span", { class: "sep" }), tools, el("span", { class: "grow" }),
      button(t("v_compare.report_pdf"), "download", () => exp("pdf"), { title: t("v_compare.esporta_risultato_confronto_pdf") }),
      button(t("v_compare.excel"), "table", () => exp("xlsx"), { title: t("v_compare.esporta_l_elenco_differenze_excel") }),
      button("CSV", "download", () => exp("csv"), { title: t("v_compare.esporta_l_elenco_differenze_csv") }));
    // il contenuto si prepara gia' al suo posto (servono le dimensioni reali), coperto dal messaggio di avanzamento
    const body = el("div", { class: "cmp-root" }), cover = el("div", { class: "cmp-cover" });
    ctx.el.append(body, cover);
    const ld = loading(cover, t("v_compare.confronto_0", FAMILY_IT[fam]));
    const mod = await import(MODULES[fam]);
    try {
      cur = await mod.mountCompare({
        ctx, oldPath, newPath, oldName: baseName(oldPath), newName: baseName(newPath), tools, progress: (p, m) => ld.set(p, m),
        body,
        info: { oldName: baseName(oldPath), newName: baseName(newPath), date: stamp() },
      });
      cover.remove();
      cur.onShow?.();
    } catch (e) {
      console.error(e);
      ctx.el.innerHTML = "";
      ctx.el.append(el("div", { class: "center" }, el("div", { class: "panel", style: { maxWidth: "560px", textAlign: "left" } },
        el("h3", { style: { marginTop: 0 } }, t("v_compare.confronto_non_riuscito")), el("p", { class: "err" }, String(e?.message || e)))));
    }
  }

  async function exp(ext, target = null) {
    if (!cur) return;
    const fn = { pdf: cur.reportPdf, xlsx: cur.reportXlsx, csv: cur.reportCsv }[ext];
    if (!fn) return toast(t("v_compare.esportazione_non_disponibile_questo_confronto"), true);
    try {
      ctx.status(t("v_compare.preparazione_report"));
      const blob = await fn();
      const p = await saveOut(blob, suggested(ext), dir, target);
      ctx.status("");
      if (p && !target) toast(t("v_compare.report_salvato") + baseName(p));
    } catch (e) { console.error(e); toast(t("v_compare.esportazione_non_riuscita") + e.message, true, 6000); }
  }

  await run();
  return {
    get _cmp() { return cur; }, // per i collaudi dalla console
    onShow() { cur?.onShow?.(); },
    onBack() { return cur?.onBack?.() || false; },
    saveInPlace: false,
    noConvert: true,
    saveFormats: ["pdf", "xlsx", "csv"],
    saveLabels: { pdf: t("v_compare.report_confronto"), xlsx: t("v_compare.elenco_differenze_excel"), csv: t("v_compare.elenco_differenze_csv") },
    saveNote: t("v_compare.confronto_si_salva_come_report"),
    saveAsName: () => suggested("pdf"),
    async save(target) { await exp(target.split(".").pop().toLowerCase(), target); return { switchTo: false }; },
    dispose() { try { cur?.dispose?.(); } catch { /* */ } },
  };
}
