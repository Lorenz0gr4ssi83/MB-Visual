// Posta dell'app per telefono - interfaccia (scheda "Posta" della barra in basso di ui/js/phone.js).
// Account IMAP/SMTP (anche PEC: ricevute e buste certificate riconosciute), cartelle, elenco con i non letti, lettura sicura
// (niente script, immagini remote solo a richiesta), allegati aperti nei visualizzatori di MB Desk, risposta, inoltro,
// nuovo messaggio con allegati, sposta/elimina/contrassegna. Motore in ui/js/mmailcore.js.
import { el, fmtSize, toast } from "./core.js";
import { t, LOCALE } from "./i18n.js";
import * as M from "./mmailcore.js";

let P = null;           // aiuti del guscio del telefono (phone.js): actionSheet, pushView, haptic, deliver, pick, setBadge
let S = null;           // schermata Posta
let cur = { acc: null, folder: "INBOX" };
let accs = [];
let query = "";
let syncing = false;
const PAGE = 50;

const I = d => `<svg viewBox="0 0 24 24">${d.startsWith("<") ? d : `<path d="${d}"/>`}</svg>`;
const IC = {
  compose: I("M20 12.5V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h8.5M18 3.5l2.5 2.5-7.5 7.5H10.5V11z"),
  refresh: I("M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"),
  folder: I("M3 6h6l2 2h10v11H3z"),
  reply: I("M9 14L4 9l5-5M4 9h11a5 5 0 0 1 5 5v5"),
  replyall: I("M12 14L7 9l5-5M7 9h8a5 5 0 0 1 5 5v5M8 14L3 9l5-5"),
  forward: I("M15 14l5-5-5-5M20 9H9a5 5 0 0 0-5 5v5"),
  trash: I("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"),
  flag: I("M5 21V4M5 4h11l-2 4 2 4H5"),
  read: I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>'),
  move: I("M3 6h6l2 2h10v11H3zM12 13h6M15 10l3 3-3 3"),
  clip: I("M20 11.5l-8.2 8.2a5 5 0 0 1-7-7l8.8-8.8a3.3 3.3 0 0 1 4.7 4.7l-8.8 8.8a1.7 1.7 0 0 1-2.4-2.4l8.2-8.2"),
  more: I('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>'),
  account: I('<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5c1-3.6 3.9-5.5 7.5-5.5s6.5 1.9 7.5 5.5"/>'),
  plus: I("M12 5v14M5 12h14"),
  shield: I("M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z M8.5 12l2.5 2.5 4.5-5"),
  image: I('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="M21 15.5l-5-5L5 20"/>'),
  open: I("M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"),
  save: I("M12 3v12M7 10l5 5 5-5M4 21h16"),
  x: I("M6 6l12 12M18 6L6 18"),
};
const btn = (cls, icon, label, onclick, attrs = {}) => { const b = el("button", { type: "button", class: cls, onclick, ...attrs }); if (icon) b.insertAdjacentHTML("beforeend", IC[icon] || icon); if (label) b.append(el("span", {}, label)); return b; };
const boxKey = (a, f) => `${a.id}|${f}`;
const fmtWhen = ms => {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  if (now - d < 6 * 86400000) return d.toLocaleDateString(LOCALE, { weekday: "short" });
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "2-digit" });
};
const who = a => a?.name || a?.address || "";
const RIC = { "accettazione": "mm.ric_accettazione", "non-accettazione": "mm.ric_non_accettazione", "presa-in-carico": "mm.ric_presa", "avvenuta-consegna": "mm.ric_consegna",
  "errore-consegna": "mm.ric_errore", "preavviso-errore-consegna": "mm.ric_preavviso", "rilevazione-virus": "mm.ric_virus" };

// ------------------------------------------------------------------ schermata Posta
export async function buildMail(screen, helpers) {
  P = helpers; S = screen;
  accs = await M.accounts();
  const saved = await M.kvGet("corrente").catch(() => null);
  cur.acc = accs.find(a => a.id === saved?.acc) || accs[0] || null;
  cur.folder = cur.acc ? (saved?.acc === cur.acc.id && saved.folder) || "INBOX" : "INBOX";
  draw();
  if (cur.acc) sync().catch(() => {});
}

function draw() {
  const b = S.body;
  b.innerHTML = "";
  S.act.innerHTML = "";
  S.large.textContent = cur.acc ? folderLabel(cur.acc, cur.folder) : t("mail.posta");
  if (!accs.length) {
    b.append(el("div", { class: "ph-emptybox mm-empty" }, el("span", { class: "ph-ei", html: IC.read }), el("b", {}, t("mm.nessun_account")),
      el("span", {}, t("mm.nessun_account_testo")),
      btn("ph-open mm-add", "plus", t("mm.aggiungi_account"), () => accountView())));
    return;
  }
  S.act.append(btn("ph-vb mm-hb", "refresh", null, () => sync(true), { "aria-label": t("mm.aggiorna") }), btn("ph-vb mm-hb", "compose", null, () => compose({}), { "aria-label": t("mail.nuovo_messaggio") }));
  // account e cartella
  const bar = el("div", { class: "mm-bar" });
  bar.append(btn("mm-chip", "account", cur.acc.nome || cur.acc.email, () => accountSheet()));
  bar.append(btn("mm-chip", "folder", folderLabel(cur.acc, cur.folder), () => folderSheet()));
  const qi = el("input", { type: "search", class: "ph-search", placeholder: t("mm.cerca"), value: query, enterkeyhint: "search" });
  qi.addEventListener("input", () => { query = qi.value; drawList(); });
  b.append(bar, el("div", { class: "ph-searchwrap" }, el("span", { class: "ph-si", html: I('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>') }), qi),
    el("div", { class: "mm-status", id: "mm-status" }), el("div", { class: "mm-list", id: "mm-list" }));
  drawList();
}

