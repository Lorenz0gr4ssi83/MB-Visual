// Email (EML, MSG, MBOX): intestazioni, corpo, allegati apribili e salvabili.
import { api, button, el, fileUrl, fmtSize, loading, pickSavePath, readBytes, toast } from "../core.js";

export async function mount(ctx) {
  loading(ctx.el, "Lettura del messaggio");
  const r = await api("email", { path: ctx.path });
  ctx.el.innerHTML = "";
  const msgs = r.messaggi;
  let cur = 0;
  const listBox = el("div", { class: "tree" });
  const view = el("div", { style: { display: "grid", gridTemplateRows: "auto auto 1fr", height: "100%", minHeight: 0 } });
  if (msgs.length > 1) {
    ctx.el.append(el("div", { class: "side", style: { gridTemplateColumns: "300px 1fr" } }, listBox, view));
    msgs.forEach((m, i) => listBox.append(el("div", { class: "node", style: { display: "grid", gap: "1px", whiteSpace: "normal" }, onclick: () => show(i) },
      el("b", {}, m.oggetto || "(senza oggetto)"), el("span", { class: "note" }, m.da), el("span", { class: "note" }, m.data))));
  } else ctx.el.append(view);
  ctx.fillBody(true);

  function show(i) {
    cur = i;
    [...listBox.children].forEach((n, k) => n.classList.toggle("sel", k === i));
    const m = msgs[i];
    view.innerHTML = "";
    const head = el("div", { style: { padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "grid", gap: "4px" } },
      el("div", { style: { fontSize: "17px", fontWeight: 600 } }, m.oggetto || "(senza oggetto)"),
      el("dl", { class: "kv" }, el("dt", {}, "Da"), el("dd", {}, m.da), el("dt", {}, "A"), el("dd", {}, m.a),
        m.cc ? el("dt", {}, "Cc") : null, m.cc ? el("dd", {}, m.cc) : null, el("dt", {}, "Data"), el("dd", {}, m.data)));
    const att = el("div", { style: { padding: m.allegati.length ? "8px 18px" : "0", display: "flex", gap: "6px", flexWrap: "wrap", borderBottom: m.allegati.length ? "1px solid var(--line)" : "0" } });
    for (const a of m.allegati) {
      att.append(el("span", { class: "panel", style: { padding: "4px 8px", display: "inline-flex", gap: "8px", alignItems: "center" } },
        el("span", {}, "📎 " + a.nome), el("span", { class: "note" }, fmtSize(a.size)),
        el("button", { class: "btn", onclick: () => ctx.openFile(a.path) }, "Apri"),
        el("button", { class: "btn", onclick: async () => { const p = await pickSavePath(a.nome); if (!p) return; await api("save", { path: p }, { body: await readBytes(a.path) }); toast("Allegato salvato"); } }, "Salva")));
    }
    let html = m.html;
    if (html) for (const [cid, p] of Object.entries(m.cid || {})) html = html.split("cid:" + cid).join(fileUrl(p));
    const body = html
      ? el("iframe", { class: "fill", sandbox: "allow-same-origin", srcdoc: `<base target="_blank"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">${html}`, style: { background: "#fff" } })
      : el("pre", { style: { margin: 0, padding: "16px 18px", whiteSpace: "pre-wrap", fontFamily: "var(--ui)", overflow: "auto" } }, m.testo || "");
    view.append(head, att, body);
    ctx.status(msgs.length > 1 ? `Messaggio ${i + 1} di ${msgs.length}` : `${m.allegati.length} allegati`);
  }
  ctx.tb.append(button("Esporta corpo (HTML)", "download", async () => {
    const m = msgs[cur];
    const p = await pickSavePath((m.oggetto || "messaggio").replace(/[\\/:*?"<>|]/g, "_") + ".html");
    if (!p) return;
    await api("save", { path: p }, { body: new TextEncoder().encode(m.html || `<pre>${(m.testo || "").replace(/</g, "&lt;")}</pre>`) });
    toast("Esportato");
  }));
  show(0);
  return {};
}
