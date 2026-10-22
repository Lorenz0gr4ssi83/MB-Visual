// Lettura di un messaggio: intestazioni, PEC (busta, daticert, stato delle ricevute), commessa suggerita, invito alla
// riunione, allegati con anteprima dentro la lettura (stesso visualizzatore delle schede: DWG, IFC, PDF, p7m, Office...),
// corpo HTML in un iframe senza script con le immagini remote bloccate finche' non si chiede di mostrarle.
import { api, el, fmtSize, toast } from "../core.js";
import { badgeFor } from "../app.js";
import { t as tr, tn } from "../i18n.js";
import { ap, avatarColor, call, fmtWhen, icon, initials, popMenu, saveAttachmentsTo, who } from "./mailapp.js";
import { IC } from "./mailicons.js";

export async function showMessage(box, id, { app }) {
  box.innerHTML = "";
  const wait = el("div", { class: "ml-noread" }, el("div", { class: "spinner" }));
  box.append(wait);
  let d;
  try { d = await call("message", { id }); } catch (e) {
    box.innerHTML = "";
    box.append(el("div", { class: "ml-noread" }, el("div", { html: IC.nuvola }), el("p", { class: "bad" }, e.message)));
    return { id, dispose() {} };
  }
  box.innerHTML = "";
  const state = { preview: null, showImgs: false };
  const m = d.m, h = d.h;
  const wrap = el("div", { class: "ml-rd" });
  box.append(wrap);

  // ---------------------------------------------------------- intestazione
  const from = h.from[0] || { n: m.from_name, a: m.from_addr };
  const acts = el("div", { class: "ml-racts" },
    actBtn(tr("mail.rispondi"), "rispondi", () => app.reply("reply", id)),
    actBtn(tr("mail.rispondi_tutti"), "tutti", () => app.reply("replyall", id)),
    actBtn(tr("mail.inoltra"), "inoltra", () => app.reply("forward", id)),
    actBtn(tr("mail.altro"), "altro", e => moreMenu(e), true));
  const toLine = (label, lst) => lst?.length ? el("div", { class: "ml-to" }, el("span", { class: "k" }, label), ...lst.map((x, i) => el("span", { class: "p", title: x.a }, (i ? ", " : "") + who(x)))) : null;
  const head = el("header", { class: "ml-rhead" },
    el("h2", { class: "ml-subj" }, h.subject || tr("mail.senza_oggetto"), h.priority === 1 ? el("span", { class: "chip bad" }, tr("mail.priorita_alta")) : null),
    el("div", { class: "ml-from" },
      el("div", { class: "ml-av big", style: { background: avatarColor(from.a) } }, initials(who(from))),
      el("div", { class: "fx" },
        el("div", { class: "who" }, el("b", {}, from.n || from.a), from.n ? el("span", { class: "addr" }, `<${from.a}>`) : null),
        toLine(tr("mail.q_a"), h.to), toLine(tr("mail.q_cc"), h.cc),
        el("div", { class: "when" }, fmtWhen(h.date || m.date, true), m.folder_name ? el("span", { class: "ml-infold" }, " · " + (m.folder_role ? tr("mail.cart_" + m.folder_role) : m.folder_name)) : null)),
      acts));
  ap(wrap, head);
  const tags = el("div", { class: "ml-tags" });
  for (const c of m.categories || []) tags.append(el("span", { class: "ml-cat", style: { "--c": app.catColor(c) } }, c));
  if (m.flagged) tags.append(el("span", { class: "chip " + (m.flag_done ? "ok" : "warn") }, icon(m.flag_done ? "ok" : "bandiera"), m.flag_done ? tr("mail.completato") : m.flag_due ? tr("mail.scade_il", fmtWhen(m.flag_due, true)) : tr("mail.contrassegnato")));
  if (m.remind_at) tags.append(el("span", { class: "chip warn" }, icon("sveglia"), tr("mail.promemoria_il", fmtWhen(m.remind_at, true))));
  if (m.commessa) {
    const c = app.commesse().find(x => x.id === m.commessa);
    if (c) tags.append(el("button", { class: "chip ml-comchip", title: c.cartella || "", onclick: () => app.go("commessa:" + c.id) }, icon("commessa"), (c.codice ? c.codice + " · " : "") + c.nome));
  }
  if (tags.childNodes.length) wrap.append(tags);

  // ---------------------------------------------------------- PEC
  if (d.pec_stato) wrap.append(pecSent(d.pec_stato, app));
  if (d.pec && d.pec.tipo === "posta-certificata") wrap.append(pecReceived(d));
  else if (d.pec && d.pec.tipo !== "posta-certificata") wrap.append(pecReceipt(d, app));
  if (d.commessa_suggerita && !m.commessa) {
    const c = app.commesse().find(x => x.id === d.commessa_suggerita.id);
    if (c) {
      const bar = el("div", { class: "ml-bar info" }, icon("commessa"),
        el("span", { class: "fx" }, tr("mail.sembra_commessa", c.nome), el("span", { class: "muted" }, " (" + tr("mail.motivo_" + d.commessa_suggerita.motivo) + ")")),
        el("button", { class: "btn primary", onclick: () => { app.linkCommessa([id], c, true); bar.remove(); } }, c.cartella ? tr("mail.collega_e_archivia") : tr("mail.collega")),
        el("button", { class: "btn", onclick: () => bar.remove() }, tr("mail.ignora")));
      ap(wrap, bar);
    }
  }
  if (h.notify && m.folder_role !== "sent") wrap.append(el("div", { class: "ml-bar" }, icon("ricevuta"), el("span", { class: "fx" }, tr("mail.richiesta_conferma_lettura"))));
  for (const inv of d.inviti || []) wrap.append(await inviteCard(inv, id, app));

  // ---------------------------------------------------------- allegati
  const atts = d.atts.filter(a => !a.inline && !a.firma);
  const body = el("div", { class: "ml-body" });
  const prevBox = el("div", { class: "ml-prev", hidden: true });
  if (atts.length) {
    const strip = el("div", { class: "ml-atts" });
    for (const a of atts) {
      const chip = el("button", { class: "ml-att", title: `${a.nome} · ${fmtSize(a.size)}` }, badgeFor(a.nome), el("span", { class: "nm" }, a.nome), el("span", { class: "sz mono" }, fmtSize(a.size)));
      chip.addEventListener("click", () => preview(a, chip));
      chip.addEventListener("dblclick", () => openAtt(a));
      chip.addEventListener("contextmenu", e => { e.preventDefault(); attMenu(e, a); });
      chip.draggable = false;
      ap(strip, chip);
    }
    const tot = atts.reduce((s, a) => s + a.size, 0);
    ap(strip, el("button", { class: "ml-attall", onclick: e => allMenu(e) }, icon("salva"), tn("mail.n_allegati", atts.length), " · ", fmtSize(tot), el("span", { class: "ml-caret", html: IC.giu })));
    ap(wrap, strip);
  }
  ap(wrap, body, prevBox);

  // ---------------------------------------------------------- corpo
  if (d.html) renderHtml(d.html);
  else body.append(el("div", { class: "ml-text", html: linkify(d.text || "") }));
  if (d.pec?.testo_gestore) {
    ap(body, el("details", { class: "ml-gestore" }, el("summary", {}, tr("mail.testo_gestore")), el("div", { class: "ml-text", html: linkify(d.pec.testo_gestore) })));
  }

  function remoteAllowed() {
    return state.showImgs || (app.settings?.().immagini_remote || []).includes(from.a);
  }

  function renderHtml(html) {
    body.innerHTML = "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, iframe, object, embed, frame, frameset, base, meta[http-equiv], link[rel=import], form").forEach(x => x.remove());
    let remote = 0;
    const allow = remoteAllowed();
    for (const img of doc.querySelectorAll("img, [background]")) {
      const attr = img.hasAttribute("src") ? "src" : "background";
      const src = (img.getAttribute(attr) || "").trim();
      if (/^cid:/i.test(src)) img.setAttribute(attr, `/api/mail?op=part&id=${id}&cid=${encodeURIComponent(src.slice(4))}`);
      else if (/^https?:/i.test(src)) {
        remote++;
        if (allow) img.setAttribute(attr, `/api/mail?op=img&url=${encodeURIComponent(src)}`);
        else { img.setAttribute("data-src", src); img.removeAttribute(attr); img.setAttribute("alt", img.getAttribute("alt") || ""); }
      }
      img.removeAttribute("srcset");
    }
    for (const a of doc.querySelectorAll("a[href]")) a.setAttribute("target", "_blank");
    const csp = `default-src 'none'; img-src data: ${location.origin}; style-src 'unsafe-inline'; font-src data:; media-src 'none'`;
    const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{background:#fff;color:#1b1d20;cursor:default}` +
      `body{margin:0;padding:14px 18px;font:14px/1.5 "IBM Plex Sans","Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}` +
      `blockquote{margin-left:.6em;padding-left:.8em;border-left:2px solid #ccc}*{cursor:default!important}pre{white-space:pre-wrap}</style>`;
    const frame = el("iframe", { class: "ml-frame", sandbox: "allow-same-origin", referrerpolicy: "no-referrer" });
    frame.srcdoc = "<!doctype html><html><head>" + head + doc.head.innerHTML + "</head><body>" + doc.body.innerHTML + "</body></html>";
    if (remote && !allow) {
      ap(body, el("div", { class: "ml-bar" }, icon("immagine"), el("span", { class: "fx" }, tn("mail.immagini_bloccate", remote)),
        el("button", { class: "btn", onclick: () => { state.showImgs = true; renderHtml(html); } }, tr("mail.mostra_immagini")),
        el("button", { class: "btn", onclick: async () => {
          const s = app.settings?.() || {};
          s.immagini_remote = [...new Set([...(s.immagini_remote || []), from.a])];
          await call("settings_set", { s: { immagini_remote: s.immagini_remote } });
          state.showImgs = true;
          renderHtml(html);
        } }, tr("mail.sempre_da", from.a))));
    }
    ap(body, frame);
    frame.addEventListener("load", () => {
      const fd = frame.contentDocument;
      if (!fd) return;
      const fit = () => { frame.style.height = Math.max(120, fd.documentElement.scrollHeight + 4) + "px"; };
      fit();
      new ResizeObserver(fit).observe(fd.documentElement);
      fd.addEventListener("click", e => {
        const a = e.target.closest?.("a[href]");
        if (!a) return;
        e.preventDefault();
        openLink(a.getAttribute("href"), a.textContent);
      });
      fd.addEventListener("keydown", e => window.dispatchEvent(new KeyboardEvent("keydown", e)), true);
    });
  }

  async function openLink(href, text) {
    if (/^mailto:/i.test(href)) {
      const addr = decodeURIComponent(href.slice(7).split("?")[0]);
      const { newMessage } = await import("./mailapp.js");
      return newMessage({ to: addr });
    }
    if (!/^https?:/i.test(href)) return;
    // collegamento ingannevole: il testo mostra un indirizzo diverso da quello vero
    const shown = (text || "").trim().match(/^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/i)?.[1];
    const real = new URL(href).hostname;
    if (shown && !real.toLowerCase().endsWith(shown.toLowerCase().replace(/^www\./, ""))) {
      const { confirmBox } = await import("../core.js");
      if (!(await confirmBox(tr("mail.link_sospetto"), tr("mail.link_sospetto_testo", shown, real), tr("mail.apri_comunque"), true))) return;
    }
    call("open_url", { url: href });
  }

  // ---------------------------------------------------------- anteprima allegati dentro la lettura
  async function preview(a, chip) {
    if (state.preview?.i === a.i) return closePreview();
    closePreview(true);
    wrap.querySelectorAll(".ml-att.on").forEach(x => x.classList.remove("on"));
    chip?.classList.add("on");
    body.hidden = true;
    prevBox.hidden = false;
    prevBox.innerHTML = "";
    const host = el("div", { class: "ml-prevhost" });
    const bar = el("div", { class: "ml-prevbar" },
      el("button", { class: "btn", onclick: () => closePreview() }, el("span", { class: "mi", html: IC.sinistra }), tr("mail.torna_messaggio")),
      el("b", { class: "fx" }, a.nome),
      el("button", { class: "btn", onclick: () => openAtt(a) }, icon("apri"), tr("mail.apri_scheda")),
      el("button", { class: "btn", onclick: () => saveAtt(a) }, icon("salva"), tr("mail.salva_con_nome")));
    prevBox.append(bar, host);
    host.append(el("div", { class: "ml-noread" }, el("div", { class: "spinner" })));
    try {
      const f = await call("att_file", { id, i: a.i });
      const pv = await window.MB.mountPreview(f.path, host, { ownerView: app.ownerView });
      state.preview = { i: a.i, pv };
    } catch (e) {
      host.innerHTML = "";
      host.append(el("div", { class: "ml-noread" }, el("p", { class: "bad" }, e.message)));
    }
  }
  function closePreview(keep) {
    state.preview?.pv?.dispose?.();
    state.preview = null;
    if (!keep) {
      prevBox.hidden = true;
      prevBox.innerHTML = "";
      body.hidden = false;
      wrap.querySelectorAll(".ml-att.on").forEach(x => x.classList.remove("on"));
    }
  }
  async function openAtt(a) {
    try { const f = await call("att_file", { id, i: a.i }); app.openFile(f.path); } catch (e) { toast(e.message, true); }
  }
  async function saveAtt(a) {
    const { pickSavePath, readBytes, saveBytes } = await import("../core.js");
    const f = await call("att_file", { id, i: a.i });
    const dest = await pickSavePath(a.nome, "");
    if (!dest) return;
    await saveBytes(dest, await readBytes(f.path));
    toast(tr("mail.salvato"));
  }
  function attMenu(e, a) {
    const c = app.commesse().find(x => x.id === m.commessa);
    popMenu(e.clientX, e.clientY, [
      { label: tr("mail.anteprima"), icon: "occhio", run: () => preview(a) },
      { label: tr("mail.apri_scheda"), icon: "apri", run: () => openAtt(a) },
      { label: tr("mail.apri_programma_predefinito"), icon: "apri", run: async () => { const f = await call("att_file", { id, i: a.i }); api("open_external", { path: f.path }); } },
      "-",
      { label: tr("mail.salva_con_nome"), icon: "salva", run: () => saveAtt(a) },
      { label: tr("mail.salva_in_commessa", c?.nome || ""), icon: "commessa", disabled: !c?.cartella, run: () => saveToCommessa([a.i]) },
      { label: tr("mail.salva_in_cartella"), icon: "cartella", run: () => saveAttachmentsTo([id], [a.i]) },
      "-",
      { label: tr("mail.firma_allegato_inoltra"), icon: "firma", run: async () => {
        const f = await call("att_file", { id, i: a.i });
        const { openCompose } = await import("./mailapp.js");
        openCompose({ mode: "forward", id, sign_first: f.path });
      } },
    ]);
  }
  function allMenu(e) {
    const c = app.commesse().find(x => x.id === m.commessa);
    popMenu(e.clientX, e.clientY, [
      { label: tr("mail.salva_tutti_cartella"), icon: "cartella", run: () => saveAttachmentsTo([id]) },
      { label: c ? tr("mail.salva_tutti_commessa", c.nome) : tr("mail.salva_tutti_commessa_scegli"), icon: "commessa",
        run: () => (c ? saveToCommessa(null) : app.linkCommessa && chooseThenArchive()) },
    ]);
  }
  async function saveToCommessa(parti) {
    const c = app.commesse().find(x => x.id === m.commessa);
    if (!c?.cartella) return toast(tr("mail.commessa_senza_cartella"), true);
    if (parti) {
      const r = await call("save_atts", { ids: [id], dest: c.cartella, parti });
      toast(tn("mail.allegati_salvati", r.file.length, { cartella: r.cartella }), false, 4500);
    } else app.linkCommessa([id], c, true);
  }
  function chooseThenArchive() {
    const list = app.commesse().filter(c => !c.chiusa);
    if (!list.length) return toast(tr("mail.nessuna_commessa"), true);
    popMenu(innerWidth / 2 - 150, 160, list.map(c => ({ label: (c.codice ? c.codice + " · " : "") + c.nome, icon: "commessa", run: () => app.linkCommessa([id], c, true) })));
  }
  function moreMenu(e) {
    popMenu(e.clientX - 200, e.clientY + 10, [
      { label: tr("mail.inoltra_allegato"), icon: "allegato", run: () => app.reply("forward", id, { as_eml: true }) },
      { label: tr("mail.modifica_reinvia"), icon: "bozze", run: async () => { const { openCompose } = await import("./mailapp.js"); openCompose({ mode: "edit", id }); } },
      { label: tr("mail.apri_scheda"), icon: "apri", run: () => app.openInTab(m) },
      { label: tr("mail.mostra_originale"), icon: "occhio", run: () => showSource() },
      { label: tr("mail.stampa"), icon: "stampa", run: async () => { const f = await call("eml_file", { id }); window.MB.openFile(f.path).then(() => window.MB.print?.()); } },
    ]);
  }
  async function showSource() {
    const f = await call("eml_file", { id });
    window.MB.openFile(f.path, "text");
  }

  return { id, dispose() { closePreview(true); } };
}

