// Fogli di calcolo (SheetJS): tutti i fogli, modifica celle e formule, righe/colonne; salvataggio nel formato originale.
import { api, button, el, extOf, loadScript, readBytes, toast, withExt } from "../core.js";
import { describeKeys } from "../shortcuts.js";
import { LOCALE } from "../i18n.js";

const MAX_R = 3000, MAX_C = 200;
const WRITE = { xlsx: "xlsx", xlsm: "xlsm", xlsb: "xlsb", xls: "biff8", xltx: "xlsx", xltm: "xlsm", xlt: "biff8", ods: "ods",
  fods: "fods", csv: "csv", tsv: "csv", dif: "dif", slk: "sylk", sylk: "sylk", prn: "prn", dbf: "dbf" };

export async function mount(ctx) {
  await loadScript("/vendor/xlsx/dist/xlsx.full.min.js");
  const X = window.XLSX;
  const bytes = await readBytes(ctx.path);
  let sep = ",";
  let wb;
  if (ctx.ext === "csv" || ctx.ext === "tsv") {
    const text = new TextDecoder(bytes[0] === 0xef ? "utf-8" : detectEnc(bytes)).decode(bytes);
    const first = text.split(/\r?\n/, 1)[0];
    sep = ctx.ext === "tsv" ? "\t" : (first.split(";").length > first.split(",").length ? ";" : ",");
    wb = X.read(text, { type: "string", FS: sep, raw: true, dense: false });
  } else {
    wb = X.read(bytes, { type: "array", cellFormula: true, cellStyles: true, cellDates: true, cellNF: true, bookVBA: true });
  }
  let sheetName = wb.SheetNames[0];
  let sel = { r: 0, c: 0 };

  // ---- interfaccia
  const formulaBar = el("input", { type: "text", class: "field", id: "fx-" + ctx.tab.name, style: { flex: "1", minWidth: "200px", fontFamily: "var(--mono)" }, placeholder: "Valore o formula (es. =SOMMA(A1:A3) va scritta =SUM(A1:A3))" });
  const cellRef = el("span", { class: "note", style: { minWidth: "52px", fontFamily: "var(--mono)" } }, "A1");
  const tabsBar = el("div", { class: "tb", style: { borderTop: "1px solid var(--line)", borderBottom: "0" } });
  const gridBox = el("div", { style: { overflow: "auto", height: "100%" } });
  const layout = el("div", { style: { display: "grid", gridTemplateRows: "1fr auto", height: "100%", minHeight: 0 } }, gridBox, tabsBar);
  ctx.fillBody(true);
  ctx.el.append(layout);
  ctx.tb.append(cellRef, formulaBar,
    el("span", { class: "sep" }),
    button("Riga +", "plus", () => structural("row", 1), { title: "Inserisci una riga sotto la cella selezionata" }),
    button("Riga -", "trash", () => structural("row", -1), { title: "Elimina la riga selezionata" }),
    button("Colonna +", "plus", () => structural("col", 1), { title: "Inserisci una colonna a destra" }),
    button("Colonna -", "trash", () => structural("col", -1), { title: "Elimina la colonna selezionata" }),
    button("Nuovo foglio", "plus", () => { const n = "Foglio" + (wb.SheetNames.length + 1); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([[]]), n); sheetName = n; ctx.setDirty(true); render(); }));

  const ws = () => wb.Sheets[sheetName];
  const addr = (r, c) => X.utils.encode_cell({ r, c });

  function render() {
    tabsBar.innerHTML = "";
    for (const n of wb.SheetNames) tabsBar.append(el("button", { class: n === sheetName ? "on" : "", onclick: () => { sheetName = n; sel = { r: 0, c: 0 }; render(); } }, n));
    const s = ws();
    const ref = s["!ref"] ? X.utils.decode_range(s["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const nr = Math.min(ref.e.r + 6, MAX_R), nc = Math.min(ref.e.c + 4, MAX_C);
    const t = el("table", { class: "grid" });
    const head = el("tr", {}, el("th", {}, ""));
    for (let c = 0; c <= nc; c++) head.append(el("th", {}, X.utils.encode_col(c)));
    t.append(el("thead", {}, head));
    const tb = el("tbody");
    const merges = s["!merges"] || [];
    for (let r = 0; r <= nr; r++) {
      const tr = el("tr", {}, el("th", {}, String(r + 1)));
      for (let c = 0; c <= nc; c++) {
        const cell = s[addr(r, c)];
        const td = el("td", { "data-r": r, "data-c": c });
        if (cell) {
          td.textContent = cell.w !== undefined ? cell.w : cell.v !== undefined ? String(cell.v instanceof Date ? cell.v.toLocaleDateString(LOCALE) : cell.v) : cell.f ? "=" + cell.f : "";
          if (cell.t === "n") td.style.textAlign = "right";
          if (cell.f) td.title = "=" + cell.f;
        }
        const m = merges.find(m => m.s.r === r && m.s.c === c);
        if (m) { td.colSpan = m.e.c - m.s.c + 1; td.rowSpan = m.e.r - m.s.r + 1; }
        if (merges.some(m => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c && !(m.s.r === r && m.s.c === c))) continue;
        if (r === sel.r && c === sel.c) td.classList.add("sel");
        tr.append(td);
      }
      tb.append(tr);
    }
    t.append(tb);
    gridBox.innerHTML = "";
    gridBox.append(t);
    if (ref.e.r >= MAX_R || ref.e.c >= MAX_C) gridBox.append(el("p", { class: "note", style: { padding: "8px" } }, `Mostrate le prime ${MAX_R} righe e ${MAX_C} colonne; il file completo viene comunque salvato.`));
    showSel();
    ctx.status(`${sheetName} · ${ref.e.r + 1} righe × ${ref.e.c + 1} colonne`);
  }

  function showSel() {
    const cell = ws()[addr(sel.r, sel.c)];
    cellRef.textContent = addr(sel.r, sel.c);
    formulaBar.value = cell ? (cell.f ? "=" + cell.f : cell.v instanceof Date ? cell.v.toLocaleDateString(LOCALE) : cell.v ?? "") : "";
    gridBox.querySelectorAll("td.sel").forEach(x => x.classList.remove("sel"));
    gridBox.querySelector(`td[data-r="${sel.r}"][data-c="${sel.c}"]`)?.classList.add("sel");
  }

  const undoStack = [], redoStack = [];
  const rawOf = (r, c) => { const cell = ws()[addr(r, c)]; return cell ? (cell.f ? "=" + cell.f : cell.v instanceof Date ? cell.v.toLocaleDateString(LOCALE) : cell.v ?? "") : ""; };
  function setCell(r, c, raw, track = true) {
    if (track) { const old = rawOf(r, c); if (String(old) === String(raw ?? "")) return; undoStack.push([sheetName, r, c, old, raw]); redoStack.length = 0; }
    const s = ws();
    const a = addr(r, c);
    if (raw === "" || raw === null) { delete s[a]; }
    else if (String(raw).startsWith("=")) { s[a] = { t: "n", f: String(raw).slice(1), v: undefined }; }
    else {
      const num = String(raw).trim().replace(/\./g, "").replace(",", ".");
      const asNum = /^-?\d+(\.\d+)?$/.test(String(raw).trim()) ? Number(raw) : /^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+,\d+$/.test(String(raw).trim()) ? Number(num) : NaN;
      s[a] = isNaN(asNum) ? { t: "s", v: String(raw) } : { t: "n", v: asNum };
    }
    const ref = s["!ref"] ? X.utils.decode_range(s["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    ref.e.r = Math.max(ref.e.r, r);
    ref.e.c = Math.max(ref.e.c, c);
    s["!ref"] = X.utils.encode_range(ref);
    ctx.setDirty(true);
  }

  function structural(kind, dir) {
    const s = ws();
    const ref = X.utils.decode_range(s["!ref"] || "A1");
    const cells = {};
    for (const k of Object.keys(s)) if (k[0] !== "!") cells[k] = s[k];
    for (const k of Object.keys(cells)) delete s[k];
    for (const [k, v] of Object.entries(cells)) {
      const p = X.utils.decode_cell(k);
      const idx = kind === "row" ? p.r : p.c;
      const at = kind === "row" ? sel.r : sel.c;
      let ni = idx;
      if (dir > 0 && idx > at) ni = idx + 1;
      if (dir < 0) { if (idx === at) continue; if (idx > at) ni = idx - 1; }
      s[kind === "row" ? addr(ni, p.c) : addr(p.r, ni)] = v;
    }
    if (kind === "row") ref.e.r = Math.max(0, ref.e.r + dir); else ref.e.c = Math.max(0, ref.e.c + dir);
    s["!ref"] = X.utils.encode_range(ref);
    ctx.setDirty(true);
    render();
  }

  gridBox.addEventListener("click", e => {
    const td = e.target.closest("td[data-r]");
    if (!td) return;
    sel = { r: +td.dataset.r, c: +td.dataset.c };
    showSel();
  });
  // modifica nella cella, come Excel: doppio clic o F2 (testo attuale), oppure si comincia a scrivere (sostituisce)
  function editCell(initial, replace) {
    const td = gridBox.querySelector(`td[data-r="${sel.r}"][data-c="${sel.c}"]`);
    if (!td) return;
    const input = el("input", { type: "text", value: replace ? initial : rawOf(sel.r, sel.c), style: { width: Math.max(80, td.offsetWidth) + "px", font: "inherit", border: "0", outline: "2px solid var(--accent)" } });
    td.textContent = "";
    td.append(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let finished = false;
    const done = (ok, move) => {
      if (finished) return;
      finished = true;
      if (ok) setCell(sel.r, sel.c, input.value);
      render();
      if (move) { sel = { r: Math.max(0, sel.r + move[0]), c: Math.max(0, sel.c + move[1]) }; showSel(); }
      gridBox.focus();
    };
    input.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); done(true, ev.shiftKey ? [-1, 0] : [1, 0]); }
      else if (ev.key === "Tab") { ev.preventDefault(); done(true, ev.shiftKey ? [0, -1] : [0, 1]); }
      else if (ev.key === "Escape") { ev.preventDefault(); done(false); }
    });
    input.addEventListener("blur", () => done(true), { once: true });
  }
  gridBox.addEventListener("dblclick", e => { if (e.target.closest("td[data-r]")) editCell(); });
  formulaBar.addEventListener("keydown", e => { if (e.key === "Enter") { setCell(sel.r, sel.c, formulaBar.value); render(); sel.r++; showSel(); gridBox.focus(); } if (e.key === "Escape") { showSel(); gridBox.focus(); } });
  gridBox.tabIndex = 0;
  const used = () => X.utils.decode_range(ws()["!ref"] || "A1");
  const filled = (r, c) => { const v = ws()[addr(r, c)]; return !!v && v.v !== "" && v.v !== undefined || !!v?.f; };
  function jump(dr, dc) { // Ctrl+freccia: fino al bordo del blocco di dati (come Excel)
    const R = used();
    let { r, c } = sel;
    const inside = (rr, cc) => rr >= 0 && cc >= 0 && rr <= Math.max(R.e.r, 0) + 1 && cc <= Math.max(R.e.c, 0) + 1;
    const startFilled = filled(r, c) && inside(r + dr, c + dc) && filled(r + dr, c + dc);
    while (inside(r + dr, c + dc)) {
      r += dr; c += dc;
      if (startFilled ? !inside(r + dr, c + dc) || !filled(r + dr, c + dc) : filled(r, c)) break;
    }
    sel = { r: Math.max(0, r), c: Math.max(0, c) };
    showSel();
  }
  function undoRedo(from, to) {
    const it = from.pop();
    if (!it) return;
    const [sh, r, c, oldV, newV] = it;
    if (sh !== sheetName) { from.push(it); return toast("Annulla vale per il foglio in uso"); }
    setCell(r, c, from === undoStack ? oldV : newV, false);
    to.push(it);
    sel = { r, c };
    render();
  }
  gridBox.addEventListener("keydown", async e => {
    if (e.target !== gridBox) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const go = (r, c) => { e.preventDefault(); sel = { r: Math.max(0, r), c: Math.max(0, c) }; showSel(); };
    if (ctrl && k.startsWith("Arrow")) { e.preventDefault(); return jump(...{ ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }[k]); }
    const mv = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1], Enter: [e.shiftKey ? -1 : 1, 0], Tab: [0, e.shiftKey ? -1 : 1] }[k];
    if (mv) return go(sel.r + mv[0], sel.c + mv[1]);
    if (ctrl && k === "Home") return go(0, 0);
    if (ctrl && k === "End") { const R = used(); return go(R.e.r, R.e.c); }
    if (k === "Home") return go(sel.r, 0);
    if (k === "PageDown") return go(sel.r + 20, sel.c);
    if (k === "PageUp") return go(sel.r - 20, sel.c);
    if (k === "F2") { e.preventDefault(); return editCell(); }
    if (k === "Delete") { e.preventDefault(); setCell(sel.r, sel.c, ""); render(); return; }
    if (k === "Backspace") { e.preventDefault(); return editCell("", true); }
    if (ctrl && k.toLowerCase() === "z") { e.preventDefault(); return undoRedo(undoStack, redoStack); }
    if (ctrl && k.toLowerCase() === "y") { e.preventDefault(); return undoRedo(redoStack, undoStack); }
    if (ctrl && (k.toLowerCase() === "c" || k.toLowerCase() === "x")) {
      e.preventDefault();
      try { await navigator.clipboard.writeText(String(rawOf(sel.r, sel.c))); } catch { /* */ }
      if (k.toLowerCase() === "x") { setCell(sel.r, sel.c, ""); render(); }
      return;
    }
    if (ctrl && k.toLowerCase() === "v") {
      e.preventDefault();
      let t = "";
      try { t = await navigator.clipboard.readText(); } catch { return toast("Appunti non leggibili", true); }
      // testo a righe e colonne (da Excel o da un altro foglio): incolla a partire dalla cella selezionata
      t.replace(/\r?\n$/, "").split(/\r?\n/).forEach((line, i) => line.split("\t").forEach((v, j) => setCell(sel.r + i, sel.c + j, v)));
      render();
      return;
    }
    if (ctrl && k === ";") { e.preventDefault(); setCell(sel.r, sel.c, e.shiftKey ? new Date().toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }) : new Date().toLocaleDateString(LOCALE)); render(); return; }
    if (k.length === 1 && !ctrl && !e.altKey) { e.preventDefault(); editCell(k, true); }
  });
  describeKeys(ctx, "Excel", [
    ["Scrivere", "Sostituisce il contenuto della cella e inizia la modifica", "Celle"], ["F2", "Modifica la cella (testo attuale)", "Celle"],
    ["Invio / Maiusc+Invio", "Conferma e scende / sale", "Celle"], ["Tab / Maiusc+Tab", "Conferma e va a destra / sinistra", "Celle"],
    ["Esc", "Annulla la modifica", "Celle"], ["Canc", "Svuota la cella", "Celle"], ["Backspace", "Svuota e modifica", "Celle"],
    ["Ctrl+Z / Ctrl+Y", "Annulla / Ripeti", "Modifica"], ["Ctrl+C / Ctrl+X / Ctrl+V", "Copia / Taglia / Incolla (anche blocchi da Excel)", "Modifica"],
    ["Ctrl+;  /  Ctrl+Maiusc+;", "Data / ora di oggi", "Modifica"],
    ["Ctrl+frecce", "Salta al bordo dei dati", "Movimento"], ["Ctrl+Home / Ctrl+Fine", "Prima cella / ultima cella usata", "Movimento"],
    ["Home", "Inizio della riga", "Movimento"], ["Pag su / Pag giu'", "Su / giu' di 20 righe", "Movimento"],
  ]);
  render();

  const outExt = () => (WRITE[ctx.ext] ? ctx.ext : "xlsx");
  return {
    saveInPlace: !!WRITE[ctx.ext],
    saveAsName: () => withExt(ctx.name, outExt()),
    async save(target) {
      const ext = extOf(target);
      let data;
      if (ext === "csv" || ext === "tsv") {
        const text = X.utils.sheet_to_csv(ws(), { FS: ext === "tsv" ? "\t" : sep });
        data = new TextEncoder().encode("﻿" + text);
      } else {
        const bookType = WRITE[ext] || "xlsx";
        data = new Uint8Array(X.write(wb, { bookType, type: "array", compression: true, bookVBA: true }));
      }
      await api("save", { path: target }, { body: data });
      if (!WRITE[ext]) toast("Salvato in formato Excel XLSX");
    },
  };
}

function detectEnc(bytes) {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 200000)); return "utf-8"; } catch { return "windows-1252"; }
}
