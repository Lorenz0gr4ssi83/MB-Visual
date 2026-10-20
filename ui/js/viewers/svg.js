// SVG: disegno vettoriale con zoom, codice modificabile, esportazione PNG.
import { button, dirName, el, saveBlobAs, withExt } from "../core.js";
import { mount as mountText } from "./text.js";

export async function mount(ctx) {
  const left = el("div", { style: { height: "100%", position: "relative" } });
  const img = el("img", { style: { maxWidth: "none", transformOrigin: "0 0" } });
  const pane = el("div", { style: { overflow: "auto", height: "100%", padding: "16px", background: "repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 50% / 16px 16px" } }, img);
  ctx.el.append(el("div", { class: "split" }, pane, left));
  ctx.fillBody(true);
  let zoom = 1, url = null;
  const render = text => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    img.src = url;
  };
  const apply = () => (img.style.transform = `scale(${zoom})`);
  const sub = await mountText({ ...ctx, el: left, fillBody() {} }, {
    wrap: true, onChange: render, extraTools: [
      button("", "zoomIn", () => { zoom *= 1.25; apply(); }, { iconOnly: true, title: "Ingrandisci" }),
      button("", "zoomOut", () => { zoom /= 1.25; apply(); }, { iconOnly: true, title: "Riduci" }),
      button("Esporta PNG", "download", async () => {
        const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024, k = Math.max(1, 2048 / Math.max(w, h));
        const c = document.createElement("canvas");
        c.width = w * k; c.height = h * k;
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise(r => c.toBlob(r, "image/png"));
        await saveBlobAs(withExt(ctx.name, "png"), blob, dirName(ctx.path));
      }),
    ],
  });
  render(sub.editor.getValue());
  return sub;
}
