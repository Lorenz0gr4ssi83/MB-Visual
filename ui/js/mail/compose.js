// Nuovo messaggio / risposta / inoltro (scheda come la finestra di Outlook): mittente, destinatari con completamento
// dalla rubrica e dalla posta, editor con formattazione, firme HTML, risposte rapide, allegati (anche firmati
// digitalmente prima dell'invio o inviati come link per i file pesanti), importanza, conferma di lettura, invio
// posticipato, bozze automatiche. Ctrl+Invio invia, Ctrl+S salva la bozza.
import { el, fmtSize, loadCss, modal, pickFiles, toast, waitJob } from "../core.js";
import { badgeFor } from "../app.js";
import { t as tr, tn } from "../i18n.js";
import { keymap } from "../shortcuts.js";
import { askDate, call, fmtWhen, icon, popMenu } from "./mailapp.js";
import { IC } from "./mailicons.js";

export async function mountCompose(ctx) {
  loadCss("css/mail.css");
  ctx.fillBody(true);
  const c = ctx.compose || { to: [], cc: [], bcc: [], subject: "", html: "", atts: [] };
  const [{ account: accs }, { s: S }] = await Promise.all([call("accounts", {}), call("settings", {})]);
  if (!accs.length) { ctx.el.append(el("div", { class: "ml-noread" }, el("p", {}, tr("mail.nessun_account")))); return {}; }
  let acc = accs.find(a => a.id === c.account) || accs[0];
  let dirty = false, draftId = c.draft_id || 0, sendAt = 0, priority = c.priority || 0, receipt = false, sending = false;
  const atts = (c.atts || []).map(a => ({ ...a }));
  const mark = () => { if (!dirty) { dirty = true; ctx.setDirty(true); } };

  // ---------------------------------------------------------- campi
  const fromSel = el("select", { class: "field ml-from-sel" });
  for (const a of accs) {
    fromSel.append(el("option", { value: a.id }, `${a.nome || a.email} <${a.email}>${a.pec ? " · PEC" : ""}`));
    for (const al of a.alias || []) fromSel.append(el("option", { value: a.id + "|" + al }, `${a.nome || ""} <${al}>`));
  }
  fromSel.value = acc.id;
  fromSel.addEventListener("change", () => {
    const old = acc;
    acc = accs.find(a => a.id === fromSel.value.split("|")[0]);
    swapSignature(old, acc);
    pecNote.hidden = !acc.pec;
    mark();
  });
  const rTo = recipients(tr("mail.q_a"), c.to, mark), rCc = recipients(tr("mail.q_cc"), c.cc, mark), rBcc = recipients(tr("mail.q_ccn"), c.bcc, mark);
  rCc.row.hidden = !c.cc?.length;
  rBcc.row.hidden = !c.bcc?.length;
  const ccBtn = el("button", { class: "link", onclick: () => { rCc.row.hidden = false; ccBtn.remove(); rCc.focus(); } }, tr("mail.q_cc"));
  const bccBtn = el("button", { class: "link", onclick: () => { rBcc.row.hidden = false; bccBtn.remove(); rBcc.focus(); } }, tr("mail.q_ccn"));
  rTo.row.append(el("span", { class: "ml-ccbtns" }, c.cc?.length ? null : ccBtn, c.bcc?.length ? null : bccBtn));
  const subj = el("input", { class: "ml-subjin", type: "text", value: c.subject || "", placeholder: tr("mail.aggiungi_oggetto") });
  subj.addEventListener("input", () => { mark(); ctx.tab.name = subj.value || tr("mail.nuovo_messaggio"); });
  const pecNote = el("div", { class: "ml-bar info ml-pecnote", hidden: !acc.pec }, icon("pec"), el("span", {}, tr("mail.invio_pec_nota")));

  // ---------------------------------------------------------- editor
  const ed = el("div", { class: "ml-editor", contenteditable: "true", spellcheck: "true" });
  const sigHtml = a => {
    if (!a?.firma) return "";
    if (c.mode === "new" && a.firma_nuovi === false) return "";
    if (c.mode !== "new" && c.mode !== "edit" && a.firma_risposte === false) return "";
    return `<div class="mbv-firma"><br>${a.firma}</div>`;
  };
  ed.innerHTML = c.mode === "edit" ? (c.html || "") : `<div>${c.html || "<br>"}</div>${sigHtml(acc)}${c.quote ? "<br>" + c.quote : ""}`;
  ed.addEventListener("input", mark);
  ed.addEventListener("paste", e => {
    const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith("image/"));
    if (!items.length) return;
    e.preventDefault();
    for (const it of items) {
      const fr = new FileReader();
      fr.onload = () => { document.execCommand("insertImage", false, fr.result); mark(); };
      fr.readAsDataURL(it.getAsFile());
    }
  });
  function swapSignature(oldA, newA) {
    const old = ed.querySelector(".mbv-firma");
    const html = sigHtml(newA);
    if (old) { if (html) old.outerHTML = html; else old.remove(); }
    else if (html) { const q = ed.querySelector(".mbv-quote"); q ? q.insertAdjacentHTML("beforebegin", html) : ed.insertAdjacentHTML("beforeend", html); }
    void oldA;
  }

  const exec = (cmd, val) => { ed.focus(); document.execCommand(cmd, false, val); mark(); };
  const fmtBtn = (ic, title, run) => el("button", { class: "ml-fbtn", title, html: IC[ic], onmousedown: e => e.preventDefault(), onclick: run });
  const fontSel = el("select", { class: "field ml-fsel", title: tr("mail.carattere"), onchange: () => exec("fontName", fontSel.value) },
    ...["IBM Plex Sans", "Arial", "Calibri", "Cambria", "Georgia", "Segoe UI", "Tahoma", "Times New Roman", "Verdana", "Consolas"].map(f => el("option", { value: f }, f)));
  const sizeSel = el("select", { class: "field ml-fsel s", title: tr("mail.dimensione"), onchange: () => exec("fontSize", sizeSel.value) },
    ...[["1", "8"], ["2", "10"], ["3", "12"], ["4", "14"], ["5", "18"], ["6", "24"], ["7", "36"]].map(([v, l]) => el("option", { value: v, selected: v === "3" || undefined }, l)));
  const color = el("input", { type: "color", value: "#c8382f", class: "ml-color", title: tr("mail.colore_testo"), oninput: () => exec("foreColor", color.value) });
  const fbar = el("div", { class: "ml-fbar" }, fontSel, sizeSel,
    fmtBtn("grassetto", tr("mail.grassetto") + " (Ctrl+B)", () => exec("bold")), fmtBtn("corsivo", tr("mail.corsivo") + " (Ctrl+I)", () => exec("italic")),
    fmtBtn("sottolineato", tr("mail.sottolineato") + " (Ctrl+U)", () => exec("underline")), color,
    fmtBtn("evidenzia", tr("mail.evidenzia"), () => exec("hiliteColor", "#fff59d")),
    el("span", { class: "sep" }),
    fmtBtn("elenco", tr("mail.elenco_puntato"), () => exec("insertUnorderedList")), fmtBtn("numerato", tr("mail.elenco_numerato"), () => exec("insertOrderedList")),
    fmtBtn("rientro", tr("mail.aumenta_rientro"), () => exec("indent")),
    fmtBtn("sx", tr("mail.allinea_sinistra"), () => exec("justifyLeft")), fmtBtn("cx", tr("mail.centra"), () => exec("justifyCenter")),
    el("span", { class: "sep" }),
    fmtBtn("link", tr("mail.inserisci_link") + " (Ctrl+K)", () => insertLink()),
    fmtBtn("immagine", tr("mail.inserisci_immagine"), () => insertImage()),
    fmtBtn("pulisci", tr("mail.cancella_formato"), () => exec("removeFormat")),
    el("span", { class: "sep" }),
    fmtBtn("firma", tr("mail.firma_email"), e => sigMenu(e)),
    fmtBtn("risposte", tr("mail.risposte_rapide"), e => quickMenu(e)));

  async function insertLink() {
    const sel = window.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    const input = el("input", { type: "text", value: "https://" });
    const r = await modal(tr("mail.inserisci_link"), input, [{ label: tr("common.annulla"), value: null }, { label: "OK", primary: true, value: () => input.value.trim() }]);
    if (!r) return;
    ed.focus();
    if (range) { sel.removeAllRanges(); sel.addRange(range); }
    if (range && !range.collapsed) exec("createLink", r);
    else exec("insertHTML", `<a href="${r.replace(/"/g, "%22")}">${r.replace(/</g, "&lt;")}</a>`);
  }
  async function insertImage() {
    const ps = await pickFiles();
    if (!ps?.length) return;
    const { readBytes } = await import("../core.js");
    for (const p of ps) {
      const b = await readBytes(p);
      const ext = p.split(".").pop().toLowerCase();
      const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[ext];
      if (!mime) { toast(tr("mail.non_immagine"), true); continue; }
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      exec("insertImage", `data:${mime};base64,${btoa(s)}`);
    }
  }
  function sigMenu(e) {
    popMenu(e.clientX, e.clientY + 8, [
      ...accs.filter(a => a.firma).map(a => ({ label: tr("mail.firma_di", a.nome || a.email), icon: "firma", run: () => swapSignature(null, a) })),
      { label: tr("mail.togli_firma"), icon: "chiudi", run: () => ed.querySelector(".mbv-firma")?.remove() },
      "-",
      { label: tr("mail.modifica_firme"), icon: "impostazioni", run: () => import("./mailsettings.js").then(m => m.openSettings("firme")) },
    ]);
  }
  function quickMenu(e) {
    const list = S.risposte_rapide || [];
    popMenu(e.clientX, e.clientY + 8, [
      ...list.map(q => ({ label: q.nome, icon: "risposte", run: () => exec("insertHTML", q.html || (q.testo || "").replace(/</g, "&lt;").replace(/\n/g, "<br>")) })),
      list.length ? "-" : null,
      { label: tr("mail.gestisci_risposte"), icon: "impostazioni", run: () => import("./mailsettings.js").then(m => m.openSettings("risposte")) },
    ]);
  }

  // ---------------------------------------------------------- allegati
  const attBox = el("div", { class: "ml-catts" });
  function renderAtts() {
    attBox.innerHTML = "";
    const tot = atts.reduce((s, a) => s + (a.size || 0), 0);
    for (const a of atts) {
      const chip = el("div", { class: "ml-att" + (a.signed ? " signed" : "") + (a.link ? " linked" : ""), title: a.path || a.link },
        a.link ? icon("nuvola") : badgeFor(a.nome), el("span", { class: "nm" }, a.nome), el("span", { class: "sz mono" }, a.link ? tr("mail.link") : fmtSize(a.size)),
        a.signed ? el("span", { class: "chip ok" }, tr("mail.firmato")) : null,
        el("button", { class: "x", title: tr("mail.rimuovi"), html: IC.chiudi, onclick: e => { e.stopPropagation(); atts.splice(atts.indexOf(a), 1); renderAtts(); mark(); } }));
      chip.addEventListener("click", e => attMenu(e, a));
      attBox.append(chip);
    }
    const limit = (S.soglia_link || 20) * 1024 * 1024;
    attBox.append(el("button", { class: "ml-attadd", onclick: addFiles }, icon("allegato"), tr("mail.allega_file")));
    if (tot) attBox.append(el("span", { class: "mono muted" + (tot > limit ? " bad" : "") }, fmtSize(tot) + (tot > limit ? " · " + tr("mail.troppo_grande") : "")));
  }
  async function addFiles() {
    const ps = await pickFiles();
    if (ps?.length) await addPaths(ps);
  }
  async function addPaths(ps) {
    const { api } = await import("../core.js");
    for (const p of ps) {
      let size = 0;
      try { size = (await api("stat", { path: p })).size; } catch { /* */ }
      atts.push({ path: p, nome: p.split(/[\\/]/).pop(), size });
    }
    renderAtts();
    mark();
  }
  function attMenu(e, a) {
    popMenu(e.clientX, e.clientY + 6, [
      { label: tr("mail.apri"), icon: "apri", disabled: !a.path, run: () => ctx.openFile(a.path) },
      { label: tr("mail.firma_prima_invio"), icon: "firma", disabled: !a.path || a.link, run: () => signAtt(a) },
      { label: tr("mail.invia_come_link"), icon: "nuvola", disabled: !a.path || a.link, run: () => linkAtt([a]) },
      "-",
      { label: tr("mail.rimuovi"), icon: "chiudi", run: () => { atts.splice(atts.indexOf(a), 1); renderAtts(); mark(); } },
    ]);
  }
  async function signAtt(a) {
    const { signDialog } = await import("../firma.js");
    const r = await signDialog({ path: a.path, openFile: null });
    if (r?.out) {
      const { api } = await import("../core.js");
      let size = a.size;
      try { size = (await api("stat", { path: r.out })).size; } catch { /* */ }
      Object.assign(a, { path: r.out, nome: r.out.split(/[\\/]/).pop(), size, signed: true });
      renderAtts();
      mark();
    }
  }
  async function linkAtt(list) {
    let svc;
    try {
      const sv = await call("bigfile_services", {});
      const ok = sv.servizi.filter(x => x.connesso);
      if (!ok.length) { await modal(tr("mail.invia_come_link"), el("p", {}, tr("mail.link_nessun_cloud")), [{ label: "OK", value: true, primary: true }]); return false; }
      svc = S.servizio_link && ok.some(x => x.id === S.servizio_link) ? S.servizio_link : ok[0].id;
    } catch (e) { toast(e.message, true); return false; }
    for (const a of list) {
      toast(tr("mail.caricamento_link", a.nome), false, 60000);
      try {
        const { job } = await call("bigfile", { path: a.path, svc });
        const r = await waitJob(job, (p, msg) => toast(`${a.nome}: ${msg || Math.round(p * 100) + "%"}`, false, 60000));
        Object.assign(a, { link: r.url, scade: r.scade || "" });
      } catch (e) { toast(e.message, true, 8000); return false; }
    }
    toast(tr("mail.link_pronti"));
    renderAtts();
    mark();
    return true;
  }
  ctx.tab.view.addEventListener("dragover", e => { e.preventDefault(); });
  renderAtts();

  // ---------------------------------------------------------- barra comandi
  const sendBtn = el("button", { class: "primary", title: tr("mail.invia") + " (Ctrl+Invio)", onclick: () => send() }, el("span", { class: "mi", html: IC.invia }), tr("mail.invia"));
  const laterBtn = el("button", { class: "icon", title: tr("mail.invio_posticipato"), html: IC.orologio, onclick: e => laterMenu(e) });
  const prioBtn = el("button", { class: "icon", title: tr("mail.priorita_alta"), html: IC.importante, onclick: () => { priority = priority === 1 ? 0 : 1; prioBtn.classList.toggle("on", priority === 1); mark(); } });
  const rcptBtn = el("button", { class: "icon", title: tr("mail.richiedi_conferma_lettura"), html: IC.ricevuta, onclick: () => { receipt = !receipt; rcptBtn.classList.toggle("on", receipt); mark(); } });
  prioBtn.classList.toggle("on", priority === 1);
  const laterNote = el("span", { class: "chip warn", hidden: true });
  ctx.tb.classList.add("ml-tb");
  ctx.tb.append(sendBtn, laterBtn, el("span", { class: "sep" }),
    el("button", { title: tr("mail.allega_file"), onclick: addFiles }, el("span", { class: "mi", html: IC.allegato }), tr("mail.allega")),
    el("button", { title: tr("mail.salva_bozza") + " (Ctrl+S)", onclick: () => saveDraft(true) }, el("span", { class: "mi", html: IC.bozze }), tr("mail.salva_bozza")),
    el("span", { class: "sep" }), prioBtn, rcptBtn, laterNote, el("span", { class: "grow" }),
    el("button", { title: tr("mail.scarta"), onclick: () => discard() }, el("span", { class: "mi", html: IC.elimina }), tr("mail.scarta")));

  function laterMenu(e) {
    const at = (h, add = 0) => { const x = new Date(); x.setDate(x.getDate() + add); x.setHours(h, 0, 0, 0); return x.getTime() / 1000; };
    const set = ts => { sendAt = ts; laterNote.hidden = !ts; laterNote.textContent = ts ? tr("mail.invio_il", fmtWhen(ts, true)) : ""; sendBtn.lastChild.textContent = ts ? tr("mail.programma") : tr("mail.invia"); };
    popMenu(e.clientX, e.clientY + 8, [
      { label: tr("mail.domani_mattina"), icon: "orologio", run: () => set(at(8, 1)) },
      { label: tr("mail.domani_pomeriggio"), icon: "orologio", run: () => set(at(14, 1)) },
      { label: tr("mail.lunedi"), icon: "orologio", run: () => { const x = new Date(); x.setDate(x.getDate() + ((8 - x.getDay()) % 7 || 7)); x.setHours(8, 0, 0, 0); set(x.getTime() / 1000); } },
      { label: tr("mail.data_personalizzata"), icon: "calendario", run: async () => { const ts = await askDate(tr("mail.invio_posticipato")); if (ts) set(ts); } },
      sendAt ? "-" : null,
      sendAt ? { label: tr("mail.invia_subito"), icon: "invia", run: () => set(0) } : null,
    ]);
  }

  // ---------------------------------------------------------- composizione dei dati
  function data() {
    const from = fromSel.value.split("|");
    const links = atts.filter(a => a.link);
    let html = ed.innerHTML;
    if (links.length) {
      const items = links.map(a => `<li><a href="${a.link}">${a.nome.replace(/</g, "&lt;")}</a> (${fmtSize(a.size)})${a.scade ? " - " + tr("mail.link_scade", a.scade) : ""}</li>`).join("");
      const block = `<div class="mbv-links" style="margin:12px 0;padding:10px 14px;border:1px solid #d6d9de;border-radius:8px"><b>${tr("mail.file_condivisi")}</b><ul style="margin:6px 0 0;padding-left:18px">${items}</ul></div>`;
      const sig = html.indexOf('<div class="mbv-firma">'), q = html.indexOf('<div class="mbv-quote">');
      const at = sig >= 0 ? sig : q >= 0 ? q : html.length;
      html = html.slice(0, at) + block + html.slice(at);
    }
    return {
      account: from[0], alias: from[1] || "", to: rTo.value(), cc: rCc.value(), bcc: rBcc.value(), subject: subj.value, html,
      atts: atts.filter(a => !a.link).map(a => ({ path: a.path, nome: a.nome })), in_reply_to: c.in_reply_to, refs: c.refs,
      reply_to_id: c.reply_to_id, forward: c.forward, priority, ricevuta: receipt, draft_id: draftId,
    };
  }

  async function saveDraft(showToast) {
    const r = await call("draft", { c: data() });
    draftId = r.draft_id;
    dirty = false;
    ctx.setDirty(false);
    if (showToast) toast(tr("mail.bozza_salvata"));
    return r;
  }

  async function send() {
    if (sending) return;
    rTo.commit(); rCc.commit(); rBcc.commit();
    const d = data();
    if (!d.to.length && !d.cc.length && !d.bcc.length) { toast(tr("mail.nessun_destinatario"), true); rTo.focus(); return; }
    const bad = [...d.to, ...d.cc, ...d.bcc].filter(x => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.a));
    if (bad.length) { toast(tr("mail.indirizzi_non_validi", bad.map(x => x.a).join(", ")), true, 6000); return; }
    if (!d.subject.trim() && !(await confirm2(tr("mail.senza_oggetto_titolo"), tr("mail.senza_oggetto_domanda")))) return;
    // promemoria allegati (come Outlook): il testo parla di un allegato ma non ce n'e'
    const plain = ed.innerText.split(/\n-{3,}|\n_{3,}/)[0].toLowerCase();
    if (!atts.length && new RegExp(tr("mail.parole_allegato"), "i").test(plain.replace(ed.querySelector(".mbv-quote")?.innerText.toLowerCase() || "", "")) &&
      !(await confirm2(tr("mail.allegato_dimenticato"), tr("mail.allegato_dimenticato_domanda")))) return;
    const limit = (S.soglia_link || 20) * 1024 * 1024;
    const heavy = atts.filter(a => !a.link && a.size);
    const tot = heavy.reduce((s, a) => s + a.size, 0);
    if (tot > limit) {
      const r = await modal(tr("mail.allegati_pesanti"), el("p", {}, tr("mail.allegati_pesanti_testo", fmtSize(tot))),
        [{ label: tr("common.annulla"), value: null }, { label: tr("mail.invia_comunque"), value: "no" }, { label: tr("mail.invia_come_link"), value: "link", primary: true }]);
      if (!r) return;
      if (r === "link" && !(await linkAtt(heavy.filter(a => a.size > 2 * 1024 * 1024).length ? heavy.filter(a => a.size > 2 * 1024 * 1024) : heavy))) return;
    }
    sending = true;
    sendBtn.disabled = true;
    try {
      const r = await call("send", { c: data(), send_at: sendAt || 0 });
      void r;
      dirty = false;
      ctx.setDirty(false);
      toast(sendAt ? tr("mail.programmato_per", fmtWhen(sendAt, true)) : tr("mail.messaggio_in_invio"));
      closeTab();
    } catch (e) {
      toast(e.message, true, 8000);
    } finally { sending = false; sendBtn.disabled = false; }
  }
  const confirm2 = (title, text) => modal(title, el("p", {}, text), [{ label: tr("common.annulla"), value: false }, { label: tr("mail.invia_comunque"), value: true, primary: true }]);

  async function discard() {
    if (dirty || draftId) {
      const r = await modal(tr("mail.scarta"), el("p", {}, tr("mail.scarta_domanda")), [{ label: tr("common.annulla"), value: false }, { label: tr("mail.scarta"), value: true, danger: true }]);
      if (!r) return;
      if (draftId) await call("delete", { ids: [draftId], permanent: true }).catch(() => { /* */ });
    }
    dirty = false;
    ctx.setDirty(false);
    closeTab();
  }
  function closeTab() { window.MB.closeTab(ctx.tab); }

  // ---------------------------------------------------------- impaginazione
  const head = el("div", { class: "ml-chead" },
    el("div", { class: "ml-crow" }, el("span", { class: "k" }, tr("mail.da")), fromSel),
    rTo.row, rCc.row, rBcc.row,
    el("div", { class: "ml-crow" }, el("span", { class: "k" }, tr("mail.oggetto")), subj));
  const box = el("div", { class: "ml-compose" }, pecNote, head, attBox, fbar, el("div", { class: "ml-edwrap" }, ed));
  ctx.el.append(box);
  (c.to?.length ? (c.mode === "forward" ? rTo : null) : rTo)?.focus();
  if (c.to?.length && c.mode !== "forward") { ed.focus(); const r = document.createRange(); r.setStart(ed.firstChild || ed, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); }
  if (c.sign_first) { const a = atts.find(x => x.path === c.sign_first) || (await addPaths([c.sign_first]), atts.at(-1)); signAtt(a); }
  if (c.atts?.length && c.mode === "new") renderAtts();

  keymap(ctx, "Outlook", [
    { keys: "Ctrl+Enter", desc: tr("mail.invia"), inFields: true, run: () => send() },
    { keys: "Ctrl+S", desc: tr("mail.salva_bozza"), inFields: true, run: () => saveDraft(true) },
    { keys: "Ctrl+K", desc: tr("mail.inserisci_link"), inFields: true, run: () => insertLink() },
    { keys: "Ctrl+Shift+B", desc: tr("mail.q_ccn"), inFields: true, run: () => { rBcc.row.hidden = false; bccBtn.remove(); rBcc.focus(); } },
  ]);
  const auto = setInterval(() => { if (dirty && !sending) saveDraft(false).catch(() => { /* */ }); }, 60000);
  return {
    save: () => saveDraft(true),
    dispose() { clearInterval(auto); },
    acceptDrop: async paths => { await addPaths(paths); return true; },
    noConvert: true,
  };
}

