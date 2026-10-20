// Pagine web: anteprima isolata (senza rete e senza script) e sorgente modificabile.
import { el } from "../core.js";
import { mount as mountText } from "./text.js";

export async function mount(ctx) {
  const left = el("div", { style: { height: "100%", position: "relative" } });
  const frame = el("iframe", { class: "fill", sandbox: "", style: { background: "#fff" } });
  ctx.el.append(el("div", { class: "split" }, left, frame));
  ctx.fillBody(true);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;
  let t = null;
  const render = text => { clearTimeout(t); t = setTimeout(() => (frame.srcdoc = csp + text), 250); };
  const sub = await mountText({ ...ctx, el: left, fillBody() {} }, { wrap: true, onChange: render });
  render(sub.editor.getValue());
  return sub;
}
