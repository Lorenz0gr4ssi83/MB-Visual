// SAMB - pannello nel visualizzatore 3D dei file .cii: dati di calcolo (salvati in <nome>.samb accanto al file), calcolo,
// verifica B31.3, spostamenti, reazioni, forma deformata ed esportazione CSV. h = scena del visualizzatore (bcfHost di model3d.js).
import { api, baseName, dirName, el, loadCss, pickSavePath, readBytes, saveBytes, toast, WEB } from "../core.js";
import { LOCALE, t as tr } from "../i18n.js";
import { parseCii } from "../ciiparse.js";
import { DEFAULTS, buildModel } from "./sambmodel.js";
import { analyze } from "./sambcode.js";

const num = (v, d = 1) => (v == null || !isFinite(v) ? "—" : (Math.abs(v) < 0.5 * 10 ** -d ? 0 : Number(v)).toLocaleString(LOCALE, { maximumFractionDigits: d, minimumFractionDigits: d }));
const FIELDS = [["tref", "°C", 1], ["alphaE6", "1e-6/°C", 1], ["fluid", "kg/m³", 1], ["insul", "N/m", 1], ["Sc", "MPa", 1], ["Sh", "MPa", 1], ["f", "", 1]];

export function attachSamb(h, onToggle) {
  loadCss("css/navis.css"); loadCss("css/samb.css");
  const { THREE, ctx } = h;
  const sidecar = !WEB && ctx.path ? dirName(ctx.path) + "\\" + baseName(ctx.path).replace(/\.[^.]+$/, "") + ".samb" : null;
  const vals = { ...DEFAULTS, alphaE6: DEFAULTS.alpha * 1e6 };
  let parsed = null, model = null, res = null, tab = "stress", caseId = "OPE", amp = null, overlay = null;

  const root = el("div", { class: "nav-panel samb", hidden: true });
  const body = el("div", { class: "samb-body" });
  root.append(el("div", { class: "nav-head" }, el("b", { class: "samb-title" }, "SAMB"), el("span", { style: { flex: 1 } }),
    el("button", { class: "nav-x", title: tr("nav.chiudi_pannello"), html: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>', onclick: () => close() })), body);
  h.box.append(root);

  const load = async () => {
    parsed = parseCii(new TextDecoder().decode(await readBytes(ctx.path)));
    if (!sidecar) return;
    const st = await api("stat", { path: sidecar }, { allowFail: true }).catch(() => null);
    if (st && st.ok !== false && st.size) { try { Object.assign(vals, JSON.parse(new TextDecoder().decode(await readBytes(sidecar))).dati || {}); } catch { /* file altrui: si riparte dai valori iniziali */ } }
  };
  const saveInputs = async () => { if (sidecar) await saveBytes(sidecar, new TextEncoder().encode(JSON.stringify({ format: "samb", version: 1, dati: vals }, null, 1))).catch(e => toast(e.message, true)); };

  function run() {
    try {
      model = buildModel(parsed, { ...vals, alpha: vals.alphaE6 * 1e-6 });
      res = analyze(model);
      amp = null;
      saveInputs();
    } catch (e) {
      res = null;
      toast(e.message === "unstable" ? tr("samb.err_instabile", e.node ?? "?") : e.message === "bad_section" ? tr("samb.err_sezione") : e.message, true, 8000);
    }
    render();
    drawDeformed();
  }

  const nodeName = i => model.nodes[i].id;
  function verdict(ratio) { return ratio == null ? "" : ratio <= 1 ? "ok" : "ko"; }

  function summary() {
    const c = res.code, row = (label, m, value, allow, ratio) => el("div", { class: "samb-card " + verdict(ratio) },
      el("div", { class: "samb-k" }, label),
      el("div", { class: "samb-v" }, `${num(value)} MPa`),
      el("div", { class: "samb-s" }, allow ? tr("samb.su_amm", num(allow), num(ratio * 100, 0)) : tr("samb.amm_mancante")),
      el("div", { class: "samb-s" }, tr("samb.dove", m.source, nodeName(m.node))));
    return el("div", { class: "samb-cards" },
      row(tr("samb.sostenuto"), c.maxSL, c.maxSL.SL, c.Sh, c.maxSL.rSL),
      row(tr("samb.dilatazione"), c.maxSE, c.maxSE.SE, c.SA, c.maxSE.rSE));
  }
  function table(head, rows) {
    return el("table", { class: "samb-t" }, el("thead", {}, el("tr", {}, ...head.map(x => el("th", {}, x)))), el("tbody", {}, ...rows.map(r => el("tr", { class: r.cls || "" }, ...(r.cells || r).map(x => el("td", {}, x))))));
  }
  const stressRows = () => {
    // per ogni tratto del file e nodo la sezione piu' sollecitata, le peggiori in testa
    const best = new Map();
    for (const r of res.code.rows) { const k = r.source; const w = best.get(k); if (!w || Math.max(r.SL, r.SE) > Math.max(w.SL, w.SE)) best.set(k, r); }
    return [...best.values()].sort((a, b) => Math.max(b.rSL ?? 0, b.rSE ?? 0, b.SE / 1e6) - Math.max(a.rSL ?? 0, a.rSE ?? 0, a.SE / 1e6));
  };
  const dispRows = id => model.nodes.flatMap((n, i) => (n.named ? [{ id: n.id, d: res.cases[id].disp[i] }] : []));
  const reactRows = id => [...res.cases[id].reactions.entries()].map(([k, r]) => ({ id: nodeName(k), r }));

  function results() {
    const box = el("div", {});
    const tabs = [["stress", tr("samb.tensioni")], ["disp", tr("samb.spostamenti")], ["react", tr("samb.reazioni")]];
    box.append(el("div", { class: "samb-tabs" }, ...tabs.map(([k, l]) => el("button", { class: "nav-tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; render(); } }, l))));
    if (tab === "stress") {
      box.append(table([tr("samb.tratto"), tr("samb.nodo"), "SL", "SE", "SE/SA"], stressRows().map(r => ({ cls: verdict(Math.max(r.rSL ?? 0, r.rSE ?? 0) || null), cells: [r.source, nodeName(r.node), num(r.SL), num(r.SE), r.rSE == null ? "—" : num(r.rSE * 100, 0) + "%"] }))));
      box.append(el("p", { class: "note" }, tr("samb.nota_tensioni")));
    } else {
      box.append(el("div", { class: "samb-cases" }, ...["SUS", "OPE", "EXP"].map(k => el("button", { class: "btn" + (caseId === k ? " on" : ""), title: tr("samb.caso_" + k), onclick: () => { caseId = k; amp = null; render(); drawDeformed(); } }, k))));
      if (tab === "disp") box.append(table([tr("samb.nodo"), "DX mm", "DY mm", "DZ mm"], dispRows(caseId).map(r => [r.id, num(r.d[0], 2), num(r.d[1], 2), num(r.d[2], 2)])));
      else box.append(table([tr("samb.nodo"), "FX kN", "FY kN", "FZ kN", "MX kNm", "MY kNm", "MZ kNm"], reactRows(caseId).map(({ id, r }) => [id, ...[0, 1, 2].map(i => num(r[i] / 1e3, 2)), ...[3, 4, 5].map(i => num(r[i] / 1e6, 2))])));
      box.append(el("p", { class: "note" }, tr("samb.caso_" + caseId)));
    }
    return box;
  }

  function inputs() {
    const grid = el("div", { class: "samb-form" });
    for (const [key, unit] of FIELDS) {
      const inp = el("input", { type: "number", step: "any", value: vals[key] ?? "", onchange: e => { const v = e.target.value; vals[key] = v === "" ? null : Number(v); } });
      grid.append(el("label", {}, el("span", {}, tr("samb.f_" + key)), el("span", { class: "samb-in" }, inp, el("i", {}, unit))));
    }
    return grid;
  }

  function warningsBox() {
    if (!model?.warnings.length) return null;
    return el("details", { class: "samb-warn", open: true }, el("summary", {}, tr("samb.ipotesi", model.warnings.length)),
      el("ul", {}, ...model.warnings.map(([k, ...a]) => el("li", {}, tr("samb.w_" + k, ...a)))));
  }

  function render() {
    body.innerHTML = "";
    body.append(inputs(), el("div", { class: "samb-actions" },
      el("button", { class: "btn primary", onclick: run }, tr("samb.calcola")),
      res ? el("button", { class: "btn", onclick: exportCsv }, tr("samb.esporta_csv")) : null,
      res ? el("label", { class: "samb-amp" }, tr("samb.amplifica"), el("input", { type: "number", min: 0, step: "any", value: amp ?? "", onchange: e => { amp = Number(e.target.value) || 0; drawDeformed(); } })) : null));
    if (res) body.append(summary(), results());
    const w = warningsBox();
    if (w) body.append(w);
    body.append(el("p", { class: "note samb-disc" }, tr("samb.avviso")));
  }

  // forma deformata del caso scelto, sopra il modello; amplificazione automatica: spostamento massimo = 10% dell'ingombro
  function drawDeformed() {
    if (overlay) { h.model.remove(overlay); overlay.geometry.dispose(); overlay.material.dispose(); overlay = null; }
    if (!res) return h.render?.();
    const D = res.cases[caseId].disp, E = model.elems, nodes = model.nodes;
    if (amp == null) {
      let top = 0, size = 0;
      for (const d of D) top = Math.max(top, Math.hypot(d[0], d[1], d[2]));
      for (const a of nodes) for (const b of [nodes[0]]) size = Math.max(size, Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]));
      amp = top > 1e-9 ? 0.1 * size / top : 1;
      const f = 10 ** Math.floor(Math.log10(amp));
      amp = Math.round(amp / f) * f;
      render();
    }
    const pos = new Float32Array(E.length * 6);
    E.forEach((e, k) => [e.i, e.j].forEach((n, s) => { for (let c = 0; c < 3; c++) pos[k * 6 + s * 3 + c] = nodes[n].p[c] + amp * D[n][c]; }));
    const g = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3));
    overlay = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff3b30, depthTest: false, transparent: true }));
    overlay.renderOrder = 5;
    overlay.raycast = () => {};
    overlay.userData.proxy = true;
    h.model.add(overlay);
    h.render?.();
  }

  async function exportCsv() {
    const csv = ["sep=;", [tr("samb.tratto"), tr("samb.nodo"), "SL MPa", "SE MPa", "SL/Sh", "SE/SA"].join(";")];
    for (const r of res.code.rows) csv.push([r.source, nodeName(r.node), num(r.SL, 2), num(r.SE, 2), r.rSL == null ? "" : num(r.rSL, 3), r.rSE == null ? "" : num(r.rSE, 3)].join(";"));
    for (const c of ["SUS", "OPE", "EXP"]) {
      csv.push("", `${c};${tr("samb.spostamenti")} mm`);
      for (const r of dispRows(c)) csv.push([r.id, ...r.d.slice(0, 3).map(v => num(v, 3))].join(";"));
      csv.push("", `${c};${tr("samb.reazioni")} kN kNm`);
      for (const { id, r } of reactRows(c)) csv.push([id, ...[0, 1, 2].map(i => num(r[i] / 1e3, 3)), ...[3, 4, 5].map(i => num(r[i] / 1e6, 3))].join(";"));
    }
    const data = new TextEncoder().encode("﻿" + csv.join("\r\n"));
    const target = await pickSavePath(baseName(ctx.path).replace(/\.[^.]+$/, "") + "_samb.csv");
    if (target) { await saveBytes(target, data); toast(tr("samb.esportato")); }
  }

  function close() {
    root.hidden = true;
    if (overlay) overlay.visible = false;
    h.render?.();
    onToggle?.(false);
  }
  let ready = null;
  return {
    async open() {
      ready ??= load();
      await ready;
      root.hidden = false;
      if (overlay) overlay.visible = true;
      render();
      h.render?.();
      onToggle?.(true);
    },
    close,
    get visible() { return !root.hidden; },
    get _s() { return { vals, parsed, get model() { return model; }, get res() { return res; }, run }; },
  };
}