function folderLabel(a, f) { const x = (a.folders || []).find(y => y.name === f); return x ? x.label : f.toUpperCase() === "INBOX" ? t("mm.posta_arrivo") : M.utf7Decode(f); }
const roleFolder = (a, role) => (a.folders || []).find(f => f.role === role)?.name;

async function drawList() {
  const box = document.getElementById("mm-list");
  if (!box || !cur.acc) return;
  let msgs = (await M.boxMsgs(boxKey(cur.acc, cur.folder))).sort((a, b) => b.date - a.date);
  if (!msgs.length && syncing) { box.innerHTML = ""; box.append(...Array.from({ length: 6 }, () => el("div", { class: "mm-row ph-skel" }, el("span", { class: "mm-rt" }, el("i"), el("i"))))); return; }
  const f = query.trim().toLowerCase();
  if (f) msgs = msgs.filter(m => (m.subject + " " + who(m.from) + " " + (m.from?.address || "")).toLowerCase().includes(f));
  box.innerHTML = "";
  if (!msgs.length) { box.append(el("div", { class: "ph-emptybox" }, el("b", {}, f ? t("ph.nessun_risultato") : t("mm.cartella_vuota")))); return; }
  for (const m of msgs) box.append(row(m));
  if (!f && cur.acc.more?.[cur.folder]) box.append(btn("ph-link mm-more", null, t("mm.carica_altri"), () => sync(false, true)));
}

function row(m) {
  const unread = !m.flags.includes("\\Seen"), flagged = m.flags.includes("\\Flagged");
  const sentBox = ["sent", "drafts"].includes((cur.acc.folders || []).find(x => x.name === cur.folder)?.role);
  const chips = [];
  if (m.pec?.ricevuta) chips.push(el("span", { class: "mm-pec" + (m.pec.ok ? "" : " bad") }, t(RIC[m.pec.ricevuta] || "mm.ricevuta")));
  else if (m.pec?.busta) chips.push(el("span", { class: "mm-pec" }, "PEC"));
  const r = el("div", { class: "mm-row" + (unread ? " unread" : ""), role: "button", tabindex: 0, onclick: () => openMsg(m) },
    el("span", { class: "mm-dot" }),
    el("span", { class: "mm-rt" },
      el("span", { class: "mm-r1" }, el("b", {}, sentBox ? (m.to?.map(who).join(", ") || "-") : who(m.from) || "-"), el("time", {}, fmtWhen(m.date))),
      el("span", { class: "mm-r2" }, ...chips, el("span", {}, m.subject || t("mm.senza_oggetto")), m.att ? el("span", { class: "mm-clip", html: IC.clip }) : null, flagged ? el("span", { class: "mm-flag", html: IC.flag }) : null)));
  r.addEventListener("contextmenu", e => { e.preventDefault(); msgMenu(m); });
  return r;
}

function status(text, bad = false) { const s = document.getElementById("mm-status"); if (s) { s.textContent = text || ""; s.classList.toggle("bad", bad); } }

