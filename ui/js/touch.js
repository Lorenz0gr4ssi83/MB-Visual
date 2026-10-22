// Tablet e telefoni (iPad, Android): tocco, penna e tastiera virtuale.
// - classi su <html>: "touch" (schermo tattile come puntatore principale), "ipad", "standalone" (app installata)
// - tocco lungo = clic destro (Safari su iPad non manda "contextmenu"; Chrome su Android si')
// - tastiera virtuale: l'app si restringe all'area visibile (visualViewport) e il campo attivo resta in vista
// - pinchPan: pizzico per lo zoom e due dita per spostare sui disegni fatti su canvas (CAD, immagini, confronto)
// - afterMount: pulsante "Pannello" per i pannelli laterali a scomparsa dei visualizzatori (.side)
import { el, loadCss } from "./core.js";
import { t } from "./i18n.js";

const mq = q => { try { return matchMedia(q).matches; } catch { return false; } };
export const IS_IPAD = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const isTouch = () => mq("(pointer: coarse)") || (navigator.maxTouchPoints > 0 && !mq("(any-pointer: fine)"));

let inited = false;
export function initTouch() {
  if (inited) return;
  inited = true;
  const root = document.documentElement;
  const apply = () => {
    root.classList.toggle("touch", isTouch());
    root.classList.toggle("ipad", IS_IPAD);
    root.classList.toggle("standalone", mq("(display-mode: standalone)") || navigator.standalone === true);
  };
  apply();
  try { matchMedia("(pointer: coarse)").addEventListener("change", apply); } catch { /* */ }
  if (navigator.maxTouchPoints > 0 || isTouch()) loadCss("css/touch.css");
  longPress();
  keyboard();
}

// ---------------------------------------------------------------- tocco lungo = clic destro
function longPress() {
  let timer = 0, start = null, native = false, fired = false;
  const clear = () => { clearTimeout(timer); timer = 0; };
  addEventListener("contextmenu", e => { if (e.isTrusted && start) native = true; }, true);
  addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch" || !e.isPrimary) { clear(); start = null; return; }
    if (e.target.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], .no-longpress")) return;
    start = { x: e.clientX, y: e.clientY, target: e.target, id: e.pointerId };
    native = fired = false;
    clear();
    timer = setTimeout(() => {
      timer = 0;
      if (!start || native) return;
      fired = true;
      navigator.vibrate?.(12);
      start.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y, button: 2, buttons: 2, view: window }));
    }, 560);
  }, true);
  addEventListener("pointermove", e => { if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) { clear(); start = null; } }, true);
  const end = e => { if (start && e.pointerId === start.id) { clear(); start = null; } };
  addEventListener("pointerup", end, true);
  addEventListener("pointercancel", end, true);
  // il clic che segue un tocco lungo non deve anche attivare l'elemento sotto il dito
  addEventListener("click", e => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); } }, true);
  // un secondo dito annulla il tocco lungo
  addEventListener("touchstart", e => { if (e.touches.length > 1) { clear(); start = null; } }, { capture: true, passive: true });
}

// ---------------------------------------------------------------- tastiera virtuale
function keyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let base = innerHeight;
  const update = () => {
    // con la tastiera aperta l'area visibile e' piu' bassa della finestra: l'app si adatta a quella parte
    const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    const open = kb > 80 && document.activeElement?.matches?.("input, textarea, select, [contenteditable]");
    root.classList.toggle("kb-open", !!open);
    root.style.setProperty("--app-h", open ? vv.height + "px" : "100%");
    root.style.setProperty("--kb", open ? kb + "px" : "0px");
    if (open) { if (scrollY) scrollTo(0, 0); reveal(); }
    if (!open) base = innerHeight;
  };
  const reveal = () => {
    const a = document.activeElement;
    if (!a?.getBoundingClientRect) return;
    const r = a.getBoundingClientRect();
    if (r.bottom > vv.height - 8 || r.top < 0) a.scrollIntoView({ block: "center", inline: "nearest" });
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  addEventListener("focusin", () => setTimeout(update, 320));
  addEventListener("focusout", () => setTimeout(update, 120));
  void base;
}