// ------------------------------------------------------------------ campo destinatari con completamento
function recipients(label, initial, onChange) {
  const list = [...(initial || [])];
  const chips = el("div", { class: "ml-chips" });
  const input = el("input", { type: "text", class: "ml-rin", autocomplete: "off" });
  const sug = el("div", { class: "menu ml-sug", hidden: true });
  const row = el("div", { class: "ml-crow" }, el("span", { class: "k" }, label), el("div", { class: "ml-rbox" }, chips, input), sug);
  let items = [], idx = 0, timer;
  const render = () => {
    chips.innerHTML = "";
    for (const x of list) {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.a);
      chips.append(el("span", { class: "ml-chip" + (ok ? "" : " bad"), title: x.a }, x.n || x.a,
        el("button", { html: IC.chiudi, onclick: () => { list.splice(list.indexOf(x), 1); render(); onChange(); } })));
    }
  };
  const add = (x) => { if (x.a && !list.some(y => y.a.toLowerCase() === x.a.toLowerCase())) { list.push(x); render(); onChange(); } };
  const parse = text => {
    for (const part of text.split(/[;,\n]+/)) {
      const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) || part.match(/^\s*(\S+@\S+)\s*$/);
      if (!m) continue;
      if (m[2]) add({ n: m[1].trim(), a: m[2].trim() }); else add({ n: "", a: m[1].trim() });
    }
  };
  const commit = () => { if (input.value.trim()) { parse(input.value); input.value = ""; } sug.hidden = true; };
  const showSug = () => {
    sug.innerHTML = "";
    if (!items.length) { sug.hidden = true; return; }
    items.forEach((x, i) => sug.append(el("button", { class: i === idx ? "on" : "", onmousedown: e => { e.preventDefault(); add(x); input.value = ""; sug.hidden = true; } },
      el("span", {}, x.n || x.a), x.n ? el("span", { class: "hint" }, x.a) : null)));
    sug.hidden = false;
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (/[;,]$/.test(input.value)) { commit(); return; }
    if (!q) { sug.hidden = true; return; }
    timer = setTimeout(async () => { try { items = (await call("suggest", undefined, { q })).items; idx = 0; showSug(); } catch { /* */ } }, 150);
  });
  input.addEventListener("keydown", e => {
    if (!sug.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; showSug(); }
    else if ((e.key === "Enter" || e.key === "Tab") && !sug.hidden && items[idx]) { if (e.key === "Enter") e.preventDefault(); add(items[idx]); input.value = ""; sug.hidden = true; }
    else if (e.key === "Enter" || e.key === ";") { if (input.value.trim()) { e.preventDefault(); commit(); } }
    else if (e.key === "Backspace" && !input.value && list.length) { list.pop(); render(); onChange(); }
    else if (e.key === "Escape") sug.hidden = true;
  });
  input.addEventListener("blur", () => setTimeout(commit, 120));
  input.addEventListener("paste", e => { const t = e.clipboardData.getData("text"); if (/[;,\n]/.test(t) || /@/.test(t)) { e.preventDefault(); parse(t); } });
  row.addEventListener("click", e => { if (e.target === row || e.target.classList.contains("ml-rbox")) input.focus(); });
  render();
  return { row, value: () => { return [...list]; }, focus: () => input.focus(), commit };
}

export { tn };
