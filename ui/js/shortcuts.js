// Scorciatoie da tastiera dei visualizzatori/editor, con gli stessi tasti dei programmi originali
// (Photoshop, Acrobat, Excel, Premiere/VLC, AutoCAD...). Valgono solo nella linguetta visibile e non mentre si
// scrive in un campo; l'elenco finisce in tab.shortcuts e si mostra con F1 (app.js).
//
//   keymap(ctx, "Photoshop", [{ keys: "Ctrl+Z", desc: "Annulla", run: () => ... }, ...])
//   keys: "C", "Ctrl+Alt+I", "Shift+U", "Space", "ArrowLeft", "Ctrl+Plus", "F2", "Delete", "Escape", "Enter", "[", "]"
//   piu' combinazioni per la stessa azione: "Ctrl+Y|Ctrl+Shift+Z"

const NAMES = { space: " ", plus: "+", minus: "-", esc: "escape", del: "delete", canc: "delete" };
function parse(combo) {
  const parts = combo.split("+").filter(Boolean);
  const key = parts.pop() || (combo.endsWith("+") ? "+" : "");
  const mods = new Set(parts.map(p => p.toLowerCase()));
  const k = key.toLowerCase();
  return { ctrl: mods.has("ctrl"), alt: mods.has("alt"), shift: mods.has("shift"), key: NAMES[k] ?? k };
}
function matches(p, e) {
  let k = (e.key || "").toLowerCase();
  if (k === "=" && p.key === "+") k = "+"; // Ctrl++ senza Maiusc
  if (k === "_" && p.key === "-") k = "-";
  const shiftOk = p.shift === e.shiftKey || (!p.shift && (p.key === "+" || p.key === "?") );
  return k === p.key && p.ctrl === (e.ctrlKey || e.metaKey) && p.alt === e.altKey && shiftOk;
}
const TYPING = "input, textarea, select, [contenteditable=''], [contenteditable=true], [contenteditable=plaintext-only], .monaco-editor";

export function keymap(ctx, program, defs, target = window) {
  const list = defs.map(d => ({ ...d, combos: d.keys.split("|").map(parse) }));
  const onKey = e => {
    const view = ctx.tab?.view;
    if (view && !view.isConnected) { target.removeEventListener("keydown", onKey, true); return; } // linguetta chiusa
    if (view?.hidden || e.defaultPrevented) return;
    const modal = document.getElementById("modal");
    if (modal && !modal.hidden) return;
    const t = e.target;
    if (t?.closest?.(TYPING) && !list.some(d => d.inFields && d.combos.some(p => matches(p, e)))) return;
    for (const d of list) {
      if (d.when && !d.when()) continue;
      if (d.combos.some(p => matches(p, e))) { e.preventDefault(); e.stopPropagation(); d.run(e); return; }
    }
  };
  target.addEventListener("keydown", onKey, true);
  if (ctx.tab) ctx.tab.shortcuts = { program, list: [...(ctx.tab.shortcuts?.list || []), ...defs.map(d => ({ keys: pretty(d.keys), desc: d.desc, group: d.group || "" }))] };
  return () => target.removeEventListener("keydown", onKey, true);
}

// nomi dei tasti: restano quelli delle combinazioni ("Ctrl+Shift+Z", piu' combinazioni separate da "|"); F1 (app.js)
// li mostra con i nomi della lingua scelta (chiavi keys.* in ui/i18n: Maiusc/Invio/Canc in italiano, Shift/Enter/Del in inglese)
const ARROWS = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Plus: "+", Minus: "-" };
const pretty = keys => keys.split("|").map(c => c.split("+").map(k => ARROWS[k] || k).join("+")).join(" | ");

// solo elenco (scorciatoie gestite altrove, es. dentro ONLYOFFICE o Monaco)
export function describeKeys(ctx, program, rows) {
  if (ctx.tab) ctx.tab.shortcuts = { program, list: [...(ctx.tab.shortcuts?.list || []), ...rows.map(([keys, desc, group]) => ({ keys, desc, group: group || "" }))] };
}
