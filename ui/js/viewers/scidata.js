// Dati scientifici e tabellari (HDF5, NetCDF, Parquet, Feather/Arrow): albero di gruppi/dataset/variabili, attributi
// e schema, dati a pagine, grafico (serie o mappa di colore) dei valori numerici; esportazione CSV/Excel.
// Motore: mbvisual/fx_sci.py (solo app per PC).
import { api, button, el, loadCss, loading } from "../core.js";
import { t as tr, LOCALE } from "../i18n.js";

const PAGE = 200;

export async function mount(ctx) {
  loadCss("css/formati.css");
  loading(ctx.el, tr("v_scidata.lettura_struttura_dati"));
  const info = await api("fx", { op: "sci_open", path: ctx.path });
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  const nodes = info.nodi;
  let sel = nodes.find(n => n.tipo !== "gruppo") || nodes[0], start = 0, fetta = [], last = null;

  const tree = el("div", { class: "tree" });
  const left = el("div", { class: "fx-pane left" }, el("div", { class: "head" }, info.formato), el("div", { class: "scroll" }, tree));
  const right = el("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, height: "100%" } });
  ctx.el.append(el("div", { class: "fx-split with-left" }, left, right));
  ctx.tb.append(el("b", { style: { padding: "0 6px" } }, info.formato), el("span", { class: "note" }, tr("v_scidata.0_oggetti_dati", nodes.filter(n => n.tipo !== "gruppo").length)),
    el("span", { class: "grow" }), el("span", { class: "note" }, tr("v_scidata.salva_nome_esporta_l_oggetto")));

  // ---------------------------------------------------------------- albero
  function renderTree() {
    tree.innerHTML = "";
    for (const n of nodes) {
      const depth = n.nome === "/" ? 0 : n.nome.split("/").length - 1;
      const label = n.nome === "/" ? (n.tipo === "tabella" ? tr("v_scidata.tabella") : tr("v_scidata.radice")) : n.nome.split("/").pop();
      const icon = n.tipo === "gruppo" ? "▸ " : n.tipo === "tabella" ? "▦ " : "▤ ";
      tree.append(el("div", { class: "node" + (n === sel ? " sel" : ""), style: { paddingLeft: 10 + depth * 14 + "px" }, title: n.nome, onclick: () => { sel = n; start = 0; fetta = []; renderTree(); renderNode(); } },
        el("span", {}, icon + label), n.forma ? el("span", { class: "note", style: { marginLeft: "auto" } }, n.forma.join("×")) : null));
    }
    if (info.troncato) tree.append(el("div", { class: "fx-muted fx-small", style: { padding: "8px 10px" } }, tr("v_scidata.elenco_limitato_primi_5000_oggetti")));
  }

  // ---------------------------------------------------------------- oggetto selezionato
  async function renderNode() {
    right.innerHTML = "";
    const n = sel;
    const head = el("div", { class: "sci-attrs", style: { borderBottom: "1px solid var(--line)" } });
    const dl = el("dl", { class: "kv" });
    const add = (k, v) => { if (v !== undefined && v !== null && v !== "") dl.append(el("dt", {}, k), el("dd", {}, String(v))); };
    add(tr("v_scidata.percorso"), n.nome); add(tr("v_scidata.tipo"), { gruppo: tr("v_scidata.gruppo"), dataset: tr("v_scidata.dataset"), variabile: tr("v_scidata.variabile"), tabella: tr("v_scidata.tabella") }[n.tipo] || n.tipo);
    add(tr("v_scidata.forma"), n.forma && n.forma.join(" × ")); add(tr("v_scidata.dimensioni"), n.dimensioni?.join(", ")); add(tr("v_scidata.tipo_dato"), n.dtype);
    add(tr("v_scidata.compressione"), n.compressione); add(tr("v_scidata.blocchi"), n.blocchi?.join(" × "));
    if (n.min !== undefined) add(tr("v_scidata.valori"), tr("v_scidata.0_1", fmt(n.min), fmt(n.max)));
    head.append(dl);
    const attrs = [...(n.schema ? [{ k: tr("v_scidata.schema"), v: "" }, ...n.schema] : []), ...(n.attributi?.length ? [{ k: n.schema ? tr("v_scidata.metadati") : tr("v_scidata.attributi"), v: "" }, ...n.attributi] : [])];
    if (attrs.length) {
      const t = el("table", { class: "fx-table", style: { marginTop: "8px" } });
      for (const a of attrs) t.append(el("tr", {}, el("td", { style: { fontWeight: a.v === "" ? 600 : 400, whiteSpace: "nowrap" } }, a.k), el("td", { style: { overflowWrap: "anywhere", whiteSpace: "pre-wrap" } }, a.v === null ? "" : String(a.v))));
      head.append(el("details", { open: n.tipo === "gruppo" || attrs.length <= 12 }, el("summary", { style: { cursor: "pointer", marginTop: "6px" } }, tr("v_scidata.attributi_schema_0", attrs.filter(a => a.v !== "").length)), t));
    }
    right.append(head);
    if (n.tipo === "gruppo" || n.tipo === "altro") {
      const kids = nodes.filter(x => x !== n && x.nome.startsWith(n.nome === "/" ? "/" : n.nome + "/") && x.nome.split("/").length === (n.nome === "/" ? 2 : n.nome.split("/").length + 1));
      right.append(el("div", { class: "fx-empty" }, kids.length ? tr("v_scidata.gruppo_contiene_0_oggetti_selezionane", kids.length) : tr("v_scidata.gruppo_vuoto")));
      ctx.status(n.nome);
      return;
    }
    // fetta per gli array con piu' di due dimensioni
    const bar = el("div", { class: "tb" });
    if (n.forma && n.forma.length > 2) {
      bar.append(el("span", { class: "note" }, tr("v_scidata.fetta")));
      n.forma.slice(0, -2).forEach((size, i) => {
        const inp = el("input", { type: "number", min: 0, max: size - 1, value: fetta[i] || 0, title: (n.dimensioni?.[i] || tr("v_scidata.dimensione_0", i)) + ` (0-${size - 1})` });
        inp.addEventListener("change", () => { fetta[i] = Math.max(0, Math.min(size - 1, +inp.value || 0)); start = 0; loadData(); });
        bar.append(el("label", {}, n.dimensioni?.[i] || tr("v_scidata.dimensione_0", i), inp));
      });
      bar.append(el("span", { class: "sep" }));
    }
    const pageInfo = el("span", { class: "note" });
    bar.append(button("", "<svg viewBox='0 0 24 24'><path d='M15 6l-6 6 6 6'/></svg>", () => { start = Math.max(0, start - PAGE); loadData(); }, { iconOnly: true, title: tr("v_scidata.righe_precedenti") }),
      button("", "<svg viewBox='0 0 24 24'><path d='M9 6l6 6-6 6'/></svg>", () => { if (last && start + PAGE < last.totale) { start += PAGE; loadData(); } }, { iconOnly: true, title: tr("v_scidata.righe_successive") }), pageInfo);
    const go = el("input", { type: "number", min: 1, placeholder: "riga", title: tr("v_scidata.vai_riga") });
    go.addEventListener("change", () => { start = Math.max(0, (+go.value || 1) - 1); loadData(); });
    bar.append(el("label", {}, tr("v_scidata.vai"), go));
    const chart = el("canvas", { class: "sci-chart" });
    const grid = el("div", { class: "sci-grid", style: { flex: 1, minHeight: 0 } });
    right.append(chart, bar, grid);
    chart.hidden = true;

    async function loadData() {
      grid.innerHTML = "";
      grid.append(el("div", { class: "fx-empty" }, tr("v_scidata.lettura_dati")));
      let d;
      try { d = await api("fx", { op: "sci_data", path: ctx.path }, { json: { nome: n.nome, da: start, n: PAGE, fetta } }); }
      catch (e) { grid.innerHTML = ""; grid.append(el("p", { class: "err", style: { padding: "10px" } }, e.message)); return; }
      last = d;
      pageInfo.textContent = d.totale ? tr("v_scidata.righe_0_1_2_3", start + 1, Math.min(d.totale, start + d.righe.length), d.totale.toLocaleString(LOCALE), d.colonne_troncate ? tr("v_scidata.prime_300_colonne") : "") : tr("v_scidata.nessuna_riga");
      grid.innerHTML = "";
      const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, el("th", { class: "num" }, "#"), ...d.colonne.map(c => el("th", {}, c)))));
      const tb = el("tbody");
      d.righe.forEach((r, i) => tb.append(el("tr", {}, el("td", { class: "num fx-muted" }, start + i + 1), ...r.map(v => el("td", { class: typeof v === "number" ? "num" : "" }, v === null ? "" : typeof v === "number" ? fmt(v) : String(v))))));
      t.append(tb);
      grid.append(t);
      drawChart(chart, d.grafico);
      ctx.status(`${n.nome} · ${n.forma?.join("×") || ""}`);
    }
    await loadData();
  }

  renderTree();
  await renderNode();
  return {
    saveInPlace: false,
    saveFormats: ["csv", "xlsx"],
    saveLabels: { csv: tr("v_scidata.oggetto_selezionato_tabella_separatore"), xlsx: tr("v_scidata.oggetto_selezionato_foglio_excel") },
    saveAsName() { return ctx.name.replace(/\.[^.]+$/, "") + (sel.nome !== "/" ? "_" + sel.nome.split("/").pop() : "") + ".csv"; },
    async save(target) {
      if (sel.tipo === "gruppo") throw new Error(tr("v_scidata.seleziona_dataset_variabile_tabella_esportare"));
      await api("fx", { op: "sci_export", path: ctx.path }, { json: { nome: sel.nome, out: target, fetta } });
      return { switchTo: false };
    },
  };
}

