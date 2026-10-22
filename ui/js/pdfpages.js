// Editor PDF: Organizza pagine (come in Acrobat). Griglia di miniature sopra il documento: selezione (clic, Ctrl, Maiusc,
// Ctrl+A), trascinamento per riordinare (anche piu' pagine insieme), ruota, duplica, elimina, estrai, inserisci,
// sostituisci; dimensione delle miniature regolabile. Ogni comando e' un passo della coda dell'editor (Annulla/Ripeti).
import { t as tr, fmtNum } from "./i18n.js";
import { el } from "./core.js";
import { pdfIcon } from "./pdfedicons.js";
import { openMenu } from "./pdfedbar.js";

let current = null;

export function openOrganizer(E, { pageCmd }) {
  if (current) return current.close();
  const sel = new Set([E.curPage()]);
  let anchor = E.curPage(), size = +(localStorage.getItem("mbv-pdf-org") || 150), gen = 0;
  const grid = el("div", { class: "pe-ogrid", tabindex: 0 });
  const count = el("span", { class: "pe-ocount" });
  const ib = (icon, title, run) => { const b = el("button", { type: "button", class: "pe-b", title, "aria-label": title, html: pdfIcon(icon, 18) }); b.addEventListener("click", run); return b; };
  const list = () => [...sel].sort((a, b) => a - b);
  const zoom = el("input", { type: "range", min: 90, max: 320, value: size, class: "pe-range", title: tr("pdfed.dimensione_miniature") });
  zoom.addEventListener("input", () => { size = +zoom.value; try { localStorage.setItem("mbv-pdf-org", size); } catch { /* */ } paint(); });
  const head = el("div", { class: "pe-ohead" },
    el("span", { class: "pe-otitle", html: pdfIcon("pages", 18) }, el("b", {}, tr("pdfed.organizza_pagine"))), count,
    el("span", { class: "pe-sep" }),
    (() => { const b = ib("insertPage", tr("pdfed.inserisci_pagine"), () => openMenu(b, [
      { icon: "blank", label: tr("pdfed.pagina_bianca"), run: () => pageCmd("blank") },
      { icon: "insertPage", label: tr("pdfed.da_file"), run: () => pageCmd("insert") },
    ])); return b; })(),
    ib("extract", tr("pdfed.estrai_pagine"), () => { E.app().page = list()[0] + 1; pageCmd("extract"); }),
    ib("replace", tr("pdfed.sostituisci_pagine"), () => { E.app().page = list()[0] + 1; pageCmd("replace"); }),
    el("span", { class: "pe-sep" }),
    ib("rotateCcw", tr("pdfed.ruota_antiorario"), () => E.ops([{ kind: "page_rotate", pages: list(), angle: 270 }], tr("pdfed.ruota_pagine"))),
    ib("rotateCw", tr("pdfed.r_90_orario"), () => E.ops([{ kind: "page_rotate", pages: list(), angle: 90 }], tr("pdfed.ruota_pagine"))),
    ib("duplicate", tr("pdfed.duplica_pagina"), () => E.ops([{ kind: "page_duplicate", pages: list() }], tr("pdfed.duplica_pagina"))),
    ib("trash", tr("pdfed.elimina_pagine"), () => del()),
    el("span", { class: "grow" }),
    el("span", { class: "pe-ozoom", html: pdfIcon("zoomOut", 15) }, zoom),
    ib("close", tr("common.chiudi") + " (Esc)", () => close()));
  const root = el("div", { class: "pe-org" }, head, grid);
  E.stage.append(root);
  grid.focus();

  async function del() {
    const l = list();
    if (l.length >= E.pages()) return import("./core.js").then(m => m.toast(tr("pdfed.non_tutte_pagine"), true));
    sel.clear();
    await E.ops([{ kind: "page_delete", pages: l }], tr("pdfed.elimina_pagine"));
  }
  // miniature disegnate da pdf.js solo quando entrano nella vista
  const io = new IntersectionObserver(entries => { for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); draw(en.target); } }, { root: grid, rootMargin: "300px" });
  async function draw(card) {
    const g = gen, i = +card.dataset.i;
    try {
      const page = await E.app().pdfDocument.getPage(i + 1);
      if (g !== gen) return;
      const vp1 = page.getViewport({ scale: 1 });
      const k = Math.min(size / vp1.width, (size * 1.3) / vp1.height);
      const vp = page.getViewport({ scale: k * (devicePixelRatio || 1) });
      const cv = card.querySelector("canvas");
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      cv.style.width = vp1.width * k + "px"; cv.style.height = vp1.height * k + "px";
      await page.render({ canvasContext: cv.getContext("2d"), viewport: vp, intent: "print" }).promise;
    } catch { /* documento ricaricato nel frattempo */ }
  }
  function paint() {
    gen++;
    io.disconnect();
    grid.innerHTML = "";
    grid.style.setProperty("--sz", size + "px");
    const n = E.pages();
    for (const i of [...sel]) if (i >= n) sel.delete(i);
    count.textContent = tr("pdfed.n_pagine_selezionate", fmtNum(sel.size), fmtNum(n));
    for (let i = 0; i < n; i++) {
      const card = el("div", { class: "pe-ocard" + (sel.has(i) ? " sel" : ""), "data-i": i, draggable: "true", title: tr("pdfed.pagina_0", i + 1) },
        el("div", { class: "pe-othumb" }, el("canvas", { style: { width: size + "px", height: size * 1.3 + "px" } }),
          el("div", { class: "pe-oacts" },
            el("button", { type: "button", title: tr("pdfed.ruota_antiorario"), html: pdfIcon("rotateCcw", 14), onclick: e => { e.stopPropagation(); E.ops([{ kind: "page_rotate", pages: [i], angle: 270 }], tr("pdfed.ruota_pagine")); } }),
            el("button", { type: "button", title: tr("pdfed.r_90_orario"), html: pdfIcon("rotateCw", 14), onclick: e => { e.stopPropagation(); E.ops([{ kind: "page_rotate", pages: [i], angle: 90 }], tr("pdfed.ruota_pagine")); } }),
            el("button", { type: "button", title: tr("common.elimina"), html: pdfIcon("trash", 14), onclick: e => { e.stopPropagation(); sel.clear(); sel.add(i); del(); } }))),
        el("span", { class: "pe-onum" }, fmtNum(i + 1)));
      card.addEventListener("click", e => pick(i, e));
      card.addEventListener("dblclick", () => { E.app().page = i + 1; close(); });
      card.addEventListener("dragstart", e => { if (!sel.has(i)) { sel.clear(); sel.add(i); mark(); } e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "pages"); root.classList.add("dragging"); });
      card.addEventListener("dragend", () => { root.classList.remove("dragging"); clearDrop(); });
      grid.append(card);
      io.observe(card);
    }
  }
  const mark = () => { grid.querySelectorAll(".pe-ocard").forEach(c => c.classList.toggle("sel", sel.has(+c.dataset.i))); count.textContent = tr("pdfed.n_pagine_selezionate", fmtNum(sel.size), fmtNum(E.pages())); };
  function pick(i, e) {
    if (e.shiftKey) { const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]; if (!e.ctrlKey) sel.clear(); for (let k = a; k <= b; k++) sel.add(k); }
    else if (e.ctrlKey || e.metaKey) { if (sel.has(i)) sel.delete(i); else sel.add(i); anchor = i; }
    else { sel.clear(); sel.add(i); anchor = i; }
    mark();
  }
  // trascinamento: indicatore di inserimento prima/dopo la miniatura sotto il puntatore
  let dropAt = -1;
  const clearDrop = () => { grid.querySelectorAll(".drop-l, .drop-r").forEach(c => c.classList.remove("drop-l", "drop-r")); dropAt = -1; };
  grid.addEventListener("dragover", e => {
    e.preventDefault();
    const card = e.target.closest?.(".pe-ocard");
    clearDrop();
    if (!card) return;
    const r = card.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    card.classList.add(after ? "drop-r" : "drop-l");
    dropAt = +card.dataset.i + (after ? 1 : 0);
  });
  grid.addEventListener("drop", e => {
    e.preventDefault();
    const at = dropAt;
    clearDrop();
    root.classList.remove("dragging");
    if (at < 0) return;
    const moving = list(), n = E.pages();
    const rest = Array.from({ length: n }, (_, k) => k).filter(k => !sel.has(k));
    const pos = rest.filter(k => k < at).length;
    const order = [...rest.slice(0, pos), ...moving, ...rest.slice(pos)];
    if (order.every((v, k) => v === k)) return;
    sel.clear();
    for (let k = 0; k < moving.length; k++) sel.add(pos + k);
    E.ops([{ kind: "page_order", order }], tr("pdfed.u_riordina"));
  });
  grid.addEventListener("keydown", e => {
    e.stopPropagation();
    const n = E.pages();
    if (e.key === "Escape") return close();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); for (let k = 0; k < n; k++) sel.add(k); mark(); }
    if (e.key === "Delete") { e.preventDefault(); del(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); E.undoLast(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); E.redoLast(); }
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (step) { e.preventDefault(); const i = Math.max(0, Math.min(n - 1, (list()[list().length - 1] ?? 0) + step)); pick(i, e); grid.children[i]?.scrollIntoView({ block: "nearest" }); }
  });
  const onChange = () => paint();
  E.reloaded.add(onChange);
  function close() {
    io.disconnect();
    E.reloaded.delete(onChange);
    root.remove();
    current = null;
    const l = list();
    if (l.length) E.app().page = l[0] + 1;
  }
  paint();
  current = { close };
  return current;
}