// ------------------------------------------------------------------ sincronizzazione (passaggio IMAP del server)
export async function sync(manual = false, older = false) {
  const a = cur.acc;
  if (!a || syncing) return;
  syncing = true;
  status(t("mm.aggiornamento"));
  if (manual) P.haptic();
  try {
    const folder = cur.folder;
    const needList = !a.folders || Date.now() - (a.foldersAt || 0) > 600000 || manual;
    const steps = [];
    if (needList) steps.push({ cmd: 'LIST "" "*"' });
    steps.push({ cmd: `EXAMINE ${M.q(folder)}` }, { cmd: "UID SEARCH ALL" });
    if (folder.toUpperCase() !== "INBOX") steps.push({ cmd: 'STATUS "INBOX" (UNSEEN)' });
    let res = await M.imap(a, steps);
    let k = 0;
    if (needList) { a.folders = M.parseFolders(res[k++].raw); a.foldersAt = Date.now(); }
    const sel = M.parseResponses(res[k++].raw);
    const validity = sel.map(r => /\[UIDVALIDITY (\d+)/.exec(r.dati.join(" "))?.[1]).find(Boolean) || "";
    const uids = M.parseResponses(res[k++].raw).filter(r => r.tipo === "SEARCH").flatMap(r => r.dati.map(Number)).filter(Boolean).sort((x, y) => y - x);
    if (folder.toUpperCase() !== "INBOX") { const st = M.parseResponses(res[k++].raw).find(r => r.tipo === "STATUS")?.dati[1] || []; const i = st.findIndex(x => String(x).toUpperCase() === "UNSEEN"); if (i >= 0) a.unread = +st[i + 1]; }
    const key = boxKey(a, folder);
    let cached = await M.boxMsgs(key);
    a.validity = a.validity || {};
    if (validity && a.validity[folder] && a.validity[folder] !== validity) { await M.delMsgs(cached.map(m => m.k)); cached = []; }
    if (validity) a.validity[folder] = validity;
    const have = new Set(cached.map(m => m.uid));
    const all = new Set(uids);
    // quanti messaggi tenere: i 50 piu' recenti, oppure quelli gia' scaricati + 50 con "Carica altri"
    const want = older ? Math.min(uids.length, have.size + PAGE) : Math.max(Math.min(uids.length, PAGE), [...have].filter(u => all.has(u)).length);
    const win = uids.slice(0, want);
    const gone = cached.filter(m => !all.has(m.uid));
    if (gone.length) await M.delMsgs(gone.map(m => m.k));
    const fresh = win.filter(u => !have.has(u));
    a.more = a.more || {};
    a.more[folder] = uids.length > win.length;
    const st2 = [{ cmd: `EXAMINE ${M.q(folder)}` }];
    if (fresh.length) st2.push({ cmd: `UID FETCH ${fresh.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])` });
    if (win.length) st2.push({ cmd: `UID FETCH ${win[win.length - 1]}:* (UID FLAGS)` });
    res = win.length ? await M.imap(a, st2) : [];
    const recs = [];
    if (fresh.length) for (const r of M.parseResponses(res[1].raw)) if (r.tipo === "FETCH") recs.push(await toRec(a, folder, M.fetchMap(r.dati[0] || [])));
    if (recs.length) await M.putMsgs(recs);
    // contrassegni aggiornati (letti altrove, contrassegnati...)
    const flagRes = res[res.length - 1];
    if (win.length && flagRes) {
      const byUid = new Map((await M.boxMsgs(key)).map(m => [m.uid, m]));
      const upd = [];
      for (const r of M.parseResponses(flagRes.raw)) {
        if (r.tipo !== "FETCH") continue;
        const fm = M.fetchMap(r.dati[0] || []);
        const m = byUid.get(+fm.UID);
        const fl = (fm.FLAGS || []).map(String);
        if (m && fl.sort().join() !== [...m.flags].sort().join()) { m.flags = fl; upd.push(m); }
      }
      if (upd.length) await M.putMsgs(upd);
    }
    // non letti della Posta in arrivo per il numero sulla scheda
    if (folder.toUpperCase() === "INBOX") a.unread = (await M.boxMsgs(key)).filter(m => !m.flags.includes("\\Seen")).length;
    a.lastSync = Date.now();
    await M.saveAccount(a);
    status("");
    updateBadge();
  } catch (e) {
    status(e.message, true);
    if (manual) toast(e.message, true, 6000);
  } finally {
    syncing = false;
    if (document.getElementById("mm-list")) { drawList(); const ch = S.body.querySelectorAll(".mm-chip"); if (ch[1]) ch[1].querySelector("span").textContent = folderLabel(cur.acc, cur.folder); }
  }
}

async function toRec(a, folder, fm) {
  const hdr = Object.entries(fm).find(([k]) => k.startsWith("BODY["))?.[1];
  const h = await M.headers(hdr instanceof Uint8Array ? hdr : new Uint8Array());
  const from = (await M.addresses(h.from))[0] || null;
  const date = Date.parse(h.date) || Date.parse(fm.INTERNALDATE) || Date.now();
  return { k: `${a.id}|${folder}|${fm.UID}`, box: boxKey(a, folder), acc: a.id, folder, uid: +fm.UID, flags: (fm.FLAGS || []).map(String), size: +fm["RFC822.SIZE"] || 0,
    date, from, to: await M.addresses(h.to), cc: await M.addresses(h.cc), replyTo: (await M.addresses(h["reply-to"]))[0] || null, subject: h.subject || "",
    msgid: h["message-id"] || "", refs: [h.references, h["in-reply-to"]].filter(Boolean).join(" "), att: /multipart\/(mixed|report)/i.test(h["content-type"] || ""), pec: M.pecKind(h) };
}

// tutti gli account (Posta in arrivo) ogni 3 minuti mentre l'app e' aperta, per il numero sulla scheda Posta
export async function background() {
  const list = await M.accounts();
  for (const a of list) {
    try {
      const r = await M.imap(a, [{ cmd: 'STATUS "INBOX" (UNSEEN)' }]);
      const st = M.parseResponses(r[0].raw).find(x => x.tipo === "STATUS");
      const l = st?.dati[1] || [];
      const i = l.findIndex(x => String(x).toUpperCase() === "UNSEEN");
      if (i >= 0) { a.unread = +l[i + 1]; await M.saveAccount(a); }
    } catch { /* rete assente: si riprova piu' tardi */ }
  }
  accs = await M.accounts();
  updateBadge();
}
async function updateBadge() { const list = await M.accounts(); P?.setBadge?.(list.reduce((s, a) => s + (a.unread || 0), 0)); }
export async function badgeOnly(helpers) { P = P || helpers; await updateBadge(); }

// ------------------------------------------------------------------ cartelle e account
function folderSheet() {
  const a = cur.acc;
  P.actionSheet({ title: a.nome || a.email, items: (a.folders || [{ name: "INBOX", label: t("mm.posta_arrivo") }]).map(f => ({
    label: (f.depth ? " ".repeat(Math.min(f.depth, 3)) : "") + f.label, icon: IC.folder, disabled: f.name === cur.folder,
    run: () => { cur.folder = f.name; M.kvSet("corrente", { acc: a.id, folder: f.name }); query = ""; draw(); sync(); },
  })) });
}
function accountSheet() {
  P.actionSheet({ title: t("mm.account"), items: [
    ...accs.map(a => ({ label: a.nome || a.email, sub: a.email + (a.unread ? ` · ${t("mm.non_letti", a.unread)}` : ""), icon: IC.account, disabled: a === cur.acc,
      run: () => { cur = { acc: a, folder: "INBOX" }; M.kvSet("corrente", { acc: a.id, folder: "INBOX" }); draw(); sync(); } })),
    "sep",
    { label: t("mm.aggiungi_account"), icon: IC.plus, run: () => accountView() },
    { label: t("mm.impostazioni_account"), icon: IC.more, run: () => accountView(cur.acc) },
  ] });
}

// aggiungi / modifica un account
function accountView(edit = null) {
  const v = P.pushView({ title: edit ? edit.nome || edit.email : t("mm.aggiungi_account") });
  const f = (label, input, note) => el("label", { class: "mm-field" }, el("span", {}, label), input, note ? el("small", {}, note) : null);
  const email = el("input", { type: "email", autocomplete: "email", inputmode: "email", value: edit?.email || "", placeholder: "nome@dominio.it" });
  const pass = el("input", { type: "password", autocomplete: "current-password", placeholder: edit ? t("mm.password_invariata") : "" });
  const name = el("input", { type: "text", autocomplete: "name", value: edit?.mittente || "", placeholder: t("mm.nome_mittente_ph") });
  const info = el("div", { class: "mm-detect" });
  const sec = () => el("select", {}, el("option", { value: "ssl" }, "SSL/TLS"), el("option", { value: "starttls" }, "STARTTLS"));
  const ih = el("input", { type: "text", autocapitalize: "off" }), ip = el("input", { type: "number", inputmode: "numeric" }), is = sec();
  const sh = el("input", { type: "text", autocapitalize: "off" }), sp = el("input", { type: "number", inputmode: "numeric" }), ss = sec();
  const user = el("input", { type: "text", autocapitalize: "off", placeholder: t("mm.utente_ph") });
  const pec = el("input", { type: "checkbox" }), sent = el("input", { type: "checkbox", checked: true });
  let cfg = null;
  const fill = c => { ih.value = c.imap.host; ip.value = c.imap.port; is.value = c.imap.sec; sh.value = c.smtp.host; sp.value = c.smtp.port; ss.value = c.smtp.sec; pec.checked = !!c.pec; sent.checked = c.salva_inviati !== false; };
  const detect = () => {
    if (edit) return;
    info.innerHTML = "";
    if (!/@[^@]+\.[a-z]{2,}$/i.test(email.value.trim())) return;
    cfg = M.guess(email.value.trim());
    if (cfg.microsoft) { info.append(el("p", { class: "bad" }, t("mm.microsoft_pc"))); return; }
    fill(cfg);
    info.append(el("p", {}, el("b", {}, cfg.preset ? cfg.nome : t("mm.impostazioni_ipotesi")), cfg.pec ? el("span", { class: "mm-pec" }, "PEC") : null));
    if (cfg.nota) info.append(el("p", { class: "note" }, t(cfg.nota)));
  };
  email.addEventListener("input", detect);
  if (edit) { fill(edit); user.value = edit.imap.user || ""; }
  const adv = el("details", { class: "mm-adv", open: edit ? true : undefined }, el("summary", {}, t("mm.impostazioni_server")),
    el("div", { class: "mm-grid" }, f(t("mm.server_imap"), ih), f(t("mm.porta"), ip), f(t("mm.sicurezza"), is),
      f(t("mm.server_smtp"), sh), f(t("mm.porta"), sp), f(t("mm.sicurezza"), ss)),
    f(t("mm.utente"), user),
    el("label", { class: "mm-check" }, pec, t("mm.casella_pec")),
    el("label", { class: "mm-check" }, sent, t("mm.salva_inviati")));
  const err = el("p", { class: "mm-err" });
  const go = el("button", { type: "button", class: "ph-open mm-go" }, el("span", {}, edit ? t("common.salva") : t("mm.accedi")));
  go.addEventListener("click", async () => {
    err.textContent = "";
    const addr = email.value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(addr)) { err.textContent = t("mm.indirizzo_non_valido"); return; }
    if (cfg?.microsoft && !edit) { err.textContent = t("mm.microsoft_pc"); return; }
    if (!edit && !pass.value) { err.textContent = t("mm.serve_password"); return; }
    const a = edit ? { ...edit } : { id: "a" + Date.now().toString(36), ord: Date.now() };
    Object.assign(a, { email: addr, nome: (cfg?.preset && cfg.nome) || a.nome || addr, mittente: name.value.trim(), pec: pec.checked, salva_inviati: sent.checked,
      imap: { host: ih.value.trim(), port: +ip.value || 993, sec: is.value, user: user.value.trim() || addr }, smtp: { host: sh.value.trim(), port: +sp.value || 465, sec: ss.value, user: user.value.trim() || addr } });
    if (pass.value) a.secret = await M.seal(pass.value);
    go.disabled = true; go.querySelector("span").textContent = t("mm.verifica");
    try {
      const r = await M.imap(a, [{ cmd: 'LIST "" "*"' }]);
      a.folders = M.parseFolders(r[0].raw); a.foldersAt = Date.now();
      await M.saveAccount(a);
      accs = await M.accounts();
      cur = { acc: accs.find(x => x.id === a.id), folder: "INBOX" };
      await M.kvSet("corrente", { acc: a.id, folder: "INBOX" });
      P.haptic(); toast(t("mm.account_pronto", addr));
      v.close(); draw(); sync();
    } catch (e) {
      err.textContent = e.message;
      if (e.auth && !adv.open) adv.open = false;
    } finally { go.disabled = false; go.querySelector("span").textContent = edit ? t("common.salva") : t("mm.accedi"); }
  });
  v.body.append(el("div", { class: "mm-form" }, f(t("mm.indirizzo"), email), f(t("mm.password"), pass, t("mm.password_nota")), f(t("mm.nome_mittente"), name), info, adv, err, go,
    edit ? btn("ph-link danger mm-del", null, t("mm.rimuovi_account"), async () => {
      if (!(await window.MB.modal(t("mm.rimuovi_account"), el("p", {}, t("mm.rimuovi_testo", edit.email)), [{ label: t("common.annulla"), value: false }, { label: t("mm.rimuovi"), value: true, danger: true }]))) return;
      await M.removeAccount(edit.id);
      accs = await M.accounts();
      cur = { acc: accs[0] || null, folder: "INBOX" };
      v.close(); draw(); updateBadge();
    }) : null,
    el("p", { class: "ph-note" }, t("mm.privacy"))));
  if (!edit) setTimeout(() => email.focus(), 300);
}

