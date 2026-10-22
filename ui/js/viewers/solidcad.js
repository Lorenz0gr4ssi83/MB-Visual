// SolidWorks (.sldprt/.sldasm/.slddrw), Solid Edge (.par/.psm/.asm/.dft) e Parasolid (.x_t/.x_b) senza i programmi originali.
// Passo 1: anteprima incorporata, proprieta', configurazioni, materiale, componenti (api solid_info, mbvisual/solidcad.py).
// Passo 2: il Parasolid contenuto nel file convertito in STEP esatto (api solid_step, mbvisual/xt2step.py) e mostrato
// nel visualizzatore 3D esistente (viewers/model3d.js con occt-import-js), con assiemi composti dalle matrici.
import { api, button, el, fileUrl, loading, readBytes, toast, waitJob, WEB, withExt } from "../core.js";
import { collator, fmtNum, t, tn } from "../i18n.js";

// colonne delle tabelle nome/valore del pannello laterale (stretto)
const KV = { gridTemplateColumns: "minmax(70px, 42%) minmax(0, 1fr)" };
// voci del resoconto di conversione (codici di mbvisual/xt2step.py)
const REPORT = ["intersection_polyline", "sp_sampled", "tolerant_edges", "blends_rebuilt", "degenerate_torus", "open_solids"];

function skipLabel(code) {
  const [k, arg] = code.split(":");
  const key = "v_solidcad.skip_" + k;
  const txt = t(key, arg || "");
  return txt === key ? code : txt;
}

