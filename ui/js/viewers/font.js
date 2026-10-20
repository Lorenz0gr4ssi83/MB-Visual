// Caratteri: anteprima a piu' dimensioni con testo personalizzabile e tabella dei glifi.
import { el, fileUrl } from "../core.js";

export async function mount(ctx) {
  const family = "mbv-font-" + Math.random().toString(36).slice(2);
  const face = new FontFace(family, `url("${fileUrl(ctx.path)}")`);
  await face.load();
  document.fonts.add(face);
  const sample = el("input", { type: "text", id: "fnt-" + ctx.tab.name, value: "Ingegneria MB Visual 0123456789 àèéìòù €", class: "field", style: { width: "min(600px, 100%)" } });
  const box = el("div", { style: { padding: "20px 26px", display: "grid", gap: "14px" } });
  const sizes = [12, 16, 24, 36, 54, 80];
  const lines = sizes.map(s => el("div", { style: { fontFamily: `"${family}"`, fontSize: s + "px", lineHeight: 1.2, overflowWrap: "anywhere" } }));
  const upd = () => lines.forEach(l => (l.textContent = sample.value));
  sample.addEventListener("input", upd);
  upd();
  const glyphs = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(46px, 1fr))", gap: "4px", fontFamily: `"${family}"`, fontSize: "24px" } });
  const ranges = [[0x20, 0x7e], [0xa0, 0x17f], [0x2000, 0x206f], [0x20a0, 0x20bf], [0x2190, 0x21ff], [0x2200, 0x22ff]];
  for (const [a, b] of ranges) for (let c = a; c <= b; c++) glyphs.append(el("div", { title: "U+" + c.toString(16).toUpperCase().padStart(4, "0"), style: { border: "1px solid var(--line)", borderRadius: "4px", textAlign: "center", padding: "4px 0" } }, String.fromCodePoint(c)));
  box.append(el("h2", { style: { margin: 0, fontFamily: `"${family}"`, fontSize: "34px" } }, ctx.name), sample,
    ...sizes.map((s, i) => el("div", {}, el("span", { class: "note" }, s + " px"), lines[i])), el("h3", { style: { marginBottom: 0 } }, "Caratteri"), glyphs);
  ctx.el.append(box);
  return {};
}
