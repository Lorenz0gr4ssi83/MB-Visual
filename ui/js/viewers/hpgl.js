// File di plotter HP-GL / HP-GL/2 (.plt, .hpgl, .hgl, .hpg): disegno vettoriale con penne, zoom, misura;
// esportazione SVG/PDF/PNG. Interprete in ui/js/hpgl.js (funziona anche nella web app; il PDF solo su PC).
import { api, button, el, loadCss, readBytes, saveBytes, WEB } from "../core.js";
import { DEFAULT_PENS, parseHpgl, toSvg } from "../hpgl.js";
import { t as tr, LOCALE } from "../i18n.js";

export async function mount(ctx) {
  loadCss("css/formati.css");
  const model = parseHpgl(await readBytes(ctx.path));
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  if (!model.prims.length) {
    ctx.el.append(el("div", { class: "fx-empty" }, model.raster
      ? tr("v_hpgl.file_contiene_immagine_raster_stampante")
      : tr("v_hpgl.file_non_ci_sono_comandi"),
    el("br"), el("br"), el("button", { class: "btn", onclick: () => ctx.openAs("text") }, tr("v_hpgl.apri_come_testo"))));
    return {};
  }
  const pens = {};
  for (const p of model.pens) pens[p] = { on: true, color: model.penColors[p] || DEFAULT_PENS[p] || "#000000" };
  // penna 0 / bianca su sfondo bianco: si mostra in nero (come fanno i programmi di anteprima dei plotter)
  for (const p of model.pens) if (/^#f{6}$/i.test(pens[p].color)) pens[p].color = "#000000";
  let dark = false, widths = true, zoom = 1, cx = 0, cy = 0, measuring = false, mpts = [], hover = null;

  const stage = el("div", { class: "plt-stage" });
  const cv = el("canvas");
  stage.append(cv);
  const penBox = el("div", { class: "plt-pens" });
  const left = el("div", { class: "fx-pane left" }, el("div", { class: "head" }, tr("v_hpgl.penne")), el("div", { class: "scroll" }, penBox));
  ctx.el.append(el("div", { class: "fx-split with-left" }, left, stage));

  const bMeasure = button(tr("v_hpgl.misura"), "ruler", () => { measuring = !measuring; mpts = []; bMeasure.classList.toggle("on", measuring); draw(); }, { title: tr("v_hpgl.due_clic_distanza_mm_foglio") });
  const bWidth = button(tr("v_hpgl.spessori"), null, () => { widths = !widths; bWidth.classList.toggle("on", widths); draw(); }, { title: tr("v_hpgl.mostra_spessori_reali_penne") });
  bWidth.classList.add("on");
  ctx.tb.append(button("", "fit", () => { fit(); draw(); }, { iconOnly: true, title: tr("v_hpgl.adatta_finestra") }),
    button("", "zoomIn", () => zoomAt(1.25), { iconOnly: true, title: tr("v_hpgl.ingrandisci") }), button("", "zoomOut", () => zoomAt(0.8), { iconOnly: true, title: tr("v_hpgl.riduci") }),
    el("span", { class: "sep" }), bMeasure, bWidth,
    button(tr("v_hpgl.sfondo"), "sun", () => { dark = !dark; stage.classList.toggle("dark", dark); draw(); }, { title: tr("v_hpgl.sfondo_chiaro_scuro") }),
    el("span", { class: "grow" }), el("span", { class: "note" }, sizeText()));

  function sizeText() {
    const [x0, y0, x1, y1] = model.bbox;
    return tr("v_hpgl.disegno_0_x_1_mm", fmt((x1 - x0) * model.unit), fmt((y1 - y0) * model.unit));
  }

  function renderPens() {
    penBox.innerHTML = "";
    for (const p of model.pens) {
      const st = pens[p];
      const color = el("input", { type: "color", value: st.color, title: tr("v_hpgl.colore_penna") });
      color.addEventListener("input", () => { st.color = color.value; draw(); });
      const chk = el("input", { type: "checkbox" });
      chk.checked = st.on;
      chk.addEventListener("change", () => { st.on = chk.checked; draw(); });
      const w = model.prims.find(x => x.pen === p && x.t === "l")?.w;
      penBox.append(el("label", {}, chk, color, tr("v_hpgl.penna_0", p), w ? el("span", { class: "fx-muted fx-small" }, `${fmt(w)} mm`) : null));
    }
  }

  const colorOf = p => (dark && /^#0{6}$/i.test(pens[p]?.color || "") ? "#e8e8e8" : pens[p]?.color || "#000");
  function view() { const r = stage.getBoundingClientRect(); return { W: Math.max(1, r.width), H: Math.max(1, r.height) }; }
  function fit() {
    const { W, H } = view();
    const [x0, y0, x1, y1] = model.bbox;
    zoom = Math.min(W / ((x1 - x0) || 1), H / ((y1 - y0) || 1)) * 0.94;
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
  }
  const toS = (x, y) => { const { W, H } = view(); return [W / 2 + (x - cx) * zoom, H / 2 - (y - cy) * zoom]; };
  const toW = (sx, sy) => { const { W, H } = view(); return [cx + (sx - W / 2) / zoom, cy - (sy - H / 2) / zoom]; };

  function paint(g, T, scale) {
    // T: (x,y)->[sx,sy]; scale = pixel per unita' plotter
    g.lineCap = "round"; g.lineJoin = "round";
    for (const p of model.prims) {
      if (!pens[p.pen]?.on) continue;
      const col = colorOf(p.pen);
      if (p.t === "l") {
        g.strokeStyle = col;
        g.lineWidth = widths ? Math.max(1, p.w / model.unit * scale) : 1;
        g.setLineDash(p.dash && p.dash[0] ? [Math.max(2, p.dash[1] * 0.6 / model.unit * scale), Math.max(2, p.dash[1] * 0.4 / model.unit * scale)] : []);
        g.beginPath();
        for (let k = 0; k < p.pts.length; k += 2) { const [x, y] = T(p.pts[k], p.pts[k + 1]); k ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke();
      } else if (p.t === "f") {
        g.fillStyle = col;
        g.beginPath();
        for (const r of p.rings) { for (let k = 0; k < r.length; k += 2) { const [x, y] = T(r[k], r[k + 1]); k ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); }
        g.fill("evenodd");
      } else {
        const fs = p.h * 1.35 * scale;
        if (fs < 1.5) continue;
        const [x, y] = T(p.x, p.y);
        g.save();
        g.translate(x, y); g.rotate(-p.ang);
        g.fillStyle = col; g.font = `${fs}px Arial, sans-serif`;
        g.textAlign = [1, 2, 3, 11, 12, 13].includes(p.lo) ? "left" : [4, 5, 6, 14, 15, 16].includes(p.lo) ? "center" : "right";
        g.fillText(p.text, 0, 0);
        g.restore();
      }
    }
    g.setLineDash([]);
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1, { W, H } = view();
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = dark ? "#1c1f22" : "#ffffff"; g.fillRect(0, 0, W, H);
    paint(g, toS, zoom);
    if (mpts.length) {
      const pts = [...mpts, ...(mpts.length === 1 && hover ? [hover] : [])].map(p => toS(p[0], p[1]));
      g.strokeStyle = "#e07a00"; g.fillStyle = "#e07a00"; g.lineWidth = 1.5;
      g.beginPath(); pts.forEach((p, k) => (k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
      pts.forEach(p => g.fillRect(p[0] - 3, p[1] - 3, 6, 6));
      if (pts.length === 2) {
        const a = mpts[0], b = mpts[1] || hover;
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]) * model.unit;
        const t = `${fmt(d)} mm`;
        g.font = "12px sans-serif";
        const w = g.measureText(t).width + 10;
        g.fillStyle = "rgba(0,0,0,.7)"; g.fillRect(pts[1][0] + 8, pts[1][1] - 20, w, 20);
        g.fillStyle = "#ffd23f"; g.fillText(t, pts[1][0] + 13, pts[1][1] - 6);
      }
    }
    const pos = hover ? `x ${fmt(hover[0] * model.unit)}  y ${fmt(hover[1] * model.unit)} mm · ` : "";
    ctx.status(tr("v_hpgl.0_1_elementi_2_penne", pos, model.prims.length, model.pens.length, fmt(zoom / (model.unit * 96 / 25.4) * 100)));
  }
  function zoomAt(f, sx, sy) {
    const { W, H } = view();
    if (sx === undefined) { sx = W / 2; sy = H / 2; }
    const before = toW(sx, sy);
    zoom = Math.max(1e-5, Math.min(1000, zoom * f));
    const after = toW(sx, sy);
    cx += before[0] - after[0]; cy += before[1] - after[1];
    draw();
  }

  let drag = null;
  stage.addEventListener("wheel", e => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY / 400), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  stage.addEventListener("pointerdown", e => {
    const r = stage.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (measuring && e.button === 0) { const p = toW(sx, sy); mpts = mpts.length >= 2 ? [p] : [...mpts, p]; draw(); return; }
    try { stage.setPointerCapture(e.pointerId); } catch { /* */ }
    drag = { sx, sy, cx, cy };
  });
  stage.addEventListener("pointermove", e => {
    const r = stage.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    hover = toW(sx, sy);
    if (drag) { cx = drag.cx - (sx - drag.sx) / zoom; cy = drag.cy + (sy - drag.sy) / zoom; }
    draw();
  });
  stage.addEventListener("pointerup", () => { drag = null; });
  new ResizeObserver(() => { if (!ctx.tab.view.hidden) { if (!drag) fit(); draw(); } }).observe(stage);

  const svgText = () => toSvg(model, p => colorOf(p), p => pens[p]?.on, { background: dark ? "#1c1f22" : null });
  function png() {
    const [x0, y0, x1, y1] = model.bbox;
    const s = Math.min(8000 / ((x1 - x0) || 1), 8000 / ((y1 - y0) || 1), 300 / 25.4 * model.unit); // 300 dpi, max 8000 px
    const m = 20;
    const c = document.createElement("canvas");
    c.width = Math.round((x1 - x0) * s + 2 * m); c.height = Math.round((y1 - y0) * s + 2 * m);
    const g = c.getContext("2d");
    g.fillStyle = dark ? "#1c1f22" : "#fff"; g.fillRect(0, 0, c.width, c.height);
    paint(g, (x, y) => [m + (x - x0) * s, m + (y1 - y) * s], s);
    return c;
  }

  renderPens();
  fit();
  draw();
  return {
    saveInPlace: false,
    saveFormats: WEB ? ["svg", "png"] : ["pdf", "svg", "png"],
    saveLabels: { pdf: tr("v_hpgl.pdf_vettoriale_dimensioni_reali"), svg: tr("v_hpgl.svg_vettoriale_mm"), png: tr("v_hpgl.immagine_300_dpi") },
    async save(target) {
      const ext = target.split(".").pop().toLowerCase();
      if (ext === "svg") await saveBytes(target, new TextEncoder().encode(svgText()));
      else if (ext === "pdf") await api("fx", { op: "svg_pdf" }, { json: { svg: svgText(), out: target } });
      else if (ext === "png") { const b = await new Promise(r => png().toBlob(r, "image/png")); await saveBytes(target, new Uint8Array(await b.arrayBuffer())); }
      else throw new Error(tr("v_hpgl.formato_non_previsto"));
      return { switchTo: false };
    },
    onShow() { draw(); },
  };
}

function fmt(v) { return (Math.round(v * 100) / 100).toLocaleString(LOCALE); }
