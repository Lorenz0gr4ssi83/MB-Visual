// Pannelli laterali dei visualizzatori (.side, mappa, confronto): larghezza da trascinare e pannello richiudibile del tutto,
// ricordati per tipo di visualizzatore. Solo con il mouse: tablet e telefono hanno i loro cassetti (touch.js, phone.js).
import { t } from "./i18n.js";

const SEL = ".side, .gis, .cmp-root";
const MIN = 150, CLOSE_BELOW = 90;
const load = k => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };
const CHEV = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';

function enhance(box, key) {
  box.dataset.sp = "1";
  const right = box.classList.contains("solidcad"); // SolidWorks e simili: il pannello sta a destra
  const panel = right ? box.lastElementChild : box.firstElementChild;
  if (!panel) return;
  // colonne com'erano: serve la larghezza iniziale e l'eventuale terza colonna del confronto IFC
  const cols = (box.style.gridTemplateColumns || getComputedStyle(box).gridTemplateColumns).trim().split(/\s+(?![^(]*\))/);
  const initial = parseFloat(cols[right ? cols.length - 1 : 0]) || 264;
  const saved = load(key);
  let width = saved.w >= MIN ? saved.w : initial, open = saved.closed !== true;
  const grip = document.createElement("div");
  grip.className = "sp-grip";
  grip.title = t("sidepanel.trascina");
  const tog = document.createElement("button");
  tog.type = "button";
  tog.className = "sp-toggle";
  tog.innerHTML = CHEV;
  box.classList.add("sp-box");
  if (right) box.classList.add("sp-right");
  box.append(grip, tog);
  const apply = () => {
    const w = open ? width : 0;
    box.style.gridTemplateColumns = right ? `minmax(0, 1fr) ${w}px` : `${w}px minmax(0, 1fr)${box.classList.contains("with-detail") ? " 360px" : ""}`;
    box.style.setProperty("--sp-w", w + "px");
    box.classList.toggle("sp-closed", !open);
    tog.title = t(open ? "sidepanel.chiudi" : "sidepanel.apri");
    tog.setAttribute("aria-expanded", String(open));
    grip.hidden = !open;
  };
  const save = () => store(key, { w: Math.round(width), closed: !open });
  apply();
  tog.addEventListener("click", () => { open = !open; apply(); save(); });
  grip.addEventListener("dblclick", () => { open = false; apply(); save(); });
  grip.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("on");
    const r = box.getBoundingClientRect();
    const move = ev => {
      const w = right ? r.right - ev.clientX : ev.clientX - r.left;
      width = Math.max(MIN, Math.min(r.width * 0.7, w));
      open = w >= CLOSE_BELOW; // portato quasi a zero si chiude, come chiudendolo col pulsante
      apply();
    };
    const up = () => { grip.removeEventListener("pointermove", move); grip.classList.remove("on"); save(); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
}

// da chiamare a ogni visualizzatore montato: tiene d'occhio anche i pannelli costruiti dopo (vista 3D dei DWG, modello dentro SolidWorks)
export function attachSidePanels(root, viewer) {
  const html = document.documentElement.classList;
  if (html.contains("touch") || html.contains("phone") || root.dataset.spRoot) return;
  root.dataset.spRoot = "1";
  let timer = 0;
  const scan = () => {
    timer = 0;
    // il modello 3D mostrato dentro un altro visualizzatore ha il suo pannello, ricordato a parte
    [...root.querySelectorAll(SEL)].forEach((box, i) => { if (!box.dataset.sp && !box.closest(".ps-root, .pb-root, .vs-root, .ve-root")) enhance(box, `mbv-pannello-${viewer}-${i}`); });
  };
  scan();
  new MutationObserver(() => { if (!timer) timer = setTimeout(scan, 80); }).observe(root, { childList: true, subtree: true });
}
