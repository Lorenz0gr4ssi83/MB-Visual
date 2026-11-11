// Email (EML, MSG, MBOX, archivi di Outlook PST/OST): intestazioni, corpo, allegati apribili e salvabili.
import { api, button, el, fileUrl, fmtSize, loading, pickSavePath, readBytes, toast } from "../core.js";
import { t } from "../i18n.js";

export async function mount(ctx) {
  loading(ctx.el, t("v_email.lettura_messaggio"));
  const r = await api("email", { path: ctx.path });
  ctx.el.innerHTML = "";
  const msgs = r.messaggi;
  let cur = 0, seq = 0;
  const listBox = el("div", { class: "tree" });
  const view = el("div", { style: { display: "grid", gridTemplateRows: "auto auto 1fr", height: "100%", minHeight: 0 } });
  if (r.pst) {
    // archivio di Outlook (.pst/.ost): elenco virtuale di tutti i messaggi, cartella e ricerca; il messaggio si legge al clic
    if (!msgs.length) { ctx.el.append(el("div", { class: "note", style: { padding: "24px" } }, t("v_email.pst_vuoto"))); ctx.fillBody(true); return {}; }
    const ROW = 58;
    let shown = msgs.map((_, i) => i);
    const sel = el("select", { class: "inp", style: { width: "100%" } }, el("option", { value: "" }, t("v_email.tutte_cartelle", msgs.length)),
      ...r.cartelle.map((f, k) => el("option", { value: String(k) }, `${f.nome} (${f.n})`)));
    const find = el("input", { class: "inp", type: "search", placeholder: t("v_email.cerca"), style: { width: "100%" } });
    const inner = el("div", { style: { position: "relative" } });
    const scroller = el("div", { style: { overflow: "auto", minHeight: 0 } }, inner);
    const count = el("div", { class: "note", style: { padding: "0 10px 6px" } });
    const draw = () => {
      inner.style.height = shown.length * ROW + "px";
      const a = Math.max(0, Math.floor(scroller.scrollTop / ROW) - 5), b = Math.min(shown.length, a + Math.ceil((scroller.clientHeight || 800) / ROW) + 10);
      inner.innerHTML = "";
      for (let k = a; k < b; k++) {
        const i = shown[k], m = msgs[i];
        inner.append(el("div", { class: "node" + (i === cur ? " sel" : ""), title: m.cartella, style: { position: "absolute", left: 0, right: 0, top: k * ROW + "px", height: ROW - 4 + "px", padding: "3px 10px", boxSizing: "border-box", display: "grid", gap: "1px", overflow: "hidden" }, onclick: () => show(i) },
          el("b", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (m.na ? "📎 " : "") + (m.oggetto || t("v_email.senza_oggetto"))),
          el("span", { class: "note", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.da),
          el("span", { class: "note" }, m.data)));
      }
      count.textContent = t("v_email.pst_conteggio", shown.length, msgs.length);
    };
    const filter = () => {
      const f = sel.value === "" ? null : r.cartelle[+sel.value];
      const q = find.value.trim().toLowerCase();
      shown = [];
      const a = f ? f.da : 0, b = f ? f.da + f.n : msgs.length;
      for (let i = a; i < b; i++) { const m = msgs[i]; if (!q || (m.oggetto + " " + m.da).toLowerCase().includes(q)) shown.push(i); }
      scroller.scrollTop = 0; draw();
    };
    sel.onchange = filter; find.oninput = filter; scroller.onscroll = draw;
    const left = el("div", { style: { display: "grid", gridTemplateRows: "auto auto auto 1fr", minHeight: 0, gap: "6px", paddingTop: "8px" } },
      el("div", { style: { padding: "0 10px" } }, sel), el("div", { style: { padding: "0 10px" } }, find), count, scroller);
    ctx.el.append(el("div", { class: "side", style: { gridTemplateColumns: "320px 1fr" } }, left, view));
    ctx.fillBody(true);
    requestAnimationFrame(draw); draw();
    listBox.refresh = draw;
  } else if (msgs.length > 1) {
    ctx.el.append(el("div", { class: "side", style: { gridTemplateColumns: "300px 1fr" } }, listBox, view));
    msgs.forEach((m, i) => listBox.append(el("div", { class: "node", style: { display: "grid", gap: "1px", whiteSpace: "normal" }, onclick: () => show(i) },
      el("b", {}, m.oggetto || t("v_email.senza_oggetto")), el("span", { class: "note" }, m.da), el("span", { class: "note" }, m.data))));
  } else ctx.el.append(view);
  if (!r.pst) ctx.fillBody(true);

  async function show(i) {
    cur = i;
    if (listBox.refresh) listBox.refresh();
    else [...listBox.children].forEach((n, k) => n.classList.toggle("sel", k === i));
    if (r.pst && !msgs[i].full) {
      const my = ++seq;
      loading(view, t("v_email.lettura_messaggio"));
      let full;
      try { full = (await api("email", { path: ctx.path, i })).messaggio; }
      catch (e) { if (my === seq) { view.innerHTML = ""; view.append(el("div", { class: "note", style: { padding: "24px" } }, e.message)); } return; }
      msgs[i] = { ...msgs[i], ...full, full: true };
      if (my !== seq) return;
    }
    const m = msgs[i];
    view.innerHTML = "";
    view.style.gridTemplateRows = m.pec ? "auto auto auto 1fr" : "auto auto 1fr";
    const head = el("div", { style: { padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "grid", gap: "4px" } },
      el("div", { style: { fontSize: "17px", fontWeight: 600 } }, m.oggetto || t("v_email.senza_oggetto")),
      el("dl", { class: "kv" }, el("dt", {}, t("v_email.testo")), el("dd", {}, m.da), el("dt", {}, t("v_email.a")), el("dd", {}, m.a),
        m.cc ? el("dt", {}, "Cc") : null, m.cc ? el("dd", {}, m.cc) : null, el("dt", {}, t("v_email.data")), el("dd", {}, m.data)));
    const att = el("div", { style: { padding: m.allegati.length ? "8px 18px" : "0", display: "flex", gap: "6px", flexWrap: "wrap", borderBottom: m.allegati.length ? "1px solid var(--line)" : "0" } });
    for (const a of m.allegati) {
      if (!a.path) { att.append(el("span", { class: "panel note", style: { padding: "4px 8px" }, title: t("v_email.allegato_non_estratto") }, "📎 " + a.nome)); continue; }
      att.append(el("span", { class: "panel", style: { padding: "4px 8px", display: "inline-flex", gap: "8px", alignItems: "center" } },
        el("span", {}, "📎 " + a.nome), el("span", { class: "note" }, fmtSize(a.size)),
        el("button", { class: "btn", onclick: () => ctx.openFile(a.path) }, t("v_email.apri")),
        el("button", { class: "btn", onclick: async () => { const p = await pickSavePath(a.nome); if (!p) return; await api("save", { path: p }, { body: await readBytes(a.path) }); toast(t("v_email.allegato_salvato")); } }, t("common.salva"))));
    }
    let html = m.html;
    if (html) for (const [cid, p] of Object.entries(m.cid || {})) html = html.split("cid:" + cid).join(fileUrl(p));
    const body = html
      ? el("iframe", { class: "fill", sandbox: "allow-same-origin", srcdoc: `<base target="_blank"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">${html}`, style: { background: "#fff" } })
      : el("pre", { style: { margin: 0, padding: "16px 18px", whiteSpace: "pre-wrap", fontFamily: "var(--ui)", overflow: "auto" } }, m.testo || "");
    view.append(head, att, body);
    if (m.pec) view.insertBefore(pecBox(m.pec, ctx), head.nextSibling);
    ctx.status(msgs.length > 1 ? t("v_email.messaggio_0_1", i + 1, msgs.length) + (m.cartella ? " · " + m.cartella : "") : `${m.allegati.length} allegati`);
  }
  ctx.tb.append(button(t("v_email.esporta_corpo_html"), "download", async () => {
    const m = msgs[cur];
    if (r.pst && !m.full) return;
    const p = await pickSavePath((m.oggetto || "messaggio").replace(/[\\/:*?"<>|]/g, "_") + ".html");
    if (!p) return;
    await api("save", { path: p }, { body: new TextEncoder().encode(m.html || `<pre>${(m.testo || "").replace(/</g, "&lt;")}</pre>`) });
    toast(t("v_email.esportato"));
  }));
  show(0);
  return {};
}

// PEC: dati del gestore (daticert.xml) sopra il messaggio originale; per le ricevute l'esito
function pecBox(p, ctx) {
  const dc = p.daticert || {};
  const ric = p.tipo !== "posta-certificata";
  const bad = /errore|non-acc|virus|anomalia/.test(p.tipo);
  const color = bad ? "var(--bad)" : ric && p.tipo !== "avvenuta-consegna" ? "var(--warn)" : ric ? "var(--ok)" : "var(--info)";
  const kv = el("dl", { class: "kv", style: { fontSize: "12px", margin: 0 } });
  const add = (k, v) => { if (v) kv.append(el("dt", {}, k), el("dd", {}, v)); };
  add(t("mail.gestore"), dc.gestore);
  add(t("mail.mittente_certificato"), dc.mittente);
  add(ric ? t("mail.data") : t("mail.data_invio"), dc.data);
  if (dc.consegna) add(t("mail.q_a"), dc.consegna);
  add(t("mail.errore"), dc.errore_esteso);
  add(t("mail.identificativo"), dc.id);
  return el("div", { style: { margin: "0 18px", padding: "10px 14px", borderRadius: "10px", background: "var(--panel)", boxShadow: `inset 0 0 0 1px var(--line), inset 3px 0 0 ${color}`, display: "grid", gap: "6px" } },
    el("b", {}, ric ? t("mail.ric_" + p.tipo.replace(/-/g, "_")) : t("mail.pec_ricevuta_titolo")), kv,
    el("div", { style: { display: "flex", gap: "12px", fontSize: "12px" } }, ...p.busta.map(b => el("button", { class: "link", onclick: () => ctx.openFile(b.path) }, b.nome))));
}
