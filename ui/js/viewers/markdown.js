// Markdown: testo a sinistra, anteprima formattata a destra in tempo reale.
import { el, loadScript } from "../core.js";
import { mount as mountText } from "./text.js";

export async function mount(ctx) {
  await loadScript("/vendor/marked/marked.min.js");
  const left = el("div", { style: { height: "100%", position: "relative" } });
  const preview = el("div", { class: "editable-doc", style: { boxShadow: "none", padding: "26px 34px", maxWidth: "none" } });
  ctx.el.append(el("div", { class: "split" }, left, el("div", { style: { background: "#fff" } }, preview)));
  ctx.fillBody(true);
  const render = text => { preview.innerHTML = window.marked.parse(text || ""); };
  const sub = await mountText({ ...ctx, el: left, fillBody() {} }, { wrap: true, onChange: render });
  render(sub.editor.getValue());
  return sub;
}
