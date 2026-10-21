// Pubblicazioni: comandi dell'editor usati dalla barra multifunzione e dai tasti (pagine, pagine master, immagini,
// tabelle, WordArt, blocchi predefiniti, intestazioni, trova e sostituisci, ortografia, stampa unione, modelli).
import { el, toast, modal, askText, pickFiles, readBytes, api, extOf, baseName, loadScript, confirmBox, WEB, pickSavePath, saveBytes } from "./core.js";
import { MM, CM, FIELD, S, COLOR_SCHEMES, FONT_SCHEMES, FONTS, color, newId, walk, allItems, cloneItems, textBox, imageBox, wordArt, tableBox, newPage, makeStory, storyText, charPart, styleChars, copyStory } from "./pubmodel.js";
import { computeLayouts, drawPage, CanvasPainter, aabb } from "./pubrender.js";
import { caretPos, paraBounds, wordBounds, insertText, deleteRange, styleAt, setCharStyle } from "./pubtext.js";
import { TEMPLATES } from "./pubtemplates.js";
import { renderObjectsPng } from "./pubexport.js";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const NATIVE = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "svg", "avif", "ico"]);
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon" };

export function installCommands(E, ctx) {
  const doc = () => E.doc();
  const sel = () => E.sel();
  const one = () => (sel().length === 1 ? sel()[0] : null);
  const content = () => { const D = doc(), M = D.margins; return { x: M.l, y: M.t, w: D.w - M.l - M.r, h: D.h - M.t - M.b }; };

  // ------------------------------------------------------------ pagine
  E.addPage = (dup = false) => {
    const D = doc();
    if (E.masterId()) E.toggleMaster();
    const src = D.pages[E.cur()];
    const p = newPage(D, src.master);
    if (dup) { p.items = cloneItems(D, src.items); p.guides = JSON.parse(JSON.stringify(src.guides)); p.bg = src.bg ? { ...src.bg } : null; }
    D.pages.splice(E.cur() + 1, 0, p);
    E.setCurPage(E.cur() + 1);
    E.selectNone();
    E.commit(dup ? "Inserisci pagina duplicata" : "Inserisci pagina");
    E.fitPage(); E.renderThumbs();
  };
  E.insertPages = (n, where, what) => {
    const D = doc();
    if (E.masterId()) E.toggleMaster();
    const src = D.pages[E.cur()];
    let at = E.cur() + (where === "after" ? 1 : 0);
    const first = at;
    for (let k = 0; k < n; k++) {
      const p = newPage(D, src.master);
      if (what === "dup") p.items = cloneItems(D, src.items);
      if (what === "text") { const c = content(); p.items.push(textBox(D, c.x, c.y, c.w, c.h, [["", "Corpo del testo"]])); }
      D.pages.splice(at++, 0, p);
    }
    E.setCurPage(first); E.selectNone();
    E.commit(n > 1 ? `Inserisci ${n} pagine` : "Inserisci pagina");
    E.fitPage(); E.renderThumbs();
  };
  E.deletePage = async (i) => {
    const D = doc();
    if (D.pages.length < 2) return toast("Una pubblicazione deve avere almeno una pagina", true);
    const p = D.pages[i];
    if (p.items.length && !(await confirmBox("Elimina pagina", `La pagina ${i + 1} contiene ${p.items.length} oggetti. Eliminarla?`, "Elimina", true))) return E.focus();
    // il testo delle caselle collegate continua nelle altre caselle della catena
    const ids = new Set([...walk(p.items)].map(o => o.id));
    for (const x of walk(p.items)) if (x.type === "text") { const prev = allItems(D).find(y => y.type === "text" && y.next === x.id && !ids.has(y.id)); if (prev) { let nx = x.next; while (nx && ids.has(nx)) nx = allItems(D).find(z => z.id === nx)?.next; prev.next = nx || null; } }
    D.pages.splice(i, 1);
    E.selectNone();
    E.setCurPage(Math.min(E.cur(), D.pages.length - 1));
    E.commit("Elimina pagina");
    E.fitPage(); E.renderThumbs();
    E.focus();
  };
  E.movePage = (from, to) => {
    const D = doc();
    if (from === to || from < 0 || to < 0 || from >= D.pages.length || to >= D.pages.length) return;
    const [p] = D.pages.splice(from, 1);
    D.pages.splice(to, 0, p);
    E.setCurPage(to); E.selectNone();
    E.commit("Sposta pagina");
    E.renderThumbs();
  };
  E.gotoPageDlg = async () => {
    const v = await askText("Vai a pagina", `Numero di pagina (1-${doc().pages.length})`, String(E.cur() + 1));
    if (v) E.gotoPage((parseInt(v) || 1) - 1);
    E.focus();
  };
  E.applyMaster = id => { const p = E.page(); if (!p) return; p.master = id; E.commit("Applica pagina master"); E.renderThumbs(); };
  E.addMaster = (dup = false) => {
    const D = doc();
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const id = [...letters].find(l => !D.masters.some(m => m.id === l)) || newId(D, "M");
    const srcM = D.masters.find(m => m.id === E.masterId()) || D.masters[0];
    D.masters.push({ id, name: "Pagina master " + id, items: dup && srcM ? cloneItems(D, srcM.items) : [] });
    E.toggleMaster(id);
    E.commit("Aggiungi pagina master");
  };
  E.deleteMaster = () => {
    const D = doc();
    if (D.masters.length < 2) return;
    const id = E.masterId();
    D.masters = D.masters.filter(m => m.id !== id);
    for (const p of D.pages) if (p.master === id) p.master = D.masters[0].id;
    E.toggleMaster(D.masters[0].id);
    E.commit("Elimina pagina master");
  };

  // ------------------------------------------------------------ impostazione della pagina
  E.setPageSize = (w, h) => { const D = doc(); D.w = w; D.h = h; E.commit("Dimensioni pagina"); E.fitPage(); E.renderThumbs(); };
  E.setOrientation = o => { const D = doc(); if ((o === "o") !== (D.w > D.h)) E.setPageSize(D.h, D.w); };
  E.setMargins = v => { doc().margins = { l: v, t: v, r: v, b: v }; E.commit("Margini"); };
  E.setGrid = (cols, rows) => { const D = doc(); D.grid = { cols, rows, gap: D.grid?.gap || 0.2 * 72 }; E.commit("Guide del layout"); };
  E.addGuide = dir => { const p = E.page(); if (!p) return; (dir === "v" ? p.guides.v : p.guides.h).push(dir === "v" ? doc().w / 2 : doc().h / 2); E.commit("Aggiungi guida"); };
  E.clearGuides = () => { const p = E.page(); if (!p) return; p.guides = { v: [], h: [] }; E.commit("Elimina guide"); };
  E.setBackground = bg => { const p = E.page(); if (!p) return; p.bg = bg; E.commit("Sfondo pagina"); };
  E.backgroundAll = () => { const bg = E.page()?.bg || null; for (const p of doc().pages) p.bg = bg ? { ...bg } : null; E.commit("Sfondo su tutte le pagine"); };
  E.backgroundImage = async () => { const id = await pickImageId(); if (id) E.setBackground({ img: id }); };
  E.setScheme = s => { doc().scheme = { name: s.name, c: [...s.c] }; E.commit("Combinazione colori " + s.name); E.renderThumbs(); };
  E.setFonts = f => { doc().fonts = { ...f }; E.commit("Combinazione caratteri " + f.name); E.renderThumbs(); };

  // ------------------------------------------------------------ immagini
  async function decode(bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    if (mime === "image/svg+xml") {
      // SVG: si converte in PNG ad alta risoluzione (serve anche per il PDF)
      const url = URL.createObjectURL(blob);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("SVG non leggibile")); i.src = url; });
      const k = Math.max(1, 2000 / Math.max(img.naturalWidth || 300, img.naturalHeight || 300));
      const c = document.createElement("canvas");
      c.width = Math.round((img.naturalWidth || 300) * k); c.height = Math.round((img.naturalHeight || 300) * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const png = await new Promise(r => c.toBlob(r, "image/png"));
      return { bytes: new Uint8Array(await png.arrayBuffer()), mime: "image/png", w: c.width, h: c.height };
    }
    const bmp = await createImageBitmap(blob);
    const r = { bytes, mime, w: bmp.width, h: bmp.height };
    bmp.close?.();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
      // BMP, AVIF, ICO...: in PNG, cosi' anche il PDF li legge
      const c = document.createElement("canvas"); c.width = r.w; c.height = r.h;
      c.getContext("2d").drawImage(await createImageBitmap(blob), 0, 0);
      const png = await new Promise(rr => c.toBlob(rr, "image/png"));
      return { bytes: new Uint8Array(await png.arrayBuffer()), mime: "image/png", w: r.w, h: r.h };
    }
    return r;
  }
  async function addImage(bytes, mime, name) {
    const im = await decode(bytes, mime);
    const id = newId(doc(), "i");
    doc().images[id] = { ...im, name };
    return id;
  }
  async function readImageFile(path) {
    const ext = extOf(path);
    if (NATIVE.has(ext)) return { bytes: await readBytes(path), mime: MIME[ext] || "image/png" };
    if (WEB) throw new Error("Formato immagine non supportato nella web app: usa PNG, JPG, GIF o WEBP");
    const r = await api("image", { path });
    return { bytes: await readBytes(r.path), mime: "image/png" };
  }
  async function pickImageId() {
    const paths = await pickFiles();
    if (!paths?.length) { E.focus(); return null; }
    try { const f = await readImageFile(paths[0]); return await addImage(f.bytes, f.mime, baseName(paths[0])); }
    catch (e) { toast("Immagine non leggibile: " + e.message, true); return null; }
  }
  function coverCrop(o, im) {
    const fa = o.w / Math.max(0.01, o.h), ia = im.w / im.h;
    if (ia > fa) { const sw = im.h * fa; o.img = { id: o.img.id, sx: (im.w - sw) / 2, sy: 0, sw, sh: im.h }; }
    else { const sh = im.w / fa; o.img = { id: o.img.id, sx: 0, sy: (im.h - sh) / 2, sw: im.w, sh }; }
  }
  E.placeImageBytes = async (bytes, mime, name, target = null) => {
    let id;
    try { id = await addImage(bytes, mime, name); } catch (e) { toast("Immagine non leggibile: " + e.message, true); return; }
    const im = doc().images[id];
    const t = target || (one()?.type === "image" ? one() : null);
    if (t) { t.img = { id }; coverCrop(t, im); E.commit("Inserisci immagine"); return; }
    const c = content();
    let w = im.w * 0.75, h = im.h * 0.75; // 96 dpi
    const k = Math.min(1, (c.w * 0.8) / w, (c.h * 0.6) / h);
    w *= k; h *= k;
    const o = imageBox(doc(), (doc().w - w) / 2, (doc().h - h) / 2, w, h, { img: { id, sx: 0, sy: 0, sw: im.w, sh: im.h } });
    E.addObj(o);
    E.commit("Inserisci immagine");
  };
  E.insertPicture = async () => {
    const paths = await pickFiles();
    if (!paths?.length) return E.focus();
    for (const p of paths) {
      try { const f = await readImageFile(p); await E.placeImageBytes(f.bytes, f.mime, baseName(p)); }
      catch (e) { toast(baseName(p) + ": " + e.message, true); }
    }
    E.focus();
  };
  E.insertPlaceholder = () => {
    const c = content(), w = Math.min(c.w * 0.5, 8 * CM), h = w * 0.75;
    E.addObj(imageBox(doc(), (doc().w - w) / 2, (doc().h - h) / 2, w, h));
    E.commit("Inserisci segnaposto immagine");
  };
  E.changePicture = async () => {
    const o = one();
    if (!o || o.type !== "image") return E.insertPicture();
    const id = await pickImageId();
    if (!id) return;
    o.img = { id };
    coverCrop(o, doc().images[id]);
    E.commit("Cambia immagine");
    E.focus();
  };
  E.resetPicture = () => {
    for (const o of sel()) {
      if (o.type !== "image" || !o.img) continue;
      const im = doc().images[o.img.id];
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      o.fx = {}; o.flipH = false; o.flipV = false;
      o.img = { id: o.img.id, sx: 0, sy: 0, sw: im.w, sh: im.h };
      o.h = o.w * im.h / im.w; o.x = cx - o.w / 2; o.y = cy - o.h / 2;
    }
    E.commit("Reimposta immagine");
  };
  E.fitPicture = mode => {
    for (const o of sel()) {
      if (o.type !== "image" || !o.img) continue;
      const im = doc().images[o.img.id];
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      if (mode === "fill") coverCrop(o, im);
      else {
        // l'immagine intera nella cornice (la cornice prende le proporzioni dell'immagine)
        const k = mode === "fit" ? Math.min(o.w / im.w, o.h / im.h) : o.w / im.w;
        o.w = im.w * k; o.h = im.h * k; o.x = cx - o.w / 2; o.y = cy - o.h / 2;
        o.img = { id: o.img.id, sx: 0, sy: 0, sw: im.w, sh: im.h };
      }
    }
    E.commit(mode === "fill" ? "Riempi" : mode === "fit" ? "Adatta" : "Togli ritaglio");
  };
  E.saveSelectionImage = async () => {
    if (!sel().length) return;
    const png = await renderObjectsPng(E, sel(), 200);
    const path = await pickSavePath("immagine.png", "");
    if (!path) return E.focus();
    await saveBytes(path, png);
    toast("Salvato: " + baseName(path));
    E.focus();
  };

  // ------------------------------------------------------------ tabelle
  E.insertTable = (rows, cols) => {
    const c = content();
    const w = cols <= 3 ? Math.min(c.w, cols * 3.5 * CM) : c.w;
    const t = tableBox(doc(), c.x + (c.w - w) / 2, c.y + c.h / 3, rows, cols, w, 22);
    E.addObj(t);
    E.commit("Inserisci tabella");
    E.beginEdit(t, 0, "cell", 0, 0);
  };
  const tableNow = () => { const ed = E.edit(); if (ed?.kind === "cell") return { t: ed.o, r: ed.r, c: ed.c, ed: true }; const o = one(); return o?.type === "table" ? { t: o, r: o.rows - 1, c: o.cols - 1, ed: false } : null; };
  function cellLike(D, cell) {
    const st = D.stories[cell.story];
    const ch = st.chars[0];
    const id = newId(D, "t");
    D.stories[id] = { id, chars: [{ c: "\n", s: ch.s, p: st.chars[st.chars.length - 1].p }] };
    return { story: id, fill: cell.fill, valign: cell.valign };
  }
  E.tableOp = (op, v) => {
    const T = tableNow();
    if (!T) return toast("Seleziona una tabella o fai clic in una cella", true);
    const { t } = T;
    let { r, c } = T;
    const D = doc();
    switch (op) {
      case "rowAbove": case "rowBelow": {
        const at = op === "rowAbove" ? r : r + 1;
        t.cells.splice(at, 0, t.cells[r].map(cell => cellLike(D, cell)));
        t.rowH.splice(at, 0, t.rowH[r]); t.rows++;
        if (T.ed) E.beginEdit(t, 0, "cell", at, c);
        break;
      }
      case "colLeft": case "colRight": {
        const at = op === "colLeft" ? c : c + 1, total = t.colW.reduce((a, b) => a + b, 0);
        t.cells.forEach(row => row.splice(at, 0, cellLike(D, row[c])));
        t.colW.splice(at, 0, t.colW[c]); t.cols++;
        const k = total / t.colW.reduce((a, b) => a + b, 0);
        t.colW = t.colW.map(x => x * k);
        if (T.ed) E.beginEdit(t, 0, "cell", r, at);
        break;
      }
      case "delRow": if (t.rows < 2) return E.tableOp("delTable"); E.endEdit(); t.cells.splice(r, 1); t.rowH.splice(r, 1); t.rows--; E.setSel([t]); break;
      case "delCol": if (t.cols < 2) return E.tableOp("delTable"); E.endEdit(); t.cells.forEach(row => row.splice(c, 1)); { const w = t.colW.splice(c, 1)[0]; t.colW = t.colW.map(x => x + w / t.colW.length); } t.cols--; E.setSel([t]); break;
      case "delTable": E.endEdit(); E.setSel([t]); E.deleteSel(); return;
      case "distRows": { const hs = t._rowsH || t.rowH; const avg = hs.reduce((a, b) => a + b, 0) / t.rows; t.rowH = t.rowH.map(() => avg); break; }
      case "distCols": { const avg = t.colW.reduce((a, b) => a + b, 0) / t.cols; t.colW = t.colW.map(() => avg); break; }
      case "colW": if (v > 0) t.colW[c] = v; break;
      case "rowH": if (v > 0) t.rowH[r] = v; break;
      case "valign": for (const cell of T.ed ? [t.cells[r][c]] : t.cells.flat()) cell.valign = v; break;
    }
    E.commit({ rowAbove: "Inserisci riga", rowBelow: "Inserisci riga", colLeft: "Inserisci colonna", colRight: "Inserisci colonna", delRow: "Elimina riga", delCol: "Elimina colonna" }[op] || "Tabella");
  };
  E.tableStyle = preset => {
    const T = tableNow();
    if (!T) return;
    const { t } = T, D = doc();
    t.cells.forEach((row, r) => row.forEach(cell => {
      const head = r === 0 && preset !== "plain";
      cell.fill = head ? "s1" : preset === "banded" && r % 2 === 0 ? "s1:15" : preset === "grid" && r % 2 === 0 ? "s1:8" : "none";
      const st = D.stories[cell.story];
      setCharStyle(st, 0, st.chars.length, {});
      st.chars = st.chars.map(ch => ({ ...ch, s: S({ ...ch.s, c: head ? "s5" : "s0", b: head || undefined }) }));
    }));
    t.border = preset === "header" ? { c: "s1", w: 0.5 } : preset === "plain" ? { c: "s0", w: 0.5 } : preset === "banded" ? { c: "none", w: 0 } : { c: "s1:60", w: 0.75 };
    E.commit("Formato tabella");
  };

  // ------------------------------------------------------------ WordArt
  async function wordArtDlg(o) {
    const D = doc();
    const t = el("textarea", { class: "field", rows: 3, style: { width: "100%", fontSize: "18px" } });
    t.value = o?.text || "Il tuo testo";
    const f = el("select", { class: "field" }, ...[["+t", `${D.fonts.t} (Titoli)`], ["+b", `${D.fonts.b} (Corpo)`], ...FONTS.map(x => [x, x])].map(([v, l]) => el("option", { value: v, selected: (o?.font || "+t") === v }, l)));
    const b = el("input", { type: "checkbox", checked: o ? !!o.b : true }), i = el("input", { type: "checkbox", checked: !!o?.i });
    setTimeout(() => { t.focus(); t.select(); });
    const ok = await modal("Modifica testo WordArt", el("div", { class: "pb-dlg" }, t, el("label", { class: "pb-dlgrow" }, el("span", {}, "Carattere"), f), el("label", { class: "pb-dlgrow" }, el("span", {}, "Grassetto"), b), el("label", { class: "pb-dlgrow" }, el("span", {}, "Corsivo"), i)),
      [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    return ok ? { text: t.value.replace(/\s+/g, " ").trim() || "Testo", font: f.value, b: b.checked, i: i.checked } : null;
  }
  E.insertWordArt = async st => {
    const r = await wordArtDlg(null);
    if (!r) return E.focus();
    const c = content();
    const h = 60, w = Math.min(c.w, Math.max(120, r.text.length * 32));
    const o = wordArt(doc(), r.text, (doc().w - w) / 2, c.y + 20, w, st.form === "arco" || st.form === "arcoGiu" ? h * 1.8 : st.form === "onda" ? h * 1.4 : h, { ...st, label: undefined, ...r });
    delete o.label;
    E.addObj(o);
    E.commit("Inserisci WordArt");
    E.focus();
  };
  E.editWordArt = async () => {
    const o = one();
    if (!o || o.type !== "wordart") return;
    const r = await wordArtDlg(o);
    if (r) { Object.assign(o, r); E.commit("Modifica WordArt"); }
    E.focus();
  };

  // ------------------------------------------------------------ blocchi predefiniti
  E.insertBlock = (objs, label) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of objs) { const b = aabb(o); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    const D = doc();
    const full = label === "Cornice pagina";
    const dx = full ? 0 : (D.w - (x1 - x0)) / 2 - x0, dy = full ? 0 : (D.h - (y1 - y0)) / 2 - y0;
    for (const o of objs) E.moveObj(o, dx, dy);
    if (objs.length > 1) {
      const g = { id: newId(D, "o"), type: "group", items: objs, x: x0 + dx, y: y0 + dy, w: x1 - x0, h: y1 - y0, rot: 0, wrap: "none" };
      E.addObj(g);
    } else E.addObj(objs[0]);
    E.commit("Inserisci " + label);
  };

  // ------------------------------------------------------------ testo
  E.insertField = f => {
    if (!E.edit()) return toast("Fai clic nel testo dove inserire il campo", true);
    E.insertFieldChar(f);
  };
  E.clearFormat = () => {
    const D = doc();
    for (const t of E.textTargets()) {
      for (let k = t.a; k < Math.max(t.b, t.a + 1) && k < t.st.chars.length; k++) {
        const [, pe] = paraBounds(t.st, k);
        const def = D.styles[t.st.chars[pe].p?.st] || D.styles["Normale"];
        t.st.chars[k] = { ...t.st.chars[k], s: S(charPart(def)) };
      }
    }
    E.commit("Cancella formattazione");
  };
  E.copyFormat = () => {
    const o = one();
    if (E.edit() || (o && (o.type === "text" || o.type === "table"))) E.fmtClip = { kind: "text", s: E.charStyle(), p: E.paraStyle() };
    else if (o) E.fmtClip = { kind: "obj", props: { fill: o.fill, line: o.line ? { ...o.line } : null, shadow: o.shadow, opacity: o.opacity } };
    else return;
    E.message("Formato copiato: selezionate il testo o l'oggetto e usate Incolla formato (Ctrl+Maiusc+V)");
    E.refresh();
  };
  E.pasteFormat = () => {
    const f = E.fmtClip;
    if (!f) return toast("Prima copia un formato (Copia formato)", true);
    if (f.kind === "text") { E.applyChar(() => ({ ...f.s }), "Incolla formato"); if (f.p) E.applyPara(() => ({ ...f.p }), "Incolla formato"); }
    else { for (const o of sel()) Object.assign(o, JSON.parse(JSON.stringify(f.props))); E.commit("Incolla formato"); }
  };
  E.changeCase = mode => {
    const ed = E.edit();
    let targets = E.textTargets();
    if (ed && ed.caret === ed.anchor) { const st = doc().stories[ed.story]; const [a, b] = wordBounds(st, ed.caret); targets = [{ st, a, b }]; }
    for (const t of targets) {
      const txt = t.st.chars.slice(t.a, t.b).map(c => c.c).join("");
      const m = mode || (txt === txt.toUpperCase() ? "low" : txt === txt.toLowerCase() ? "cap" : "up");
      let prevSpace = true, sentence = true;
      for (let k = t.a; k < t.b; k++) {
        const ch = t.st.chars[k];
        if (ch.c === FIELD) continue;
        let c = ch.c;
        if (m === "up") c = c.toUpperCase();
        else if (m === "low") c = c.toLowerCase();
        else if (m === "cap") c = prevSpace ? c.toUpperCase() : c.toLowerCase();
        else if (m === "sent") c = sentence && /\p{L}/u.test(c) ? c.toUpperCase() : c.toLowerCase();
        if (/\p{L}/u.test(c)) sentence = false;
        if (/[.!?\n]/.test(ch.c)) sentence = true;
        prevSpace = /[\s\n\u2028-]/.test(ch.c);
        if (c !== ch.c) t.st.chars[k] = { ...ch, c };
      }
    }
    E.commit("Maiuscole/minuscole");
  };
  E.hyperlink = async () => {
    const ed = E.edit();
    if (!ed || ed.caret === ed.anchor) return toast("Seleziona il testo da collegare", true);
    const cur = E.charStyle()?.h || "https://";
    const url = await askText("Inserisci collegamento ipertestuale", "Indirizzo (vuoto = rimuovi collegamento)", cur);
    E.focus();
    if (url === null) return;
    if (!url.trim() || url === "https://") E.applyChar(s => ({ ...s, h: undefined, u: undefined }), "Rimuovi collegamento");
    else E.applyChar(s => ({ ...s, h: /^[a-z]+:/i.test(url) ? url.trim() : (url.includes("@") ? "mailto:" : "https://") + url.trim(), u: true, c: "s1" }), "Collegamento ipertestuale");
  };
  E.dropCap = () => {
    const o = E.edit()?.o || one();
    if (!o || o.type !== "text") return;
    const st = doc().stories[o.story];
    const k = st.chars.findIndex(c => /\p{L}|\p{N}/u.test(c.c));
    if (k < 0) return;
    const s = st.chars[k].s;
    const on = s.dc;
    st.chars[k] = { ...st.chars[k], s: S(on ? { ...s, z: s.dc, dc: undefined, b: undefined, c: s.dcC } : { ...s, dc: s.z || 10, dcC: s.c, z: (s.z || 10) * 3, b: true, c: "s1" }) };
    E.commit(on ? "Togli capolettera" : "Capolettera");
  };
  E.headerFooter = kind => {
    const D = doc();
    const mid = E.page()?.master || D.masters[0]?.id;
    if (!mid) return;
    if (E.page() && !E.page().master) E.page().master = mid;
    if (E.masterId() !== mid) E.toggleMaster(mid);
    const m = D.masters.find(x => x.id === mid);
    const role = kind === "h" ? "header" : "footer";
    let o = m.items.find(x => x.role === role);
    if (!o) {
      const M = D.margins, h = 22;
      const y = kind === "h" ? Math.max(4, M.t - h - 4) : D.h - M.b + 4;
      o = textBox(D, M.l, y, D.w - M.l - M.r, h, [["", "Normale", { a: kind === "h" ? "l" : "c", z: 9, c: "s2" }]], { role, pad: [0, 2, 0, 2] });
      m.items.push(o);
      E.commit(kind === "h" ? "Intestazione" : "Pie' di pagina");
    }
    E.setSel([o]);
    E.beginEdit(o);
  };
  E.pageNumberOnMaster = pos => {
    const D = doc();
    const mid = E.page()?.master || D.masters[0].id;
    if (E.page() && !E.page().master) E.page().master = mid;
    const m = D.masters.find(x => x.id === mid);
    const M = D.margins, w = 80, h = 20;
    const x = pos[1] === "r" ? D.w - M.r - w : pos[1] === "l" ? M.l : (D.w - w) / 2;
    const y = pos[0] === "b" ? D.h - M.b + 4 : Math.max(4, M.t - h - 4);
    m.items.push(textBox(D, x, y, w, h, [["{pagina}", "Normale", { a: pos[1] === "r" ? "r" : pos[1] === "l" ? "l" : "c", z: 9 }]], { pad: [0, 2, 0, 2], role: "pagenum" }));
    E.commit("Numero di pagina");
    E.message(`Numero di pagina aggiunto alla pagina master ${mid}: compare su tutte le pagine che la usano`);
  };
  E.insertTextFile = async () => {
    const paths = await pickFiles();
    if (!paths?.length) return E.focus();
    const p = paths[0], ext = extOf(p);
    let text;
    try {
      const bytes = await readBytes(p);
      if (ext === "docx") {
        await loadScript("/vendor/mammoth/mammoth.browser.min.js");
        text = (await window.mammoth.extractRawText({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })).value;
      } else {
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = new TextDecoder("windows-1252").decode(bytes); }
        if (ext === "md") text = text.replace(/^#+\s*/gm, "").replace(/\*\*|__/g, "");
      }
    } catch (e) { return toast("File non leggibile: " + e.message, true); }
    text = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const ed = E.edit();
    if (ed) { const st = doc().stories[ed.story]; ed.caret = ed.anchor = insertText(st, Math.min(ed.caret, ed.anchor), text, styleAt(st, ed.caret)); E.commit("Inserisci file"); return E.focus(); }
    let o = one()?.type === "text" ? one() : null;
    if (o) { const st = doc().stories[o.story]; insertText(st, st.chars.length - 1, (st.chars.length > 1 ? "\n" : "") + text, styleAt(st, st.chars.length - 1)); }
    else { const c = content(); o = textBox(doc(), c.x, c.y, c.w, c.h, text.split("\n").map(t => [t, "Corpo del testo"]), { cols: doc().grid?.cols > 1 ? doc().grid.cols : 1, gap: doc().grid?.gap || 12 }); E.addObj(o); }
    E.commit("Inserisci file di testo");
    await autoFlow(o);
    E.focus();
  };
  // testo che non ci sta: come Publisher propone di creare pagine con caselle collegate
  async function autoFlow(o) {
    let lay = E.relayout();
    let ent = lay.frames.get(o.id);
    if (!ent?.layout.overflow) return;
    if (!(await confirmBox("Il testo non ci sta", "Il testo non entra nella casella. Aggiungere automaticamente pagine con caselle di testo collegate?", "Aggiungi pagine"))) return;
    const D = doc();
    let last = lay.byId.get(ent.layout.chain[ent.layout.chain.length - 1]);
    let pi = E.pageOfObj(last);
    for (let k = 0; k < 60 && ent.layout.overflow; k++) {
      const c = content();
      const p = newPage(D, D.pages[pi]?.master ?? "A");
      const f = textBox(D, c.x, c.y, c.w, c.h, [["", "Normale"]], { cols: o.cols, gap: o.gap });
      delete D.stories[f.story];
      f.story = last.story; f.next = last.next || null; last.next = f.id;
      p.items.push(f);
      D.pages.splice(++pi, 0, p);
      E.touch();
      lay = E.relayout(); ent = lay.frames.get(o.id); last = f;
    }
    E.commit("Testo su piu' pagine");
    E.renderThumbs();
  }

  // ------------------------------------------------------------ trova e sostituisci
  let findBox = null;
  function stories() {
    const D = doc(), lay = E.relayout(), out = [], seen = new Set();
    D.pages.forEach(p => {
      for (const o of walk(p.items)) {
        if (o.type === "text" && !seen.has(o.story)) { seen.add(o.story); const ent = lay.frames.get(o.id); out.push({ id: o.story, o: ent ? lay.byId.get(ent.layout.chain[0]) : o, kind: "frame" }); }
        if (o.type === "table") o.cells.forEach((row, r) => row.forEach((cell, c) => out.push({ id: cell.story, o, kind: "cell", r, c })));
      }
    });
    return out;
  }
  function findNext(q, opt, fromStart = false) {
    if (!q) return false;
    const list = stories();
    const ed = E.edit();
    let si = ed ? list.findIndex(s => s.id === ed.story) : 0;
    if (si < 0) si = 0;
    let off = ed && !fromStart ? Math.max(ed.caret, ed.anchor) : 0;
    const norm = t => (opt.case ? t : t.toLowerCase());
    const needle = norm(q);
    for (let n = 0; n <= list.length; n++) {
      const s = list[(si + n) % list.length];
      const st = doc().stories[s.id];
      if (!st) continue;
      const arr = st.chars.map(c => (c.c === "\u2028" ? "\n" : c.c));
      const hay = norm(arr.join(""));
      let k = hay.indexOf(needle, n === 0 ? off : 0);
      while (k >= 0 && opt.word && (/[\p{L}\p{N}]/u.test(hay[k - 1] || "") || /[\p{L}\p{N}]/u.test(hay[k + needle.length] || ""))) k = hay.indexOf(needle, k + 1);
      if (k >= 0) {
        E.selectText(s.id, k, k + needle.length, s.o, s.kind, s.r, s.c);
        return true;
      }
      off = 0;
    }
    return false;
  }
  E.openFind = (replace) => {
    findBox?.remove();
    const q = el("input", { type: "text", class: "field", placeholder: "Trova" });
    const rep = el("input", { type: "text", class: "field", placeholder: "Sostituisci con" });
    const cs = el("input", { type: "checkbox" }), ww = el("input", { type: "checkbox" });
    const opt = () => ({ case: cs.checked, word: ww.checked });
    const info = el("div", { class: "pb-findinfo" });
    const next = () => { info.textContent = findNext(q.value, opt()) ? "" : "Nessuna corrispondenza trovata"; };
    const replaceOne = () => {
      const ed = E.edit();
      if (ed && ed.caret !== ed.anchor) {
        const st = doc().stories[ed.story];
        const a = Math.min(ed.caret, ed.anchor), b = Math.max(ed.caret, ed.anchor);
        const cur = st.chars.slice(a, b).map(c => c.c).join("");
        if ((opt().case ? cur : cur.toLowerCase()) === (opt().case ? q.value : q.value.toLowerCase())) {
          const s = st.chars[a].s;
          deleteRange(st, a, b);
          ed.caret = ed.anchor = insertText(st, a, rep.value, s);
          E.commit("Sostituisci");
        }
      }
      next();
    };
    const replaceAll = () => {
      let n = 0;
      const needle = opt().case ? q.value : q.value.toLowerCase();
      if (!needle) return;
      E.endEdit();
      for (const s of stories()) {
        const st = doc().stories[s.id];
        for (let k = 0; k < st.chars.length;) {
          const hay = st.chars.slice(k, k + needle.length).map(c => c.c).join("");
          if ((opt().case ? hay : hay.toLowerCase()) === needle && (!opt().word || (!/[\p{L}\p{N}]/u.test(st.chars[k - 1]?.c || "") && !/[\p{L}\p{N}]/u.test(st.chars[k + needle.length]?.c || "")))) {
            const sty = st.chars[k].s;
            deleteRange(st, k, k + needle.length);
            k = insertText(st, k, rep.value, sty);
            n++;
          } else k++;
        }
      }
      if (n) E.commit(`Sostituisci tutto (${n})`);
      info.textContent = n ? `Sostituzioni effettuate: ${n}` : "Nessuna corrispondenza trovata";
    };
    q.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); next(); } if (e.key === "Escape") close(); });
    rep.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); replaceOne(); } if (e.key === "Escape") close(); });
    const close = () => { findBox?.remove(); findBox = null; E.focus(); };
    findBox = el("div", { class: "pb-find" },
      el("div", { class: "pb-findhead" }, el("b", {}, replace ? "Trova e sostituisci" : "Trova"), el("button", { type: "button", class: "pb-x", title: "Chiudi (Esc)", onclick: close }, "×")),
      q, replace ? rep : null,
      el("label", { class: "pb-check" }, cs, el("span", {}, "Maiuscole/minuscole")), el("label", { class: "pb-check" }, ww, el("span", {}, "Solo parole intere")),
      el("div", { class: "pb-findbtns" }, el("button", { type: "button", class: "btn primary", onclick: next }, "Trova successivo"),
        replace ? el("button", { type: "button", class: "btn", onclick: replaceOne }, "Sostituisci") : null, replace ? el("button", { type: "button", class: "btn", onclick: replaceAll }, "Sostituisci tutto") : null),
      info);
    E._pb.stage.append(findBox);
    const ed = E.edit();
    if (ed && ed.caret !== ed.anchor) q.value = doc().stories[ed.story].chars.slice(Math.min(ed.caret, ed.anchor), Math.max(ed.caret, ed.anchor)).map(c => c.c).join("");
    setTimeout(() => { q.focus(); q.select(); });
  };

  // ------------------------------------------------------------ ortografia (dizionario di WebView2 in italiano)
  E.spell = async () => {
    const ed = E.edit();
    let target = ed ? { id: ed.story, o: ed.o, kind: ed.kind, r: ed.r, c: ed.c } : null;
    const list = stories();
    if (!target) { const o = one(); target = o?.type === "text" ? list.find(s => s.id === o.story) : list[0]; }
    if (!target) return toast("Non c'e' testo da controllare", true);
    const st = doc().stories[target.id];
    const old = st.chars.slice(0, -1).map(c => c.c);
    const ta = el("textarea", { class: "field pb-spell", spellcheck: "true", lang: "it" });
    ta.value = old.join("");
    const k = list.findIndex(s => s.id === target.id);
    const ok = await modal(`Controllo ortografia (storia ${k + 1} di ${list.length})`, el("div", { class: "pb-dlg" },
      el("p", { class: "pb-note" }, "Le parole sconosciute sono sottolineate in rosso: fai clic destro su una parola per i suggerimenti, correggi e premi Applica. La formattazione del testo resta quella originale."), ta),
    [{ label: "Annulla", value: 0 }, { label: "Applica", value: 1, primary: true }, list.length > 1 ? { label: "Applica e passa alla successiva", value: 2 } : null].filter(Boolean));
    setTimeout(() => ta.focus());
    if (ok) {
      const nw = Array.from(ta.value);
      let p = 0;
      while (p < old.length && p < nw.length && old[p] === nw[p]) p++;
      let s = 0;
      while (s < old.length - p && s < nw.length - p && old[old.length - 1 - s] === nw[nw.length - 1 - s]) s++;
      if (p < old.length - s || p < nw.length - s) {
        const sty = st.chars[Math.min(p, st.chars.length - 1)].s;
        E.endEdit();
        deleteRange(st, p, old.length - s);
        insertText(st, p, nw.slice(p, nw.length - s).join(""), sty);
        E.commit("Correzione ortografica");
      }
      if (ok === 2) { const nx = list[(k + 1) % list.length]; E.selectText(nx.id, 0, 0, nx.o, nx.kind, nx.r, nx.c); return E.spell(); }
    }
    E.focus();
  };

  // ------------------------------------------------------------ stampa unione
  function parseCsv(text) {
    const first = text.split(/\r?\n/)[0] || "";
    const sep = [";", ",", "\t"].map(s => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
      if (ch === '"') q = true;
      else if (ch === sep) { row.push(f); f = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some(x => x !== "")) rows.push(row); row = []; }
      else f += ch;
    }
    row.push(f); if (row.some(x => x !== "")) rows.push(row);
    return rows;
  }
  E.loadRecipients = async () => {
    const paths = await pickFiles();
    if (!paths?.length) return E.focus();
    const p = paths[0], ext = extOf(p);
    let table;
    try {
      const bytes = await readBytes(p);
      if (/^(xlsx|xlsm|xls|ods)$/.test(ext)) {
        await loadScript("/vendor/xlsx/dist/xlsx.full.min.js");
        const wb = window.XLSX.read(bytes, { type: "array" });
        table = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false });
      } else {
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = new TextDecoder("windows-1252").decode(bytes); }
        table = parseCsv(text.replace(/^﻿/, ""));
      }
    } catch (e) { return toast("Elenco non leggibile: " + e.message, true); }
    table = table.filter(r => r.some(x => String(x).trim()));
    if (table.length < 2) return toast("L'elenco deve avere una riga di intestazione e almeno un destinatario", true);
    const fields = table[0].map((h, k) => String(h).trim() || "Campo" + (k + 1));
    const rows = table.slice(1).map(r => Object.fromEntries(fields.map((f, k) => [f, String(r[k] ?? "")])));
    doc().merge = { source: baseName(p), fields, rows };
    E.setMerge(0, false);
    E.commit("Seleziona destinatari");
    toast(`${rows.length} destinatari, campi: ${fields.join(", ")}`, false, 5000);
    E.focus();
  };

  // ------------------------------------------------------------ galleria dei modelli (come "Nuovo" di Publisher)
  E.templatesDlg = (replace = true) => new Promise(resolve => {
    let scheme = null, fonts = null, chosen = TEMPLATES[0];
    const back = el("div", { class: "pb-galback", role: "dialog", "aria-label": "Modelli di pubblicazione" });
    const grid = el("div", { class: "pb-galgrid" });
    const cats = [...new Set(TEMPLATES.map(t => t.cat))];
    const catList = el("div", { class: "pb-galcats" });
    let cat = null;
    const big = el("canvas", { class: "pb-galbig" });
    const name = el("div", { class: "pb-galname" });
    const schemeSel = el("select", { class: "field" }, el("option", { value: "" }, "(del modello)"), ...COLOR_SCHEMES.map((s, k) => el("option", { value: k }, s.name)));
    const fontSel = el("select", { class: "field" }, el("option", { value: "" }, "(del modello)"), ...FONT_SCHEMES.map((f, k) => el("option", { value: k }, `${f.name} (${f.t} / ${f.b})`)));
    const make = t => { const d = t.make(); if (scheme) d.scheme = { name: scheme.name, c: [...scheme.c] }; if (fonts) d.fonts = { ...fonts }; return d; };
    const draw = (c, d, maxW, maxH) => {
      const s = Math.min(maxW / d.w, maxH / d.h), dpr = window.devicePixelRatio || 1;
      c.width = Math.round(d.w * s * dpr); c.height = Math.round(d.h * s * dpr); c.style.width = Math.round(d.w * s) + "px"; c.style.height = Math.round(d.h * s) + "px";
      const g = c.getContext("2d"); g.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
      drawPage({ doc: d, lay: computeLayouts(d), pageNo: 0, painter: new CanvasPainter(g, { get: () => null, has: () => false }), editing: true, scale: s }, d.pages[0]);
    };
    const renderGrid = () => {
      grid.innerHTML = "";
      for (const t of TEMPLATES.filter(t => !cat || t.cat === cat)) {
        const c = el("canvas");
        const card = el("button", { type: "button", class: "pb-galcard" + (t === chosen ? " on" : ""), title: t.name }, el("span", { class: "pb-galpic" }, c), el("span", {}, t.name), el("small", {}, t.cat));
        card.addEventListener("click", () => { chosen = t; renderGrid(); preview(); });
        card.addEventListener("dblclick", () => { chosen = t; go(); });
        grid.append(card);
        draw(c, make(t), 150, 130);
      }
    };
    const preview = () => { const d = make(chosen); draw(big, d, 260, 300); name.textContent = `${chosen.name} · ${chosen.cat} · ${d.pages.length} pagin${d.pages.length > 1 ? "e" : "a"}`; };
    const close = v => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); E.focus(); };
    const go = async () => {
      const d = make(chosen);
      const D = doc();
      const hasContent = D.pages.some(p => p.items.length) || D.masters.some(m => m.items.length);
      if (replace && hasContent && !(await confirmBox("Cambia modello", "La pubblicazione attuale verra' sostituita dal modello scelto (si puo' annullare con Ctrl+Z solo fino alla chiusura). Continuare?", "Sostituisci"))) return;
      close(true);
      E.setDoc(d);
    };
    const onKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); } if (e.key === "Enter" && e.target.tagName !== "SELECT") { e.preventDefault(); go(); } };
    const mkCat = (label, v) => { const b = el("button", { type: "button", class: "pb-galcat" + (cat === v ? " on" : "") }, label); b.addEventListener("click", () => { cat = v; catList.querySelectorAll(".pb-galcat").forEach(x => x.classList.toggle("on", x === b)); renderGrid(); }); return b; };
    catList.append(mkCat("Tutti i modelli", null), ...cats.map(c => mkCat(c, c)));
    schemeSel.addEventListener("change", () => { scheme = schemeSel.value === "" ? null : COLOR_SCHEMES[+schemeSel.value]; renderGrid(); preview(); });
    fontSel.addEventListener("change", () => { fonts = fontSel.value === "" ? null : FONT_SCHEMES[+fontSel.value]; renderGrid(); preview(); });
    back.append(el("div", { class: "pb-galbox" },
      el("header", { class: "pb-galhead" }, el("h2", {}, "Modelli"), el("span", {}, "Scegli un modello: tutto resta modificabile. Colori e caratteri si cambiano anche dopo (Progettazione pagina)."), el("button", { type: "button", class: "pb-x", title: "Chiudi (Esc)", onclick: () => close(false) }, "×")),
      el("div", { class: "pb-galbody" }, catList, grid,
        el("aside", { class: "pb-galside" }, big, name, el("label", { class: "pb-dlgrow" }, el("span", {}, "Combinazione colori"), schemeSel), el("label", { class: "pb-dlgrow" }, el("span", {}, "Combinazione caratteri"), fontSel),
          el("div", { class: "pb-galbtns" }, el("button", { type: "button", class: "btn", onclick: () => close(false) }, replace ? "Annulla" : "Pagina vuota"), el("button", { type: "button", class: "btn primary", onclick: go }, "Crea"))))));
    back.addEventListener("pointerdown", e => { if (e.target === back) close(false); });
    document.body.append(back);
    document.addEventListener("keydown", onKey, true);
    renderGrid(); preview();
  });
  void FIELD; void color; void makeStory; void styleChars; void copyStory; void storyText; void caretPos;
}