// ------------------------------------------------------------------ lettura
async function rawOf(m) {
  let blob = await M.getBody(m.k);
  if (!blob) {
    const a = accs.find(x => x.id === m.acc);
    const r = await M.imap(a, [{ cmd: `SELECT ${M.q(m.folder)}` }, { cmd: `UID FETCH ${m.uid} (UID FLAGS BODY[])` }]);
    const fr = M.parseResponses(r[1].raw).find(x => x.tipo === "FETCH");
    const fm = M.fetchMap(fr?.dati[0] || []);
    const body = fm["BODY[]"];
    if (!(body instanceof Uint8Array)) throw new M.MailError(t("mm.err_messaggio"));
    blob = new Blob([body], { type: "message/rfc822" });
    await M.putBody(m.k, blob);
    if (fm.FLAGS) { m.flags = fm.FLAGS.map(String); await M.putMsgs([m]); }
  }
  return blob;
}

async function parse(blob) {
  const { default: PostalMime } = await M.postal();
  const msg = await PostalMime.parse(new Uint8Array(await blob.arrayBuffer()));
  // PEC: il messaggio vero e' nella busta (postacert.eml); i dati del gestore in daticert.xml
  const h = Object.fromEntries((msg.headers || []).map(x => [x.key, x.value]));
  const pec = M.pecKind(h);
  let inner = null, dati = null;
  for (const at of msg.attachments || []) {
    const nm = (at.filename || "").toLowerCase();
    if (nm === "postacert.eml" || (pec?.busta && at.mimeType === "message/rfc822")) inner = await PostalMime.parse(at.content);
    if (nm === "daticert.xml") try { dati = new DOMParser().parseFromString(new TextDecoder().decode(at.content), "application/xml"); } catch { /* */ }
  }
  return { msg, pec, inner, dati };
}

