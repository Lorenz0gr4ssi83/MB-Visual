// Misure sulle immagini (scansioni di tavole, foto, rilievi): stesse misure del PDF su un'immagine raster.
// Unita' del disegno = pixel dell'immagine; senza taratura le misure sono in millimetri di stampa ai dpi del file (96 se
// mancano). Scala da una quota nota (Taratura), 1:N (dai dpi) o per riquadro. Misure nel file .mbmis accanto all'immagine.
// Lo strato riceve il mouse solo con uno strumento attivo: l'editor di immagini resta com'e'.
import { el, loadCss, WEB } from "../core.js";
import { t as tr } from "../i18n.js";
import { createSession } from "./mpanel.js";
import { createEngine2d } from "./mtool.js";
import { mbmisStore } from "./mcad.js";

export async function attachImage(ctx, H) {
  loadCss("css/measure.css");
  const dpi = +(H.meta?.dpi?.[0] ?? H.meta?.dpi ?? 0) || 96;
  const store = mbmisStore(ctx);
  const overlay = el("canvas", { class: "mm-3d-overlay mm-img-overlay" });
  H.stage.append(overlay);
  const env = {
    space: "img", paged: true, host: H.stage, ctx, autosave: !WEB,
    base: { k: 25.4 / dpi, unit: "mm", label: tr("mis.carta_1_1"), none: true },
    paperM: () => 0.0254 / dpi, paperUnit: "px",
    tools: ["calib", "vp", "refelev", "len", "pline", "perim", "area", "hole", "vol", "ang", "rad", "elev", "count"],
    redraw: () => paint(),
    curPage: () => 0,
    focus: () => {},
    onTool: () => { sync(); paint(); },
    onPanel: () => { sync(); paint(); },
    persist: doc => store.persist(doc),
    extractors: [],
  };
  const M = createSession(env);
  const E = (M.engine = createEngine2d(M));
  M.doc.disp.unit = "m";
  const d0 = await store.load();
  if (d0) M.loadDoc(d0);
  // immagine: y verso il basso; nelle misure la y si inverte perche' le quote di livello crescano verso l'alto
  const surf = {
    page: 0, px: 1,
    toScreen: p => [H.panX + p[0] * H.zoom, H.panY - p[1] * H.zoom],
    toWorld: (x, y) => [(x - H.panX) / H.zoom, -(y - H.panY) / H.zoom],
    snap: () => null,
    redraw: () => paint(),
  };
  const sync = () => { overlay.style.pointerEvents = M.panel.open && M.tool ? "auto" : "none"; };
  function paint() {
    const r = H.stage.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (overlay.width !== Math.round(r.width * dpr) || overlay.height !== Math.round(r.height * dpr)) { overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr); }
    const g = overlay.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, overlay.width, overlay.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    E.paint(surf, g);
  }
  H.onPaint = paint;
  const pos = e => { const r = overlay.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  overlay.addEventListener("pointerdown", e => { if (E.down(surf, ...pos(e), e)) { e.preventDefault(); try { overlay.setPointerCapture(e.pointerId); } catch { /* */ } } });
  overlay.addEventListener("pointermove", e => E.move(surf, ...pos(e), e));
  overlay.addEventListener("pointerup", e => E.up(surf, ...pos(e), e));
  overlay.addEventListener("dblclick", e => E.dbl(surf, ...pos(e), e));
  overlay.addEventListener("contextmenu", e => { e.preventDefault(); E.context(); });
  const onKey = e => { if (ctx.tab.view?.isConnected && !ctx.tab.view.hidden && M.panel.open && !e.target.closest?.("input, textarea, select") && E.key(e)) { e.preventDefault(); e.stopPropagation(); } };
  window.addEventListener("keydown", onKey, true);
  sync();
  paint();
  return {
    M, E,
    get open() { return M.panel.open; },
    toggle: () => { M.panel.toggle(); sync(); paint(); },
    dispose() { M.flushSave?.().catch(() => {}); window.removeEventListener("keydown", onKey, true); H.onPaint = null; },
  };
}