// ---------------------------------------------------------------- pizzico e due dita sui canvas
// Il primo dito resta al visualizzatore (sposta, seleziona, disegna); con il secondo dito il gesto passa qui:
// onStart() deve annullare l'operazione del visualizzatore, poi onPan(dx, dy) e onZoom(fattore, x, y) in pixel CSS
// relativi all'elemento. Gli eventi dei dita durante il gesto non arrivano al visualizzatore.
export function pinchPan(target, { onStart, onPan, onZoom, onEnd } = {}) {
  const pts = new Map();
  let active = false, last = null;
  const local = e => { const r = target.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const state = () => {
    const p = [...pts.values()];
    const c = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
    return { c, d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) };
  };
  const swallow = e => { e.stopImmediatePropagation(); e.preventDefault(); };
  target.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") return;
    pts.set(e.pointerId, local(e));
    if (pts.size === 2 && !active) {
      active = true;
      onStart?.();
      last = state();
      swallow(e);
    } else if (active) swallow(e);
  }, true);
  target.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (!active) return;
    swallow(e);
    if (pts.size < 2) return;
    const s = state();
    if (last.d > 0 && s.d > 0) { const f = s.d / last.d; if (Math.abs(f - 1) > 0.002) onZoom?.(f, s.c[0], s.c[1]); }
    const dx = s.c[0] - last.c[0], dy = s.c[1] - last.c[1];
    if (dx || dy) onPan?.(dx, dy);
    last = s;
  }, true);
  const up = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!active) return;
    swallow(e);
    if (pts.size === 2) last = state();
    if (!pts.size) { active = false; onEnd?.(); }
  };
  target.addEventListener("pointerup", up, true);
  target.addEventListener("pointercancel", up, true);
  return { get active() { return active; } };
}

// ---------------------------------------------------------------- pannelli laterali a scomparsa
// Sul tablet il pannello a sinistra dei visualizzatori (layer, albero, elenco) diventa un cassetto: in verticale parte
// chiuso e si apre sopra il documento, in orizzontale resta affiancato e si puo' chiudere per avere tutto lo spazio.
const ICON_PANEL = '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3zM9 5v14"/></svg>';
export function afterMount(ctx) {
  if (!document.documentElement.classList.contains("touch")) return;
  if (Math.min(innerWidth, innerHeight) < 600) return; // telefono: resta la disposizione per schermi stretti di app.css
  // pannello a sinistra: layer/albero/elenco (.side), livelli della mappa (.gis), elenco delle differenze (.cmp-root)
  const SEL = ".side, .gis, .cmp-root";
  const side = ctx.el.querySelector(SEL);
  if (!side) {
    // visualizzatori che costruiscono la pagina dopo il caricamento: si aspetta il pannello per qualche secondo
    const mo = new MutationObserver(() => { if (ctx.el.querySelector(SEL)) { mo.disconnect(); afterMount(ctx); } });
    mo.observe(ctx.el, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);
    return;
  }
  if (side.dataset.drawer || ctx.el.querySelector(".ps-root, .pb-root, .vs-root, .ve-root")) return;
  side.dataset.drawer = "1";
  side.classList.add("drawer");
  const narrow = () => innerWidth < 1100 || innerHeight > innerWidth;
  const set = open => { side.classList.toggle("drawer-open", open); side.classList.toggle("drawer-closed", !open); b.classList.toggle("on", open); };
  const b = el("button", { type: "button", class: "drawer-btn", title: t("touch.pannello") });
  b.insertAdjacentHTML("beforeend", ICON_PANEL);
  b.addEventListener("click", () => set(!side.classList.contains("drawer-open")));
  ctx.tb.prepend(b);
  set(!narrow());
  // in verticale un tocco sul documento chiude il cassetto aperto sopra
  side.addEventListener("pointerdown", e => {
    if (narrow() && side.classList.contains("drawer-open") && !side.firstElementChild.contains(e.target)) set(false);
  }, true);
  let wasNarrow = narrow();
  addEventListener("resize", () => { const n = narrow(); if (n !== wasNarrow) { wasNarrow = n; set(!n); } });
}