// grafico: linee (fino a 8 serie) o mappa di colore (viridis semplificata)
function drawChart(cv, g) {
  cv.hidden = !g;
  if (!g) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H = cv.clientHeight || 260;
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.body);
  const fg = css.getPropertyValue("--muted") || "#666", line = css.getPropertyValue("--line") || "#ddd";
  c.clearRect(0, 0, W, H);
  c.font = "11px " + css.getPropertyValue("--ui");
  const L = 56, R = 12, T = 12, B = 22;
  if (g.tipo === "serie") {
    let mn = Infinity, mx = -Infinity, len = 0;
    for (const s of g.serie) { len = Math.max(len, s.length); for (const v of s) if (v !== null) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    if (!isFinite(mn)) return;
    if (mn === mx) { mn -= 1; mx += 1; }
    const X = i => L + (W - L - R) * (len > 1 ? i / (len - 1) : 0.5), Y = v => T + (H - T - B) * (1 - (v - mn) / (mx - mn));
    c.strokeStyle = line; c.fillStyle = fg; c.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const v = mn + (mx - mn) * k / 4, y = Y(v); c.beginPath(); c.moveTo(L, y); c.lineTo(W - R, y); c.stroke(); c.fillText(fmt(v), 4, y + 4); }
    c.fillText(`indice 0 - ${fmt((len - 1) * g.passo)}${g.passo > 1 ? tr("v_scidata.punto_ogni_0", g.passo) : ""}`, L, H - 6);
    const colors = ["#2c6797", "#c4511f", "#2d7a46", "#946400", "#6b4fa0", "#b03a74", "#0e7c86", "#5b6470"];
    g.serie.forEach((s, j) => {
      c.strokeStyle = colors[j % colors.length]; c.lineWidth = 1.4; c.beginPath();
      let pen = false;
      s.forEach((v, i) => { if (v === null) { pen = false; return; } pen ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)); pen = true; });
      c.stroke();
    });
  } else {
    const { righe: rows, colonne: cols, min, max, valori } = g;
    const img = c.createImageData(cols, rows);
    for (let k = 0; k < valori.length; k++) {
      const v = valori[k];
      const [r, gg, b] = v === null ? [128, 128, 128] : viridis((v - min) / ((max - min) || 1));
      img.data[k * 4] = r; img.data[k * 4 + 1] = gg; img.data[k * 4 + 2] = b; img.data[k * 4 + 3] = 255;
    }
    const tmp = document.createElement("canvas");
    tmp.width = cols; tmp.height = rows;
    tmp.getContext("2d").putImageData(img, 0, 0);
    const s = Math.min((W - L - 80) / cols, (H - T - B) / rows);
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, L, T, cols * s, rows * s);
    // legenda
    const lx = L + cols * s + 16;
    for (let y = 0; y < H - T - B; y++) { const [r, gg, b] = viridis(1 - y / (H - T - B)); c.fillStyle = `rgb(${r},${gg},${b})`; c.fillRect(lx, T + y, 12, 1); }
    c.fillStyle = fg; c.fillText(fmt(max), lx + 16, T + 9); c.fillText(fmt(min), lx + 16, H - B);
    c.fillText(tr("v_scidata.0_1_campionata", rows, cols), L, H - 6);
  }
}

function viridis(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
}

function fmt(v) {
  if (typeof v !== "number" || !isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e9)) return v.toExponential(4);
  return (Math.round(v * 1e6) / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: 6 });
}
