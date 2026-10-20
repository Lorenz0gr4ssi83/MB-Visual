// Fogli di calcolo (SheetJS): tutti i fogli, modifica celle e formule, righe/colonne; salvataggio nel formato originale.
import { api, button, el, extOf, loadScript, readBytes, toast, withExt } from "../core.js";

const MAX_R = 3000, MAX_C = 200;
const WRITE = { xlsx: "xlsx", xlsm: "xlsm", xlsb: "xlsb", xls: "biff8", xltx: "xlsx", xltm: "xlsm", xlt: "biff8", ods: "ods",
  fods: "fods", csv: "csv", tsv: "csv", dif: "dif", slk: "sylk", sylk: "sylk", prn: "prn", dbf: "dbf" };

export async function mount(ctx) {
  await loadScript(window.MBV_ROOT + "vendor/xlsx/dist/xlsx.full.min.js");
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
          td.textContent = cell.w !== undefined ? cell.w : cell.v !== undefined ? String(cell.v instanceof Date ? cell.v.toLocaleDateString("it-IT") : cell.v) : cell.f ? "=" + cell.f : "";
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
    formulaBar.value = cell ? (cell.f ? "=" + cell.f : cell.v instanceof Date ? cell.v.toLocaleDateString("it-IT") : cell.v ?? "") : "";
    gridBox.querySelectorAll("td.sel").forEach(x => x.classList.remove("sel"));
    gridBox.querySelector(`td[data-r="${sel.r}"][data-c="${sel.c}"]`)?.classList.add("sel");
  }

  function setCell(r, c, raw) {
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
  gridBox.addEventListener("dblclick", e => {
    const td = e.target.closest("td[data-r]");
    if (!td) return;
    const input = el("input", { type: "text", value: formulaBar.value, style: { width: Math.max(80, td.offsetWidth) + "px", font: "inherit", border: "0", outline: "2px solid var(--accent)" } });
    td.textContent = "";
    td.append(input);
    input.focus();
    const done = ok => { if (ok) setCell(sel.r, sel.c, input.value); render(); };
    input.addEventListener("keydown", ev => { if (ev.key === "Enter") { done(true); sel.r++; showSel(); } if (ev.key === "Escape") done(false); });
    input.addEventListener("blur", () => done(true), { once: true });
  });
  formulaBar.addEventListener("keydown", e => { if (e.key === "Enter") { setCell(sel.r, sel.c, formulaBar.value); render(); } });
  gridBox.tabIndex = 0;
  gridBox.addEventListener("keydown", e => {
    if (e.target !== gridBox) return;
    const mv = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1], Enter: [1, 0], Tab: [0, 1] }[e.key];
    if (mv) { e.preventDefault(); sel = { r: Math.max(0, sel.r + mv[0]), c: Math.max(0, sel.c + mv[1]) }; showSel(); return; }
    if (e.key === "Delete") { setCell(sel.r, sel.c, ""); render(); return; }
    if (e.key.length === 1 && !e.ctrlKey) { formulaBar.value = ""; formulaBar.focus(); }
  });
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
