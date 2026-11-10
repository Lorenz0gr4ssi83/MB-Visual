// Posa delle persone per il "Cambio posa" dell'editor di immagini: riconoscimento con MediaPipe Pose Landmarker (Apache-2.0,
// tutto nel PC: ui/vendor/mediapipe) e scheletro OpenPose a 18 punti da spostare a mano. Coordinate normalizzate 0-1.
import { t as tr } from "./i18n.js";
import { el } from "./core.js";

// OpenPose (COCO 18): 0 naso, 1 collo, 2-4 spalla/gomito/polso destri, 5-7 sinistri, 8-10 anca/ginocchio/caviglia destre,
// 11-13 sinistre, 14/15 occhio destro/sinistro, 16/17 orecchio destro/sinistro
export const LIMBS = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13],
  [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
export const COLORS = ["#ff0000", "#ff5500", "#ffaa00", "#ffff00", "#aaff00", "#55ff00", "#00ff00", "#00ff55", "#00ffaa", "#00ffff",
  "#00aaff", "#0055ff", "#0000ff", "#5500ff", "#aa00ff", "#ff00ff", "#ff00aa", "#ff0055"];
// MediaPipe (33 punti, "left" = sinistra della persona) -> OpenPose
const MP = { 0: 0, 2: 12, 3: 14, 4: 16, 5: 11, 6: 13, 7: 15, 8: 24, 9: 26, 10: 28, 11: 23, 12: 25, 13: 27, 14: 5, 15: 2, 16: 8, 17: 7 };

let landmarker = null;
async function getLandmarker() {
  if (landmarker) return landmarker;
  const vision = await import("/vendor/mediapipe/vision_bundle.mjs");
  const files = await vision.FilesetResolver.forVisionTasks("/vendor/mediapipe/wasm");
  landmarker = await vision.PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: "/vendor/mediapipe/pose_landmarker_full.task", delegate: "CPU" }, runningMode: "IMAGE", numPoses: 1,
  });
  return landmarker;
}

// punti OpenPose normalizzati (null = non visibile) oppure null se nessuna persona
export async function detectPose(canvas) {
  const lm = await getLandmarker();
  const r = lm.detect(canvas);
  const p = r?.landmarks?.[0];
  if (!p) return null;
  const v = i => (p[i].visibility ?? 1) > 0.3 ? [p[i].x, p[i].y] : null;
  const pts = Array.from({ length: 18 }, (_, k) => (k === 1 ? null : v(MP[k])));
  const ls = v(11), rs = v(12);
  pts[1] = ls && rs ? [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2] : ls || rs;
  return pts;
}

export function defaultPose() {
  return [[0.5, 0.15], [0.5, 0.25], [0.42, 0.25], [0.39, 0.38], [0.37, 0.5], [0.58, 0.25], [0.61, 0.38], [0.63, 0.5], [0.45, 0.52],
    [0.45, 0.7], [0.45, 0.88], [0.55, 0.52], [0.55, 0.7], [0.55, 0.88], [0.48, 0.13], [0.52, 0.13], [0.46, 0.14], [0.54, 0.14]];
}

// porta una posa presa da un'altra foto sull'ingombro della persona di questa (stessa altezza e centro)
export function fitPose(src, ref) {
  const box = ps => { const v = ps.filter(Boolean); if (!v.length) return null; const xs = v.map(p => p[0]), ys = v.map(p => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; };
  const a = box(src), b = ref && box(ref);
  if (!a || !b) return src;
  const k = (b.y1 - b.y0) / Math.max(1e-6, a.y1 - a.y0), cxa = (a.x0 + a.x1) / 2, cxb = (b.x0 + b.x1) / 2;
  return src.map(p => p && [cxb + (p[0] - cxa) * k, b.y0 + (p[1] - a.y0) * k]);
}

// editor: foto con lo scheletro sopra, punti da trascinare (clic destro su un punto = nascondi/mostra)
export function poseEditor(photo, initial) {
  let pts = initial.map(p => p && [...p]);
  const maxW = 560, maxH = Math.max(240, Math.min(460, innerHeight - 330)), k = Math.min(maxW / photo.width, maxH / photo.height);
  const cw = Math.round(photo.width * k), ch = Math.round(photo.height * k);
  const cv = el("canvas", { class: "imgai-posecv", width: cw, height: ch });
  const g = cv.getContext("2d");
  const hidden = new Map();
  const draw = () => {
    g.clearRect(0, 0, cw, ch); g.globalAlpha = 0.75; g.drawImage(photo, 0, 0, cw, ch); g.globalAlpha = 1;
    g.lineWidth = 4; g.lineCap = "round";
    LIMBS.forEach(([a, b], i) => { if (pts[a] && pts[b]) { g.strokeStyle = COLORS[i]; g.beginPath(); g.moveTo(pts[a][0] * cw, pts[a][1] * ch); g.lineTo(pts[b][0] * cw, pts[b][1] * ch); g.stroke(); } });
    pts.forEach((p, i) => { if (!p) return; g.fillStyle = COLORS[i]; g.strokeStyle = "#000"; g.lineWidth = 1.5; g.beginPath(); g.arc(p[0] * cw, p[1] * ch, 6, 0, 7); g.fill(); g.stroke(); });
  };
  let drag = -1;
  const at = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const near = q => { let best = -1, bd = 14 / cw; pts.forEach((p, i) => { if (p) { const d = Math.hypot(p[0] - q[0], (p[1] - q[1]) * ch / cw); if (d < bd) { bd = d; best = i; } } }); return best; };
  cv.addEventListener("pointerdown", e => {
    const q = at(e), i = near(q);
    if (e.button === 2) { // nascondi / rimetti il punto (parti non visibili nella posa)
      if (i >= 0) { hidden.set(i, pts[i]); pts[i] = null; }
      else { const [j] = [...hidden.keys()]; if (j !== undefined) { pts[j] = q; hidden.delete(j); } }
      draw(); return;
    }
    if (i >= 0) { drag = i; cv.setPointerCapture(e.pointerId); }
  });
  cv.addEventListener("pointermove", e => { if (drag >= 0) { const q = at(e); pts[drag] = [Math.min(1, Math.max(0, q[0])), Math.min(1, Math.max(0, q[1]))]; draw(); } });
  cv.addEventListener("pointerup", () => (drag = -1));
  cv.addEventListener("contextmenu", e => e.preventDefault());
  draw();
  return {
    el: el("div", { class: "imgai-posebox" }, cv, el("p", { class: "ps-note" }, tr("imgai.posa_aiuto"))),
    get: () => pts.map(p => p && [...p]),
    set: v => { pts = v.map(p => p && [...p]); draw(); },
  };
}