export async function mount(ctx) {
  ctx.el.innerHTML = "";
  if (WEB) {
    ctx.el.append(el("div", { class: "center" }, el("div", { class: "panel", style: { maxWidth: "520px" } }, t("v_solidcad.solo_pc"))));
    return {};
  }
  const ld = loading(ctx.el, t("v_solidcad.lettura_file"));
  const info = await api("solid_info", { path: ctx.path });
  ctx.el.innerHTML = "";
  ctx.fillBody(true);

  // ---- impaginazione: modello (o anteprima) a sinistra, informazioni a destra
  const stage = el("div", { style: { position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden" } });
  const side = el("div", { class: "solidcad-info", style: { overflow: "auto", minHeight: 0, borderLeft: "1px solid var(--line)", background: "var(--panel)", padding: "12px 14px", fontSize: "12.5px" } });
  const grid = el("div", { class: "side solidcad", style: { gridTemplateColumns: "1fr 340px" } }, stage, side);
  ctx.el.append(grid);
  let sideOpen = true;
  const infoBtn = button(t("v_solidcad.informazioni"), "table", () => {
    sideOpen = !sideOpen;
    side.hidden = !sideOpen;
    grid.style.gridTemplateColumns = sideOpen ? "1fr 340px" : "1fr";
    infoBtn.classList.toggle("on", sideOpen);
    window.dispatchEvent(new Event("resize"));
  }, { title: t("v_solidcad.informazioni_tip") });
  infoBtn.classList.add("on");
  const myTb = el("span", { style: { display: "contents" } }, infoBtn);

  // ---- pannello informazioni
  const reportBox = el("div");
  const head = el("div", { style: { display: "grid", gap: "8px", marginBottom: "10px" } });
  if (info.anteprima) head.append(el("img", { src: fileUrl(info.anteprima), alt: "", style: { width: "100%", maxHeight: "220px", objectFit: "contain", background: "#fff", borderRadius: "6px", border: "1px solid var(--line)" } }));
  const kv = el("dl", { class: "kv", style: KV });
  const add = (k, v) => v && kv.append(el("dt", {}, k), el("dd", {}, v));
  add(t("v_solidcad.tipo"), info.tipo);
  add(t("v_solidcad.formato"), info.formato);
  add(t("v_solidcad.materiale"), info.materiale);
  head.append(kv);
  for (const a of info.avvisi || []) head.append(el("p", { class: "note", style: { margin: 0, color: "var(--warn, #b26b00)" } }, a));
  side.append(head, reportBox);

  // configurazioni (SolidWorks): scelta di quale geometria mostrare
  const cfgs = info.configurazioni || [];
  let config = null;
  if (cfgs.length) {
    side.append(el("h4", { style: { margin: "12px 0 4px" } }, tn("v_solidcad.n_configurazioni", cfgs.length)));
    const list = el("div", { style: { display: "grid", gap: "2px" } });
    for (const c of cfgs) list.append(el("div", {}, c.nome, c.geometria ? "" : el("span", { class: "note" }, " · " + t("v_solidcad.senza_geometria"))));
    side.append(list);
    const withGeo = cfgs.filter(c => c.geometria);
    if (withGeo.length > 1) {
      const sel = el("select", { title: t("v_solidcad.configurazione") }, ...withGeo.map(c => el("option", { value: c.id }, c.nome)));
      sel.addEventListener("change", () => { config = +sel.value; load(); });
      myTb.append(sel);
    }
  }

  // componenti referenziati (assiemi e tavole), con verifica della presenza su disco
  const comps = info.componenti || [];
  if (comps.length) {
    const found = comps.filter(c => c.trovato).length;
    side.append(el("h4", { style: { margin: "12px 0 4px" } }, t("v_solidcad.componenti_trovati", comps.length, found)));
    const tbl = el("div", { style: { display: "grid", gap: "2px" } });
    for (const c of [...comps].sort((a, b) => collator.compare(a.nome, b.nome))) {
      const row = el("div", { style: { display: "flex", gap: "6px", alignItems: "center" }, title: c.trovato || c.percorso },
        el("span", { style: { color: c.trovato ? "var(--ok, #2e7d32)" : "var(--bad, #c62828)", width: "14px" } }, c.trovato ? "✓" : "✗"),
        el("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.nome),
        c.istanze ? el("span", { class: "note" }, "×" + c.istanze) : null,
        c.trovato ? el("button", { class: "btn", style: { padding: "1px 8px" }, onclick: () => ctx.openPaths([c.trovato]) }, t("v_solidcad.apri")) : null);
      tbl.append(row);
    }
    side.append(tbl);
    if (found < comps.length) side.append(el("p", { class: "note", style: { margin: "4px 0 0" } }, t("v_solidcad.componenti_mancanti_nota")));
  }

  // proprieta' per gruppo
  const groups = new Map();
  for (const p of info.proprieta || []) {
    if (!groups.has(p.gruppo)) groups.set(p.gruppo, []);
    groups.get(p.gruppo).push(p);
  }
  for (const [g, list] of groups) {
    const det = el("details", { open: groups.size <= 2 || undefined, style: { marginTop: "10px" } }, el("summary", { style: { fontWeight: 600, cursor: "default" } }, `${g} (${list.length})`));
    const dl = el("dl", { class: "kv", style: { ...KV, marginTop: "6px" } });
    for (const p of list) dl.append(el("dt", {}, p.nome), el("dd", {}, p.valore));
    det.append(dl);
    side.append(det);
  }

  // ---- modello 3D
  let inner = null;
  let step = null;
  async function load() {
    if (inner) { try { inner.dispose?.(); } catch { /* */ } inner = null; }
    for (const n of [...ctx.tb.childNodes]) if (n !== myTb) n.remove();
    const ld3 = loading(stage, t("v_solidcad.conversione"));
    let res;
    try {
      const job = await api("solid_step", { path: ctx.path, ...(config !== null ? { config } : {}) });
      res = await waitJob(job.job, (p, m) => ld3.set(p * 0.6, m));
    } catch (e) {
      stage.innerHTML = "";
      stage.append(previewOrMessage(e.message));
      reportBox.innerHTML = "";
      reportBox.append(el("p", { class: "note", style: { margin: "6px 0" } }, t("v_solidcad.geometria_non_convertita", e.message)));
      ctx.tb.append(myTb);
      return;
    }
    step = res;
    showReport(res);
    ld3.set(0.65, t("v_solidcad.lettura_step"));
    const mod = await import("./model3d.js");
    // il visualizzatore 3D lavora su una copia del contesto che punta allo STEP convertito
    const sub = { ...ctx, el: stage, path: res.step, ext: "step", info: { ...(ctx.info || {}), nome: ctx.name } };
    inner = await mod.mount(sub);
    ctx.tb.append(myTb);
    const pct = res.facce ? `${fmtNum(res.percentuale, 1)}%` : "";
    if (pct) ctx.status(t("v_solidcad.stato_facce", res.convertite, res.facce, pct) + (ctx.tab.extra ? " · " + ctx.tab.extra : ""));
  }

  function previewOrMessage(msg) {
    const box = el("div", { class: "center", style: { height: "100%", flexDirection: "column", gap: "10px", padding: "16px" } });
    if (info.anteprima) box.append(el("img", { src: fileUrl(info.anteprima), alt: "", style: { maxWidth: "100%", maxHeight: "80%", objectFit: "contain", background: "#fff", borderRadius: "6px" } }));
    if (msg) box.append(el("p", { class: "note", style: { maxWidth: "560px", textAlign: "center" } }, msg));
    return box;
  }

  function showReport(r) {
    reportBox.innerHTML = "";
    const dl = el("dl", { class: "kv", style: KV });
    const addr = (k, v) => v !== undefined && v !== null && v !== "" && dl.append(el("dt", {}, k), el("dd", {}, String(v)));
    addr(t("v_solidcad.facce_convertite"), r.facce ? t("v_solidcad.su", r.convertite, r.facce, fmtNum(r.percentuale, 1) + "%") : "");
    const rep = r.resoconto || {};
    addr(t("v_solidcad.corpi"), rep.bodies);
    for (const k of REPORT) if (rep[k]) addr(t("v_solidcad.rep_" + k), rep[k]);
    for (const [k, v] of Object.entries(rep)) if (k.startsWith("skip:")) addr(t("v_solidcad.saltate"), `${v} · ${skipLabel(k.slice(5))}`);
    if (r.mancanti?.length) addr(t("v_solidcad.mancanti"), r.mancanti.join(", "));
    if (r.non_convertiti?.length) addr(t("v_solidcad.non_convertiti"), r.non_convertiti.join("; "));
    addr(t("v_solidcad.parasolid"), (r.parasolid || []).filter(Boolean).slice(0, 3).join(" · "));
    addr(t("v_solidcad.tempo"), r.secondi !== undefined ? fmtNum(r.secondi, 1) + " s" : "");
    reportBox.append(el("h4", { style: { margin: "4px 0" } }, t("v_solidcad.conversione_3d")), dl,
      el("p", { class: "note", style: { margin: "4px 0 0" } }, t("v_solidcad.nota_fedelta")));
  }

  if (info.geometria) await load();
  else {
    stage.append(previewOrMessage(info.cad ? t("v_solidcad.solo_anteprima") : ""));
    ctx.tb.append(myTb);
  }

  // salvataggio: STEP esatto (B-rep convertito) oltre ai formati del visualizzatore 3D
  return {
    get saveFormats() { return inner ? inner.saveFormats : step ? ["stp", "step"] : []; },
    get saveLabels() {
      return { ...(inner?.saveLabels || {}), stp: t("v_solidcad.step_esatto"), step: t("v_solidcad.step_esatto") };
    },
    get saveNote() { return step ? t("v_solidcad.step_nota") : inner?.saveNote; },
    saveInPlace: false,
    saveAsName: () => withExt(ctx.name, "step"),
    async save(target) {
      const ext = target.split(".").pop().toLowerCase();
      if ((ext === "stp" || ext === "step") && step) {
        await api("save", { path: target }, { body: await readBytes(step.step) });
        toast(t("v_solidcad.step_salvato"));
        return { switchTo: false };
      }
      if (!inner) throw new Error(t("v_solidcad.niente_da_salvare"));
      return inner.save.call(inner, target);
    },
    onShow() { inner?.onShow?.(); },
    onBack: () => inner?.onBack?.(),
    dispose() { try { inner?.dispose?.(); } catch { /* */ } },
  };
}