async function openMsg(m) {
  P.haptic(4);
  const a = accs.find(x => x.id === m.acc);
  const v = P.pushView({ title: "", actions: [
    { icon: IC.reply, label: t("mm.rispondi"), run: () => reply(m, "reply") },
    { icon: IC.trash, label: t("common.elimina"), run: () => removeMsg(m).then(ok => ok && v.close()) },
    { icon: IC.more, label: t("ph.altro"), run: () => msgMenu(m, v) },
  ] });
  v.body.append(el("div", { class: "ph-skeleton mm-skel" }, el("div", { class: "ph-sk-page" }, el("i", { class: "h" }), el("i"), el("i"), el("i", { class: "s" }), el("i", { class: "b" }))));
  let blob, p;
  try { blob = await rawOf(m); p = await parse(blob); }
  catch (e) { v.body.innerHTML = ""; v.body.append(el("div", { class: "ph-emptybox" }, el("b", {}, e.message), btn("ph-link", null, t("ph.riprova"), () => { v.close(); openMsg(m); }))); return; }
  // letto: in locale subito, sul server con il FETCH BODY[] (che imposta \Seen)
  if (!m.flags.includes("\\Seen")) { m.flags.push("\\Seen"); M.putMsgs([m]); if (a.unread) { a.unread--; M.saveAccount(a); updateBadge(); } drawList(); }
  const show = p.inner || p.msg;
  v.body.innerHTML = "";
  const addrLine = (label, list) => list?.length ? el("div", { class: "mm-addr" }, el("span", {}, label), el("b", {}, list.map(x => (x.name ? `${x.name} <${x.address}>` : x.address)).join(", "))) : null;
  const head = el("div", { class: "mm-head" },
    el("h2", {}, show.subject || m.subject || t("mm.senza_oggetto")),
    el("div", { class: "mm-from" }, el("span", { class: "mm-av" }, (who(show.from || m.from)[0] || "?").toUpperCase()),
      el("span", {}, el("b", {}, who(show.from || m.from)), el("small", {}, (show.from || m.from)?.address || "")), el("time", {}, new Date(m.date).toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" }))),
    el("details", { class: "mm-more" }, el("summary", {}, t("mm.dettagli")), addrLine(t("mm.a"), show.to || m.to), addrLine("Cc", show.cc || m.cc)));
  v.body.append(head);
  if (p.pec) v.body.append(pecBox(p, m));
  // allegati (anche quelli del messaggio certificato)
  const atts = (show.attachments || []).filter(x => x.disposition !== "inline" || !x.contentId);
  if (atts.length) v.body.append(el("div", { class: "mm-atts" }, ...atts.map(at => attChip(at))));
  // corpo: iframe senza script, immagini remote bloccate finche' non si chiede di mostrarle
  const cid = {};
  for (const at of show.attachments || []) if (at.contentId) cid[at.contentId.replace(/[<>]/g, "")] = URL.createObjectURL(new Blob([at.content], { type: at.mimeType }));
  const frame = el("iframe", { class: "mm-frame", sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox", title: t("mm.messaggio") });
  const hasRemote = /<img[^>]+src=["']?https?:/i.test(show.html || "");
  const render = remote => {
    let html = show.html || `<pre style="white-space:pre-wrap;font:15px/1.45 -apple-system,system-ui,sans-serif;margin:0">${(show.text || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</pre>`;
    html = html.replace(/cid:([^"'\s>)]+)/gi, (x, id) => cid[id] || x);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:${remote ? " https: http:" : ""}`;
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank">
<style>html{-webkit-text-size-adjust:100%}body{margin:0;padding:4px 2px 24px;font:15px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif;color:#1d2024;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#c45f15}</style></head><body>${html}</body></html>`;
  };
  frame.addEventListener("load", () => { try { const d = frame.contentDocument; const fit = () => { frame.style.height = d.documentElement.scrollHeight + 8 + "px"; }; fit(); setTimeout(fit, 400); d.querySelectorAll("img").forEach(i => i.addEventListener("load", fit)); } catch { /* */ } });
  if (hasRemote) {
    const bar = el("div", { class: "mm-remote" }, el("span", { html: IC.image }), el("span", {}, t("mm.immagini_bloccate")), btn("ph-link", null, t("mm.mostra_immagini"), () => { render(true); bar.remove(); }));
    v.body.append(bar);
  }
  v.body.append(el("div", { class: "mm-body" }, frame));
  render(false);
  v.body.append(el("div", { class: "mm-actions" }, btn("mm-abtn", "reply", t("mm.rispondi"), () => reply(m, "reply")), btn("mm-abtn", "replyall", t("mm.rispondi_tutti"), () => reply(m, "all")), btn("mm-abtn", "forward", t("mm.inoltra"), () => reply(m, "fwd"))));
  v.onClose = () => Object.values(cid).forEach(u => URL.revokeObjectURL(u));
}

function attChip(at) {
  const name = at.filename || t("mm.allegato");
  const size = at.content?.byteLength || at.content?.length || 0;
  const blob = () => new Blob([at.content], { type: at.mimeType || "application/octet-stream" });
  const c = el("button", { type: "button", class: "mm-att", onclick: () => P.actionSheet({ title: name, sub: fmtSize(size), items: [
    { label: t("mm.apri_mb"), icon: IC.open, run: () => window.MB.openFile(window.MBV_API.register(blob(), name)) },
    { label: t("ph.condividi"), icon: IC.save, run: () => P.deliver(name, blob()) },
  ] }) }, el("span", { html: IC.clip }), el("span", { class: "mm-an" }, el("b", {}, name), el("small", {}, fmtSize(size))));
  return c;
}

function pecBox(p, m) {
  const k = p.pec;
  const txt = sel => p.dati?.querySelector(sel)?.textContent?.trim() || "";
  const rows = [];
  if (k.ricevuta) rows.push(el("b", {}, t(RIC[k.ricevuta] || "mm.ricevuta")));
  else rows.push(el("b", {}, k.anomalia ? t("mm.pec_anomalia") : t("mm.pec_certificata")));
  const g = txt("dati > data > giorno"), o = txt("dati > data > ora");
  if (g) rows.push(el("small", {}, t("mm.pec_data", `${g} ${o}`)));
  const cons = txt("dati > consegna"), mitt = txt("intestazione > mittente"), gest = txt("dati > gestore-emittente");
  if (cons) rows.push(el("small", {}, t("mm.pec_consegna", cons)));
  if (mitt && !k.ricevuta) rows.push(el("small", {}, t("mm.pec_mittente", mitt)));
  if (gest) rows.push(el("small", {}, t("mm.pec_gestore", gest)));
  void m;
  return el("div", { class: "mm-pecbox" + (k.ok === false || k.anomalia ? " bad" : "") }, el("span", { html: IC.shield }), el("span", {}, ...rows));
}

// ------------------------------------------------------------------ azioni sui messaggi
function msgMenu(m, view = null) {
  const unread = !m.flags.includes("\\Seen"), flagged = m.flags.includes("\\Flagged");
  P.actionSheet({ title: m.subject || t("mm.senza_oggetto"), sub: who(m.from), items: [
    { label: t("mm.rispondi"), icon: IC.reply, run: () => reply(m, "reply") },
    { label: t("mm.rispondi_tutti"), icon: IC.replyall, run: () => reply(m, "all") },
    { label: t("mm.inoltra"), icon: IC.forward, run: () => reply(m, "fwd") },
    "sep",
    { label: unread ? t("mm.segna_letto") : t("mm.segna_non_letto"), icon: IC.read, run: () => setFlag(m, "\\Seen", unread) },
    { label: flagged ? t("mm.togli_contrassegno") : t("mm.contrassegna"), icon: IC.flag, run: () => setFlag(m, "\\Flagged", !flagged) },
    { label: t("mm.sposta"), icon: IC.move, run: () => moveSheet(m, view) },
    { label: t("mm.salva_eml"), icon: IC.save, run: async () => P.deliver(((m.subject || "messaggio").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80)) + ".eml", await rawOf(m)) },
    "sep",
    { label: t("common.elimina"), icon: IC.trash, danger: true, run: () => removeMsg(m).then(ok => ok && view?.close()) },
  ] });
}

async function setFlag(m, flag, on) {
  const a = accs.find(x => x.id === m.acc);
  const prev = [...m.flags];
  m.flags = on ? [...new Set([...m.flags, flag])] : m.flags.filter(f => f !== flag);
  await M.putMsgs([m]); drawList();
  try { await M.imap(a, [{ cmd: `SELECT ${M.q(m.folder)}` }, { cmd: `UID STORE ${m.uid} ${on ? "+" : "-"}FLAGS.SILENT (${flag})` }]); if (flag === "\\Seen" && m.folder.toUpperCase() === "INBOX") { a.unread = Math.max(0, (a.unread || 0) + (on ? -1 : 1)); await M.saveAccount(a); updateBadge(); } }
  catch (e) { m.flags = prev; await M.putMsgs([m]); drawList(); toast(e.message, true, 5000); }
}

function moveSheet(m, view) {
  const a = accs.find(x => x.id === m.acc);
  P.actionSheet({ title: t("mm.sposta_in"), items: (a.folders || []).filter(f => f.name !== m.folder).map(f => ({ label: f.label, icon: IC.folder, run: () => moveMsg(m, f.name).then(ok => ok && view?.close()) })) });
}
async function moveMsg(m, target) {
  const a = accs.find(x => x.id === m.acc);
  try {
    let r = await M.imap(a, [{ cmd: `SELECT ${M.q(m.folder)}` }, { cmd: `UID MOVE ${m.uid} ${M.q(target)}` }]);
    if (r[1].status !== "OK") { // server senza MOVE: copia, segna come eliminato, togli
      r = await M.imap(a, [{ cmd: `SELECT ${M.q(m.folder)}` }, { cmd: `UID COPY ${m.uid} ${M.q(target)}` }, { cmd: `UID STORE ${m.uid} +FLAGS.SILENT (\\Deleted)` }, { cmd: `UID EXPUNGE ${m.uid}` }]);
      if (r[1].status !== "OK") throw new M.MailError(r[1].text);
    }
    await M.delMsgs([m.k]); drawList(); P.haptic();
    return true;
  } catch (e) { toast(e.message, true, 5000); return false; }
}
async function removeMsg(m) {
  const a = accs.find(x => x.id === m.acc);
  const trash = roleFolder(a, "trash");
  if (trash && trash !== m.folder) { const ok = await moveMsg(m, trash); if (ok) toast(t("mm.spostato_cestino")); return ok; }
  if (!(await window.MB.modal(t("mm.elimina_definitivo"), el("p", {}, t("mm.elimina_definitivo_testo")), [{ label: t("common.annulla"), value: false }, { label: t("common.elimina"), value: true, danger: true }]))) return false;
  try {
    await M.imap(a, [{ cmd: `SELECT ${M.q(m.folder)}` }, { cmd: `UID STORE ${m.uid} +FLAGS.SILENT (\\Deleted)` }, { cmd: `UID EXPUNGE ${m.uid}` }]);
    await M.delMsgs([m.k]); drawList();
    return true;
  } catch (e) { toast(e.message, true, 5000); return false; }
}

// ------------------------------------------------------------------ scrittura
async function reply(m, mode) {
  const a = accs.find(x => x.id === m.acc);
  let p = null;
  try { p = await parse(await rawOf(m)); } catch (e) { return toast(e.message, true, 5000); }
  const src = p.inner || p.msg;
  const me = a.email.toLowerCase();
  const from = src.replyTo?.[0] || src.from || m.from;
  const strip = s => (s || "").replace(/^((re|r|i|fw|fwd|inoltro|aw|wg|tr|rv)\s*:\s*)+/i, "");
  const quote = `\n\n${t("mm.citazione", new Date(m.date).toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" }), who(src.from || m.from))}\n` +
    (src.text || "").split(/\r?\n/).map(l => "> " + l).join("\n");
  const base = { account: a, subject: (mode === "fwd" ? t("mm.prefisso_inoltro") : "Re: ") + strip(src.subject || m.subject), text: quote, inReplyTo: m.msgid, references: [m.refs, m.msgid].filter(Boolean).join(" ") };
  if (mode === "fwd") {
    base.inReplyTo = base.references = null;
    base.attachments = (src.attachments || []).filter(x => x.disposition !== "inline" || !x.contentId).map(x => ({ name: x.filename || "allegato", type: x.mimeType, data: new Uint8Array(x.content) }));
    base.text = `\n\n${t("mm.inoltrato")}\n${t("mm.da")}: ${who(src.from)} <${src.from?.address || ""}>\n${t("mm.oggetto")}: ${src.subject || ""}\n\n${src.text || ""}`;
  } else {
    base.to = from ? [from] : [];
    if (mode === "all") base.cc = [...(src.to || []), ...(src.cc || [])].filter(x => x.address && x.address.toLowerCase() !== me && x.address !== from?.address);
  }
  compose(base);
}

// nuovo messaggio; opts: { account, to, cc, subject, text, attachments: [{name, type, data}] }
export async function compose(opts = {}) {
  if (!accs.length) accs = await M.accounts();
  if (!accs.length) { toast(t("mm.prima_account"), true, 5000); return; }
  let a = opts.account || cur.acc || accs[0];
  const atts = [...(opts.attachments || [])];
  const known = await M.kvGet("indirizzi").catch(() => null) || [];
  const dl = el("datalist", { id: "mm-addrs" }, ...known.slice(0, 200).map(x => el("option", { value: x })));
  const toS = l => (l || []).map(x => (x.name ? `${x.name} <${x.address}>` : x.address)).join(", ");
  const inp = (label, value = "", type = "email") => { const i = el("input", { type: type === "email" ? "text" : type, value, list: type === "email" ? "mm-addrs" : null, autocapitalize: "off", inputmode: type === "email" ? "email" : null }); return [el("label", { class: "mm-cf" }, el("span", {}, label), i), i]; };
  const fromSel = el("select", {}, ...accs.map(x => el("option", { value: x.id }, x.email)));
  fromSel.value = a.id;
  fromSel.addEventListener("change", () => { a = accs.find(x => x.id === fromSel.value); });
  const [toL, to] = inp(t("mm.a"), toS(opts.to));
  const [ccL, cc] = inp("Cc", toS(opts.cc));
  const [bccL, bcc] = inp("Ccn", "");
  const [subjL, subj] = inp(t("mm.oggetto"), opts.subject || "", "text");
  const body = el("textarea", { class: "mm-text", placeholder: t("mm.scrivi") });
  body.value = (opts.text || "");
  const attBox = el("div", { class: "mm-atts" });
  const drawAtts = () => { attBox.innerHTML = ""; atts.forEach((x, i) => attBox.append(el("span", { class: "mm-att" }, el("span", { html: IC.clip }), el("span", { class: "mm-an" }, el("b", {}, x.name), el("small", {}, fmtSize(x.data.length))), btn("mm-attx", "x", null, () => { atts.splice(i, 1); drawAtts(); }, { "aria-label": t("common.elimina") })))); };
  drawAtts();
  let sending = false, sent = false;
  const v = P.pushView({ title: t("mail.nuovo_messaggio"), actions: [
    { icon: IC.clip, label: t("mm.allega"), run: async () => { const ps = await P.pick({ multiple: true }); for (const p of ps) { const b = window.MBV_API.blobOf(p); atts.push({ name: p.split("/").pop(), type: b.type, data: new Uint8Array(await b.arrayBuffer()) }); } drawAtts(); } },
    { icon: I("M3 11l18-8-8 18-2-8z"), label: t("mm.invia"), primary: true, run: () => send() },
  ], beforeClose: async () => {
    if (sent || (!body.value.trim() && !to.value.trim() && !atts.length) || body.value === (opts.text || "") && !to.value && !atts.length) return true;
    return !!(await window.MB.modal(t("mm.scarta_titolo"), el("p", {}, t("mm.scarta_testo")), [{ label: t("common.annulla"), value: false }, { label: t("mm.scarta"), value: true, danger: true }]));
  } });
  v.body.append(dl, el("div", { class: "mm-compose" }, accs.length > 1 ? el("label", { class: "mm-cf" }, el("span", {}, t("mm.da")), fromSel) : null, toL, ccL, bccL, subjL, attBox, body));
  setTimeout(() => (to.value ? body : to).focus(), 350);
  const parseList = async s => M.addresses(s);
  async function send() {
    if (sending) return;
    const toL2 = await parseList(to.value), ccL2 = await parseList(cc.value), bccL2 = await parseList(bcc.value);
    if (!toL2.length && !ccL2.length && !bccL2.length) { toast(t("mm.serve_destinatario"), true); return; }
    sending = true;
    toast(t("mm.invio_corso"), false, 60000);
    try {
      const { raw } = M.buildMime({ from: { name: a.mittente || "", address: a.email }, to: toL2, cc: ccL2, subject: subj.value, text: body.value, attachments: atts, inReplyTo: opts.inReplyTo, references: opts.references });
      await M.smtp(a, a.email, [...toL2, ...ccL2, ...bccL2].map(x => x.address), M.dotStuff(raw));
      sent = true;
      // copia nella posta inviata (Gmail la fa da se')
      const sentBox = roleFolder(a, "sent");
      if (a.salva_inviati !== false && sentBox) M.imap(a, [{ cmd: `APPEND ${M.q(sentBox)} (\\Seen) `, lit: raw }]).catch(() => {});
      const all = [...new Set([...toL2, ...ccL2, ...bccL2].map(x => x.name ? `${x.name} <${x.address}>` : x.address).concat(known))].slice(0, 300);
      M.kvSet("indirizzi", all);
      P.haptic(10);
      toast(t("mm.inviato"));
      v.close(true);
    } catch (e) { toast(e.message, true, 7000); }
    finally { sending = false; }
  }
}