function actBtn(label, ic, run, iconOnly) {
  const b = el("button", { class: "ml-ract" + (iconOnly ? " icon" : ""), title: label, onclick: run });
  b.insertAdjacentHTML("beforeend", IC[ic]);
  if (!iconOnly) b.append(el("span", {}, label));
  return b;
}

function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function linkify(text) {
  return escapeHtml(text).replace(/\b(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank">$1</a>');
}

// ------------------------------------------------------------------ PEC
const PEC_CLS = { consegnata: "ok", accettata: "warn", inviata: "mute", parziale: "warn", "parziale-errore": "bad", errore: "bad", "non-accettata": "bad" };
function pecSent(st, app) {
  const k = st.stato.replace("-", "_");
  const card = el("div", { class: "ml-pec " + PEC_CLS[st.stato] },
    el("div", { class: "ml-pechead" }, icon("pec"), el("b", {}, tr("mail.pec_stato_" + k)), el("span", { class: "muted" }, " · " + tr("mail.pec_spieg_" + k))));
  const steps = el("div", { class: "ml-pecsteps" });
  const step = (ok, label, sub, rid) => {
    const s = el("div", { class: "ml-pecstep " + ok }, icon(ok === "ok" ? "ok" : ok === "bad" ? "errore" : "attesa"), el("div", {}, el("div", {}, label), sub ? el("div", { class: "muted mono" }, sub) : null));
    if (rid) { s.classList.add("link"); s.title = tr("mail.apri_ricevuta"); s.addEventListener("click", () => app.openReceipt?.(rid) || openReceiptInTab(rid, app)); }
    steps.append(s);
  };
  if (st.non_accettazione) step("bad", tr("mail.ric_non_accettazione"), st.non_accettazione.errore_esteso || st.non_accettazione.data, st.non_accettazione.id);
  else step(st.accettazione ? "ok" : "wait", tr("mail.ric_accettazione"), st.accettazione?.data || tr("mail.in_attesa"), st.accettazione?.id);
  for (const d of st.destinatari) {
    const cls = d.stato === "consegnata" ? "ok" : d.stato === "attesa" ? "wait" : "bad";
    const r = [...st.consegne, ...st.errori, ...st.preavvisi].find(x => x.id === d.ricevuta);
    step(cls, d.a + " — " + tr("mail.dest_" + d.stato), r ? (r.data + (r.errore_esteso ? " · " + r.errore_esteso : "")) : "", d.ricevuta);
  }
  for (const a of st.esterni || []) step("mute", a + " — " + tr("mail.dest_esterno"), tr("mail.dest_esterno_spieg"));
  ap(card, steps);
  return card;
}

async function openReceiptInTab(rid) {
  const f = await call("eml_file", { id: rid });
  window.MB.openFile(f.path);
}

function pecReceived(d) {
  const dc = d.pec.daticert || {};
  const card = el("div", { class: "ml-pec info" },
    el("div", { class: "ml-pechead" }, icon("pec"), el("b", {}, tr("mail.pec_ricevuta_titolo")), d.pec.virus ? el("span", { class: "chip bad" }, tr("mail.virus")) : null),
    el("dl", { class: "kv ml-peckv" },
      el("dt", {}, tr("mail.gestore")), el("dd", {}, dc.gestore || "-"),
      el("dt", {}, tr("mail.mittente_certificato")), el("dd", {}, dc.mittente || "-"),
      el("dt", {}, tr("mail.data_invio")), el("dd", { class: "mono" }, dc.data || "-"),
      el("dt", {}, tr("mail.identificativo")), el("dd", { class: "mono" }, dc.id || "-")));
  const files = el("div", { class: "ml-pecfiles" }, el("span", { class: "muted" }, tr("mail.busta_pec") + ":"));
  for (const b of d.pec.busta) {
    ap(files, el("button", { class: "link", onclick: async () => { const f = await call("att_file", { id: d.m.id, i: b.i }); window.MB.openFile(f.path); } }, b.nome));
  }
  ap(files, el("button", { class: "link", onclick: () => openReceiptInTab(d.m.id) }, tr("mail.busta_completa")));
  ap(card, files);
  return card;
}

function pecReceipt(d, app) {
  const dc = d.pec.daticert || {};
  const tipo = d.pec.tipo;
  const bad = /errore|non-acc|virus|anomalia/.test(tipo);
  const card = el("div", { class: "ml-pec " + (bad ? "bad" : tipo === "avvenuta-consegna" ? "ok" : "warn") },
    el("div", { class: "ml-pechead" }, icon(bad ? "errore" : "ricevuta"), el("b", {}, tr("mail.ric_" + tipo.replace(/-/g, "_"))),
      dc.consegna ? el("span", { class: "muted" }, " · " + dc.consegna) : null),
    el("dl", { class: "kv ml-peckv" },
      el("dt", {}, tr("mail.gestore")), el("dd", {}, dc.gestore || "-"),
      el("dt", {}, tr("mail.data")), el("dd", { class: "mono" }, dc.data || "-"),
      dc.errore_esteso ? el("dt", {}, tr("mail.errore")) : null, dc.errore_esteso ? el("dd", { class: "bad" }, dc.errore_esteso) : null,
      el("dt", {}, tr("mail.identificativo")), el("dd", { class: "mono" }, dc.id || "-")));
  if (d.pec_originale) {
    ap(card, el("div", { class: "ml-pecfiles" }, el("span", { class: "muted" }, tr("mail.relativa_a") + ":"),
      el("button", { class: "link", onclick: () => app.go("pec").then(() => {}) }, d.pec_originale.subject || tr("mail.senza_oggetto"))));
  }
  return card;
}

// ------------------------------------------------------------------ inviti alle riunioni
async function inviteCard(inv, id, app) {
  const { parseCalendar } = await import("../pim.js");
  let ev;
  try { ev = parseCalendar(inv.ics).elementi[0]; } catch { ev = null; }
  if (!ev) return el("div");
  const method = (inv.ics.match(/^METHOD:(\w+)/m) || [])[1] || "REQUEST";
  const when = ev.inizio ? ev.inizio.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) + (ev.fine ? " – " + ev.fine.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "") : "";
  const card = el("div", { class: "ml-invite" },
    el("div", { class: "ml-invdate" }, el("span", { class: "m" }, ev.inizio?.toLocaleDateString(undefined, { month: "short" }) || ""), el("span", { class: "d" }, ev.inizio?.getDate() || "")),
    el("div", { class: "fx" },
      el("b", {}, method === "CANCEL" ? tr("mail.riunione_annullata") + ": " + ev.titolo : ev.titolo),
      el("div", {}, when), ev.luogo ? el("div", { class: "muted" }, ev.luogo) : null,
      ev.organizzatore ? el("div", { class: "muted" }, tr("mail.organizzatore") + ": " + (ev.organizzatore.nome || ev.organizzatore.email || "")) : null));
  const st = el("div", { class: "ml-invact" });
  const reply = async ans => {
    try {
      await call("cal_reply", { id, i: inv.i, risposta: ans });
      toast(tr("mail.risposta_inviata_" + ans));
      st.innerHTML = "";
      ap(st, el("span", { class: "chip ok" }, tr("mail.risposta_" + ans)));
    } catch (e) { toast(e.message, true, 6000); }
  };
  if (method === "REQUEST") {
    ap(st, el("button", { class: "btn primary", onclick: () => reply("ACCEPTED") }, icon("ok"), tr("mail.accetta")),
      el("button", { class: "btn", onclick: () => reply("TENTATIVE") }, tr("mail.provvisorio")),
      el("button", { class: "btn", onclick: () => reply("DECLINED") }, icon("chiudi"), tr("mail.rifiuta")));
  } else {
    ap(st, el("button", { class: "btn", onclick: () => reply("ADD") }, icon("calendario"), tr("mail.aggiungi_calendario")));
  }
  ap(card, st);
  return card;
}
