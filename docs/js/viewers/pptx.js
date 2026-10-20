// PowerPoint: diapositive con testi, immagini e forme; modifica dei testi mantenendo la formattazione.
import { api, button, el, loading } from "../core.js";

export async function mount(ctx) {
  loading(ctx.el, "Lettura della presentazione");
  const p = await api("pptx", { path: ctx.path });
  ctx.el.innerHTML = "";
  const edits = new Map(); // "slide:shape[:r:c]" -> {slide, shape, cell?, paragraphs}
  let editing = false;
  let current = 0;

  const thumbs = el("div", { style: { padding: "10px", display: "grid", gap: "10px", alignContent: "start" } });
  const stage = el("div", { style: { padding: "20px", display: "grid", justifyItems: "center", gap: "12px", alignContent: "start" } });
  const notes = el("div", { class: "panel", style: { width: "min(100%, 960px)", whiteSpace: "pre-wrap", fontSize: "13px" } });
  ctx.el.append(el("div", { class: "side", style: { gridTemplateColumns: "200px 1fr" } }, thumbs, stage));
  ctx.fillBody(true);

  // valori predefiniti del modello Office per i segnaposto (quando la diapositiva non li specifica)
  const PH = { ctrTitle: [44, "center"], title: [40, "center"], subTitle: [24, "center"], body: [24, "left"], other: [18, "left"] };
  function paraEl(par, scale, ph) {
    const [defSize, defAlign] = PH[ph] || [18, "left"];
    const d = el("div", { style: { textAlign: par.align || defAlign, fontWeight: par.bold ? "700" : "400", fontStyle: par.italic ? "italic" : "normal",
      fontSize: ((par.size || defSize) * 1.333 * scale) + "px", color: par.color || "inherit", paddingLeft: (par.level || 0) * 22 * scale + "px", minHeight: "1em", lineHeight: 1.15 } }, par.text);
    return d;
  }

  function drawSlide(s, width, interactive) {
    const scale = width / p.width;
    const box = el("div", { class: "paper", style: { position: "relative", width: width + "px", height: p.height * scale + "px", background: s.background || "#fff", overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,.2)", color: "#222", fontFamily: "Calibri, 'Segoe UI', Arial, sans-serif" } });
    for (const sh of s.shapes) {
      const st = { position: "absolute", left: sh.x * scale + "px", top: sh.y * scale + "px", width: sh.w * scale + "px", height: sh.h * scale + "px",
        transform: sh.rot ? `rotate(${sh.rot}deg)` : "", boxSizing: "border-box" };
      if (sh.kind === "image") { box.append(el("img", { src: sh.src, style: { ...st, objectFit: "fill" } })); continue; }
      if (sh.kind === "table") {
        const t = el("table", { style: { ...st, borderCollapse: "collapse", fontSize: 12 * scale + "px" } });
        sh.rows.forEach((row, ri) => {
          const tr = el("tr");
          row.forEach((cell, ci) => {
            const td = el("td", { style: { border: "1px solid #999", padding: 3 * scale + "px", verticalAlign: "top" } });
            cell.forEach(par => td.append(paraEl(par, scale)));
            if (interactive && editing) makeEditable(td, `${s.index}:${sh.id}:${ri}:${ci}`, { slide: s.index, shape: sh.id, cell: [ri, ci] });
            tr.append(td);
          });
          t.append(tr);
        });
        box.append(t);
        continue;
      }
      const d = el("div", { style: { ...st, background: sh.fill || "transparent", border: sh.line ? `1px solid ${sh.line}` : "0", padding: 6 * scale + "px",
        display: "flex", flexDirection: "column", justifyContent: { middle: "center", bottom: "flex-end" }[sh.anchor || (sh.ph && sh.ph.endsWith("itle") ? "middle" : "")] || "flex-start", overflow: "hidden" } });
      for (const par of sh.paragraphs || []) d.append(paraEl(par, scale, sh.ph));
      if (interactive && editing && sh.paragraphs) makeEditable(d, `${s.index}:${sh.id}`, { slide: s.index, shape: sh.id }), d.style.outline = "1px dashed #2f6690";
      box.append(d);
    }
    return box;
  }

  function makeEditable(node, key, target) {
    node.contentEditable = "true";
    node.addEventListener("input", () => {
      const paragraphs = [...node.children].map(c => c.innerText.replace(/\n/g, " "));
      if (!node.children.length) paragraphs.push(node.innerText);
      edits.set(key, { ...target, paragraphs });
      ctx.setDirty(true);
    });
  }

  function show(i) {
    current = i;
    stage.innerHTML = "";
    const w = Math.min(960, stage.clientWidth - 60 || 900);
    stage.append(drawSlide(p.slides[i], w, true));
    notes.textContent = p.slides[i].notes ? "Note: " + p.slides[i].notes : "";
    if (p.slides[i].notes) stage.append(notes);
    [...thumbs.children].forEach((t, k) => (t.style.outline = k === i ? "2px solid var(--accent)" : "none"));
    ctx.status(`Diapositiva ${i + 1} di ${p.slides.length}`);
  }

  p.slides.forEach((s, i) => {
    const t = el("button", { style: { border: 0, padding: 0, background: "none", cursor: "pointer", display: "grid", gap: "3px", justifyItems: "start" }, onclick: () => show(i) },
      el("span", { class: "note" }, String(i + 1)), drawSlide(s, 170, false));
    thumbs.append(t);
  });
  const editBtn = button("Modifica testi", "edit", () => {
    editing = !editing;
    editBtn.classList.toggle("on", editing);
    show(current);
  });
  ctx.tb.append(
    button("", "rotateL", () => show(Math.max(0, current - 1)), { iconOnly: true, title: "Diapositiva precedente" }),
    button("", "rotate", () => show(Math.min(p.slides.length - 1, current + 1)), { iconOnly: true, title: "Diapositiva successiva" }),
    button("Presentazione", "play", () => { stage.requestFullscreen?.(); }),
    el("span", { class: "sep" }), editBtn, el("span", { class: "grow" }),
    el("span", { class: "note" }, "I testi modificati mantengono carattere, dimensione e colore originali."));
  document.addEventListener("keydown", e => {
    if (ctx.tab.view.hidden || editing) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") show(Math.min(p.slides.length - 1, current + 1));
    if (e.key === "ArrowLeft" || e.key === "PageUp") show(Math.max(0, current - 1));
  });
  requestAnimationFrame(() => show(0));

  return {
    async save(target) {
      await api("pptx_save", { path: ctx.path }, { json: { out: target, edits: [...edits.values()] } });
      edits.clear();
    },
    onShow() { show(current); },
  };
}
