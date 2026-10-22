// MB Visual - Posta (stile Outlook): cartelle e preferiti a sinistra, elenco a conversazioni, lettura a destra o sotto,
// PEC con ricevute collegate, commesse, regole, categorie, promemoria, invio programmato, tasti di Outlook.
// Motore: mbvisual/mail (API /api/mail?op=...). Lettura: mailread.js, composizione: compose.js, impostazioni: mailsettings.js,
// calendario e contatti: mailcal.js / mailpeople.js.
import { api, confirmBox, el, loadCss, modal, pickFolder, toast } from "../core.js";
import { LOCALE, t as tr, tn } from "../i18n.js";
import { keymap } from "../shortcuts.js";
import { IC } from "./mailicons.js";

export const call = (op, body, q = {}) => api("mail", { op, ...q }, body !== undefined ? { json: body } : {});
const ROW_H = 74;
const PEC_RECEIPTS = new Set(["accettazione", "non-accettazione", "presa-in-carico", "avvenuta-consegna", "errore-consegna", "preavviso-errore-consegna", "rilevazione-virus"]);
const ROLE_ICON = { inbox: "inbox", sent: "inviata", drafts: "bozze", trash: "cestino", junk: "spam", archive: "archivio" };
const ROLE_ORDER = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5 };

let A = null; // stato della scheda Posta (una sola)
const CAL_READY = false;

// ------------------------------------------------------------------ utilita'
export function fmtWhen(ts, long = false) {
  if (!ts) return "";
  const d = new Date(ts * 1000), now = new Date();
  if (long) return d.toLocaleString(LOCALE, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  const days = (now - d) / 86400000;
  if (days < 6 && days > 0) return d.toLocaleDateString(LOCALE, { weekday: "short" }) + " " + d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
  return d.toLocaleDateString(LOCALE);
}
export const who = x => (x?.n || x?.a || "");
export function initials(name) {
  const p = (name || "?").replace(/[<>"@].*$/, "").trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] || "?") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
export function avatarColor(s) {
  let h = 0;
  for (const c of s || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 42% 46%)`;
}
// append senza i figli vuoti (null/false): DOM append li scriverebbe come testo
export const ap = (p, ...kids) => { p.append(...kids.flat().filter(k => k !== null && k !== undefined && k !== false)); return p; };
export function icon(name, cls = "") { return el("span", { class: "mi " + cls, html: IC[name] || "" }); }

// menu a comparsa (clic destro, menu dei pulsanti)
export function popMenu(x, y, items) {
  document.querySelectorAll(".ml-pop").forEach(m => m.remove());
  const m = el("div", { class: "menu ml-pop" });
  for (const it of items) {
    if (!it) continue;
    if (it === "-") { m.append(el("hr")); continue; }
    if (it.sec) { m.append(el("div", { class: "sec label" }, it.sec)); continue; }
    const b = el("button", { disabled: it.disabled || undefined, onclick: e => { e.stopPropagation(); m.remove(); it.run?.(); } });
    if (it.color) b.append(el("span", { class: "ml-catdot", style: { background: it.color } }));
    else if (it.icon) b.insertAdjacentHTML("beforeend", IC[it.icon] || it.icon);
    b.append(el("span", {}, it.label));
    if (it.check) b.append(el("span", { class: "hint", html: IC.ok }));
    else if (it.hint) b.append(el("span", { class: "hint" }, it.hint));
    m.append(b);
  }
  document.body.append(m);
  m.style.left = Math.max(6, Math.min(x, innerWidth - m.offsetWidth - 6)) + "px";
  m.style.top = Math.max(6, Math.min(y, innerHeight - m.offsetHeight - 6)) + "px";
  const off = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", off, true); } };
  setTimeout(() => document.addEventListener("mousedown", off, true));
  return m;
}
const menuAt = (btn, items) => { const r = btn.getBoundingClientRect(); popMenu(r.left, r.bottom + 4, items); };

function tbBtn(label, ic, run, opts = {}) {
  const b = el("button", { type: "button", title: opts.title || label, class: (opts.cls || "") + (opts.iconOnly ? " icon" : "") });
  b.insertAdjacentHTML("beforeend", IC[ic] || "");
  if (!opts.iconOnly) b.append(label);
  if (opts.caret) b.insertAdjacentHTML("beforeend", `<span class="ml-caret">${IC.giu}</span>`);
  b.addEventListener("click", e => run(e, b));
  return b;
}

// ------------------------------------------------------------------ montaggio della scheda
export async function mountMail(ctx) {
  loadCss("css/mail.css");
  ctx.fillBody(true);
  const st = (() => { try { return JSON.parse(localStorage.getItem("mbv-posta") || "{}"); } catch { return {}; } })();
  A = {
    ctx, view: "posta", folder: "unificata", q: "", qAll: false, filtro: "", conv: st.conv !== false, layout: st.layout || "destra",
    ordina: "data", items: [], rows: [], total: 0, sel: new Set(), cur: null, anchor: null, expanded: new Map(),
    F: null, S: { categorie: [] }, ver: -1, busy: false, readTimer: null, collapsed: new Set(st.collapsed || []), navW: st.navW || 250, listW: st.listW || 400,
  };
  const root = el("div", { class: "ml-root lay-" + A.layout });
  A.root = root;
  A.nav = el("aside", { class: "ml-nav" });
  A.listBox = el("section", { class: "ml-list" });
  A.read = el("section", { class: "ml-read" });
  A.other = el("section", { class: "ml-other", hidden: true });
  const g1 = el("div", { class: "ml-grip g1" }), g2 = el("div", { class: "ml-grip g2" });
  root.append(A.nav, g1, A.listBox, g2, A.read, A.other);
  ctx.el.append(root);
  grip(g1, "navW", 180, 420);
  grip(g2, "listW", 280, 900);
  applySizes();
  buildToolbar();
  buildList();
  setupKeys();
  ctx.tab.view.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); });
  try {
    A.S = (await call("settings")).s;
  } catch (e) { /* motore non pronto: si riprova al giro dopo */ }
  await refreshFolders();
  if (!A.F?.account?.length) {
    renderEmptyState();
  } else {
    await go(st.folder && (typeof st.folder === "number" ? A.F.account.some(a => a.cartelle.some(f => f.id === st.folder)) : true) ? st.folder : "unificata");
  }
  A.poll = setInterval(poll, 3000);
  const api_ = {
    dispose() { clearInterval(A.poll); A = null; },
    onShow() { refreshFolders(); },
    acceptDrop: paths => acceptDrop(paths),
    go: f => go(f),
    _ml: A,
  };
  return api_;
}

function persist() {
  try {
    localStorage.setItem("mbv-posta", JSON.stringify({ conv: A.conv, layout: A.layout, folder: A.folder, collapsed: [...A.collapsed], navW: A.navW, listW: A.listW }));
  } catch { /* */ }
}

function applySizes() {
  A.root.style.setProperty("--nav-w", A.navW + "px");
  A.root.style.setProperty("--list-w", A.listW + "px");
}

function grip(g, key, min, max) {
  g.addEventListener("pointerdown", e => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = A[key];
    const vertical = key === "listW" && A.layout === "sotto";
    const y0 = e.clientY;
    const mv = ev => {
      if (vertical) return;
      A[key] = Math.max(min, Math.min(max, w0 + ev.clientX - x0));
      applySizes();
    };
    const up = () => { g.removeEventListener("pointermove", mv); g.removeEventListener("pointerup", up); persist(); void y0; };
    g.addEventListener("pointermove", mv);
    g.addEventListener("pointerup", up);
  });
}

// ------------------------------------------------------------------ barra dei comandi
function buildToolbar() {
  const tb = A.ctx.tb;
  tb.classList.add("ml-tb");
  const seg = el("div", { class: "seg ml-views" },
    ...[["posta", "posta", "mail.posta"], ["calendario", "calendario", "mail.calendario"], ["contatti", "contatti", "mail.contatti"]].map(([v, ic, k], i) => {
      const b = tbBtn(tr(k), ic, () => setView(v), { title: `${tr(k)} (Ctrl+${i + 1})`, iconOnly: true });
      b.dataset.v = v;
      return b;
    }));
  A.seg = seg;
  seg.hidden = !CAL_READY; // calendario e contatti: tappa successiva
  A.search = el("input", { type: "search", class: "ml-search", placeholder: tr("mail.cerca_placeholder"), title: tr("mail.cerca_titolo") });
  A.search.addEventListener("input", () => { clearTimeout(A.searchT); A.searchT = setTimeout(() => { A.q = A.search.value.trim(); reload(); }, 280); });
  A.search.addEventListener("keydown", e => { if (e.key === "Escape") { A.search.value = ""; A.q = ""; reload(); A.listBox.focus(); } });
  A.mailTools = el("div", { class: "ml-tools" },
    tbBtn(tr("mail.nuovo_messaggio"), "nuovo", () => newMessage(), { cls: "primary", title: tr("mail.nuovo_messaggio") + " (Ctrl+N)" }),
    el("span", { class: "sep" }),
    tbBtn(tr("mail.rispondi"), "rispondi", () => replyTo("reply"), { title: tr("mail.rispondi") + " (Ctrl+R)" }),
    tbBtn(tr("mail.rispondi_tutti"), "tutti", () => replyTo("replyall"), { title: tr("mail.rispondi_tutti") + " (Ctrl+Shift+R)" }),
    tbBtn(tr("mail.inoltra"), "inoltra", () => replyTo("forward"), { title: tr("mail.inoltra") + " (Ctrl+F)" }),
    el("span", { class: "sep" }),
    tbBtn(tr("mail.elimina"), "elimina", () => del(false), { iconOnly: true, title: tr("mail.elimina") + " (Canc)" }),
    tbBtn(tr("mail.archivia"), "archivio", () => archive(), { iconOnly: true, title: tr("mail.archivia") + " (Backspace)" }),
    tbBtn(tr("mail.sposta"), "sposta", (e, b) => moveMenu(b), { iconOnly: true, caret: true, title: tr("mail.sposta") + " (Ctrl+Shift+V)" }),
    el("span", { class: "sep" }),
    tbBtn(tr("mail.letto_non_letto"), "letto", () => toggleRead(), { iconOnly: true, title: tr("mail.letto_non_letto") + " (Ctrl+Q / Ctrl+U)" }),
    tbBtn(tr("mail.contrassegna"), "bandiera", (e, b) => flagMenu(b), { iconOnly: true, caret: true, title: tr("mail.contrassegna") + " (Ins)" }),
    tbBtn(tr("mail.categorizza"), "categoria", (e, b) => catMenu(b), { iconOnly: true, caret: true, title: tr("mail.categorizza") }),
    tbBtn(tr("mail.ricordamelo"), "sveglia", (e, b) => remindMenu(b), { iconOnly: true, caret: true, title: tr("mail.ricordamelo") }),
    tbBtn(tr("mail.commessa"), "commessa", (e, b) => commessaMenu(b), { caret: true, title: tr("mail.commessa_titolo") }),
    el("span", { class: "sep" }),
    tbBtn(tr("mail.invia_ricevi"), "sync", () => syncAll(), { iconOnly: true, title: tr("mail.invia_ricevi") + " (F9)" }));
  tb.append(A.mailTools, el("span", { class: "grow" }), A.search,
    tbBtn(tr("mail.vista"), "vista", (e, b) => viewMenu(b), { iconOnly: true, caret: true, title: tr("mail.vista") }),
    tbBtn(tr("mail.impostazioni"), "impostazioni", () => import("./mailsettings.js").then(m => m.openSettings()), { iconOnly: true, title: tr("mail.impostazioni") }),
    el("span", { class: "sep" }), seg);
  updateSeg();
}

function updateSeg() {
  for (const b of A.seg.children) b.classList.toggle("on", b.dataset.v === A.view);
  A.mailTools.hidden = A.view !== "posta";
  A.search.placeholder = A.view === "posta" ? tr("mail.cerca_placeholder") : A.view === "calendario" ? tr("mail.cerca_eventi") : tr("mail.cerca_contatti");
}

async function setView(v) {
  A.view = v;
  updateSeg();
  const mail = v === "posta";
  for (const x of [A.nav, A.listBox, A.read, ...A.root.querySelectorAll(".ml-grip")]) x.hidden = !mail;
  A.other.hidden = mail;
  if (!mail) {
    const mod = await import(v === "calendario" ? "./mailcal.js" : "./mailpeople.js");
    A.otherApi?.dispose?.();
    A.other.innerHTML = "";
    A.otherApi = await mod.mount(A.other, { search: A.search, call, ctx: A.ctx });
  }
}

function viewMenu(b) {
  menuAt(b, [
    { sec: tr("mail.riquadro_lettura") },
    { label: tr("mail.lettura_destra"), icon: "vista", check: A.layout === "destra", run: () => setLayout("destra") },
    { label: tr("mail.lettura_sotto"), icon: "sotto", check: A.layout === "sotto", run: () => setLayout("sotto") },
    { label: tr("mail.lettura_nascosta"), icon: "nascosta", check: A.layout === "no", run: () => setLayout("no") },
    "-",
    { label: tr("mail.mostra_conversazioni"), icon: "persone", check: A.conv, run: () => { A.conv = !A.conv; persist(); reload(); } },
    { label: tr("mail.nascondi_ricevute"), icon: "ricevuta", check: A.S.nascondi_ricevute !== false,
      run: async () => { A.S.nascondi_ricevute = A.S.nascondi_ricevute === false; await call("settings_set", { s: { nascondi_ricevute: A.S.nascondi_ricevute } }); reload(); } },
    { sec: tr("mail.ordina_per") },
    ...[["data", "mail.ord_data"], ["data_asc", "mail.ord_data_asc"], ["mittente", "mail.ord_mittente"], ["oggetto", "mail.ord_oggetto"], ["dimensione", "mail.ord_dimensione"]]
      .map(([k, l]) => ({ label: tr(l), check: A.ordina === k, run: () => { A.ordina = k; reload(); } })),
  ]);
}

function setLayout(l) {
  A.layout = l;
  A.root.className = "ml-root lay-" + l;
  persist();
  renderRows();
}

// ------------------------------------------------------------------ riquadro cartelle
async function refreshFolders() {
  if (!A) return;
  try { A.F = await call("folders"); } catch (e) { A.nav.innerHTML = ""; A.nav.append(el("div", { class: "ml-empty bad" }, e.message)); return; }
  A.ver = A.F.ver;
  renderNav();
  updateStatus();
}

function navItem(id, label, ic, count, opts = {}) {
  const cur = String(A.folder) === String(id);
  const b = el("button", { class: "ml-fold" + (cur ? " sel" : "") + (opts.cls ? " " + opts.cls : ""), title: opts.title || label, style: opts.indent ? { paddingLeft: 10 + opts.indent * 14 + "px" } : null,
    onclick: () => go(id), "data-folder": id });
  if (opts.color) b.append(el("span", { class: "ml-catdot", style: { background: opts.color } }));
  else b.append(icon(ic));
  b.append(el("span", { class: "nm" }, label));
  if (count) b.append(el("span", { class: "cnt" + (opts.bad ? " bad" : "") }, String(count)));
  if (opts.menu) b.addEventListener("contextmenu", e => { e.preventDefault(); opts.menu(e); });
  if (opts.drop) {
    b.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("application/x-mbv-mail") || e.dataTransfer.types.includes("Files")) { e.preventDefault(); b.classList.add("drop"); } });
    b.addEventListener("dragleave", () => b.classList.remove("drop"));
    b.addEventListener("drop", e => { e.preventDefault(); b.classList.remove("drop"); opts.drop(e); });
  }
  return b;
}

function section(key, title, children, extra) {
  const closed = A.collapsed.has(key);
  const head = el("div", { class: "ml-sec" + (closed ? " closed" : ""), onclick: () => { closed ? A.collapsed.delete(key) : A.collapsed.add(key); persist(); renderNav(); } },
    el("span", { class: "tw", html: IC.giu }), el("span", { class: "label" }, title), extra || null);
  return closed ? [head] : [head, el("div", { class: "ml-secbody" }, ...children)];
}

const dropIds = e => { try { return JSON.parse(e.dataTransfer.getData("application/x-mbv-mail") || "[]"); } catch { return []; } };

function renderNav() {
  const F = A.F, nav = A.nav;
  const sc = nav.scrollTop;
  nav.innerHTML = "";
  const V = F.virtuali || {};
  const fav = [
    navItem("unificata", tr("mail.posta_arrivo_tutti"), "inbox", V.unificata),
    navItem("nonletti", tr("mail.non_letti"), "letto", 0),
    navItem("contrassegnati", tr("mail.contrassegnati"), "bandiera", V.contrassegnati),
    navItem("promemoria", tr("mail.promemoria"), "sveglia", V.promemoria, { bad: V.promemoria > 0 }),
    navItem("uscita", tr("mail.posta_uscita"), "uscita", V.uscita),
  ];
  const pec = [
    navItem("pec", tr("mail.registro_pec"), "pec", V.pec, { bad: V.pec > 0, title: tr("mail.registro_pec_titolo") }),
    navItem("pec_ricevute", tr("mail.pec_ricevute"), "pec", 0),
    navItem("ricevute", tr("mail.archivio_ricevute"), "ricevuta", 0, { title: tr("mail.archivio_ricevute_titolo") }),
  ];
  nav.append(...section("fav", tr("mail.preferiti"), fav));
  if (F.account.some(a => a.pec)) nav.append(...section("pec", "PEC", pec));
  const comm = F.commesse.filter(c => !c.chiusa).map(c => navItem("commessa:" + c.id, c.codice ? `${c.codice} · ${c.nome}` : c.nome, "commessa", c.messaggi ? 0 : 0, {
    color: c.colore || null, title: c.cartella || c.nome, menu: e => commessaNavMenu(e, c),
    drop: e => { const ids = dropIds(e); if (ids.length) linkCommessa(ids, c, true); },
  }));
  const addC = el("button", { class: "ml-secadd", title: tr("mail.nuova_commessa"), html: IC.piu, onclick: e => { e.stopPropagation(); import("./mailsettings.js").then(m => m.editCommessa(null, refreshFolders)); } });
  nav.append(...section("comm", tr("mail.commesse"), comm.length ? comm : [el("div", { class: "ml-hint" }, tr("mail.nessuna_commessa"))], addC));
  for (const a of F.account) {
    const st = A.status?.account?.[a.id] || {};
    const dot = el("span", { class: "ml-dot " + (st.stato || "pronto"), title: st.errore || st.avanzamento || "" });
    const folders = [...a.cartelle].filter(f => !f.noselect || a.cartelle.some(x => x.path.startsWith(f.path + f.delim)))
      .sort((x, y) => (ROLE_ORDER[x.role] ?? 9) - (ROLE_ORDER[y.role] ?? 9) || (x.role ? 0 : x.path.localeCompare(y.path, LOCALE)));
    const items = folders.filter(f => !["all", "flaggedall", "important"].includes(f.role)).map(f => {
      const depth = f.role ? 0 : Math.max(0, f.path.split(f.delim || "/").length - 1 - (f.path.toUpperCase().startsWith("INBOX" + (f.delim || "/")) ? 1 : 0));
      const name = f.role ? tr("mail.cart_" + f.role) : f.name;
      return navItem(f.id, name, ROLE_ICON[f.role] || "cartella", f.role === "sent" || f.role === "trash" ? 0 : f.unread, {
        indent: depth, cls: f.noselect ? "nosel" : "",
        menu: e => folderMenu(e, a, f),
        drop: e => { const ids = dropIds(e); if (ids.length) return moveTo(ids, f.id); importFiles(e, f); },
      });
    });
    if (a.uscita) items.splice(1, 0, navItem("uscita:" + a.id, tr("mail.posta_uscita"), "uscita", a.uscita));
    const head = el("span", { class: "ml-acc" }, dot, el("span", { class: "nm" }, a.nome || a.email), a.pec ? el("span", { class: "chip ml-pecchip" }, "PEC") : null);
    const sec = section("acc:" + a.id, "", items, head);
    sec[0].addEventListener("contextmenu", e => { e.preventDefault(); accountMenu(e, a); });
    if (st.stato === "errore" || st.stato === "offline") {
      sec.splice(1, 0, el("div", { class: "ml-accerr " + st.stato, title: st.errore, onclick: () => st.auth ? import("./mailsettings.js").then(m => m.editAccount(a)) : syncAll(a.id) },
        icon(st.stato === "offline" ? "nuvola" : "errore"), el("span", {}, st.stato === "offline" ? tr("mail.senza_rete") : st.errore)));
    }
    nav.append(...sec);
  }
  nav.append(el("div", { class: "ml-navfoot" },
    el("button", { class: "btn", onclick: () => import("./mailsettings.js").then(m => m.addAccount()) }, icon("piu"), tr("mail.aggiungi_account"))));
  nav.scrollTop = sc;
}

function renderEmptyState() {
  A.listBox.hidden = A.read.hidden = true;
  A.root.querySelectorAll(".ml-grip").forEach(g => (g.hidden = true));
  A.other.hidden = false;
  A.other.innerHTML = "";
  A.other.append(el("div", { class: "ml-welcome" },
    el("div", { class: "ml-wicon", html: IC.posta }),
    el("h2", {}, tr("mail.benvenuto_titolo")),
    el("p", {}, tr("mail.benvenuto_testo")),
    el("div", { class: "ml-wact" },
      el("button", { class: "btn primary", onclick: () => import("./mailsettings.js").then(m => m.addAccount()) }, icon("piu"), tr("mail.aggiungi_account")),
      el("button", { class: "btn", onclick: () => import("./mailsettings.js").then(m => m.addAccount({ pec: true })) }, icon("pec"), tr("mail.aggiungi_pec")),
      el("button", { class: "btn", onclick: () => import("./mailsettings.js").then(m => m.openGuide()) }, tr("mail.apri_guida")))));
}

export function afterAccountsChanged() {
  if (!A) return;
  A.listBox.hidden = A.read.hidden = false;
  A.root.querySelectorAll(".ml-grip").forEach(g => (g.hidden = false));
  A.other.hidden = A.view === "posta";
  refreshFolders().then(() => { if (A.F.account.length) go(A.folder || "unificata"); else renderEmptyState(); });
}

function folderMenu(e, a, f) {
  popMenu(e.clientX, e.clientY, [
    { label: tr("mail.nuova_cartella"), icon: "piu", run: async () => {
      const n = await askName(tr("mail.nuova_cartella"), "");
      if (n) { await call("folder_create", { account: a.id, parent: f.role === "inbox" || !f.role ? f.id : null, name: n }); refreshFolders(); }
    } },
    { label: tr("mail.rinomina"), icon: "bozze", disabled: !!f.role, run: async () => {
      const n = await askName(tr("mail.rinomina"), f.name);
      if (n && n !== f.name) { await call("folder_rename", { id: f.id, name: n }); refreshFolders(); }
    } },
    { label: tr("mail.segna_tutto_letto"), icon: "letto", run: async () => { await call("mark_folder_read", { folder: f.id }); reload(); refreshFolders(); } },
    { label: tr("mail.esegui_regole"), icon: "regole", run: () => import("./mailsettings.js").then(m => m.runRulesOn(f)) },
    "-",
    { label: tr("mail.elimina_cartella"), icon: "elimina", disabled: !!f.role, run: async () => {
      if (await confirmBox(tr("mail.elimina_cartella"), tr("mail.elimina_cartella_conferma", f.name), tr("mail.elimina"), true)) {
        await call("folder_delete", { id: f.id });
        if (A.folder === f.id) go("unificata"); else refreshFolders();
      }
    } },
  ]);
}

function accountMenu(e, a) {
  popMenu(e.clientX, e.clientY, [
    { label: tr("mail.sincronizza"), icon: "sync", run: () => syncAll(a.id) },
    { label: tr("mail.impostazioni_account"), icon: "impostazioni", run: () => import("./mailsettings.js").then(m => m.editAccount(a)) },
  ]);
}

function commessaNavMenu(e, c) {
  popMenu(e.clientX, e.clientY, [
    { label: tr("mail.modifica_commessa"), icon: "impostazioni", run: () => import("./mailsettings.js").then(m => m.editCommessa(c, refreshFolders)) },
    { label: tr("mail.apri_cartella"), icon: "cartella", disabled: !c.cartella, run: () => api("reveal", { path: c.cartella }) },
    { label: tr("mail.esplora_cartella"), icon: "apri", disabled: !c.cartella, run: () => window.MB.openPaths?.([c.cartella]) },
  ]);
}

async function askName(title, value) {
  const input = el("input", { type: "text", value });
  input.addEventListener("keydown", e => { if (e.key === "Enter") document.querySelector("#modal .btn.primary")?.click(); });
  const r = await modal(title, input, [{ label: tr("common.annulla"), value: null }, { label: "OK", primary: true, value: () => input.value.trim() }]);
  return r || null;
}

// ------------------------------------------------------------------ elenco messaggi
function buildList() {
  A.listHead = el("div", { class: "ml-lhead" });
  A.scroller = el("div", { class: "ml-scroll", tabindex: "0" });
  A.spacer = el("div", { class: "ml-spacer" });
  A.scroller.append(A.spacer);
  A.listBox.append(A.listHead, A.scroller);
  A.listBox.tabIndex = -1;
  A.scroller.addEventListener("scroll", () => { renderRows(); maybeMore(); });
  new ResizeObserver(() => renderRows()).observe(A.scroller);
  A.scroller.addEventListener("keydown", listKeys);
}

function folderTitle() {
  const f = A.folder;
  const names = { unificata: tr("mail.posta_arrivo_tutti"), nonletti: tr("mail.non_letti"), contrassegnati: tr("mail.contrassegnati"),
    promemoria: tr("mail.promemoria"), pec: tr("mail.registro_pec"), pec_ricevute: tr("mail.pec_ricevute"), ricevute: tr("mail.archivio_ricevute"),
    uscita: tr("mail.posta_uscita"), tutto: tr("mail.tutta_la_posta") };
  if (names[f]) return names[f];
  if (String(f).startsWith("uscita:")) return tr("mail.posta_uscita");
  if (String(f).startsWith("commessa:")) { const c = A.F?.commesse.find(x => "commessa:" + x.id === f); return c ? c.nome : tr("mail.commessa"); }
  for (const a of A.F?.account || []) {
    const x = a.cartelle.find(y => y.id === f);
    if (x) return `${x.role ? tr("mail.cart_" + x.role) : x.name} · ${a.nome || a.email}`;
  }
  return "";
}

function renderHead() {
  const h = A.listHead;
  h.innerHTML = "";
  const filters = [["", "mail.f_tutti"], ["nonletti", "mail.f_non_letti"], ["contrassegnati", "mail.f_contrassegnati"], ["allegati", "mail.f_allegati"], ["me", "mail.f_a_me"], ["pec", "PEC"]];
  h.append(el("div", { class: "ml-ltitle" }, el("b", {}, folderTitle()), el("span", { class: "mono ml-count" }, A.total ? String(A.total) : "")),
    el("div", { class: "ml-filters" }, ...filters.map(([k, l]) => el("button", { class: "ml-fchip" + (A.filtro === k ? " on" : ""), onclick: () => { A.filtro = k; reload(); } }, l.startsWith("mail.") ? tr(l) : l)),
      A.q ? el("button", { class: "ml-fchip" + (A.qAll ? " on" : ""), title: tr("mail.cerca_ovunque_titolo"), onclick: () => { A.qAll = !A.qAll; reload(); } }, icon("cerca"), tr("mail.cerca_ovunque")) : null));
}

export async function go(folder) {
  if (!A) return;
  A.folder = folder;
  A.sel.clear();
  A.cur = null;
  A.expanded.clear();
  persist();
  if (A.view !== "posta") setView("posta");
  renderNav();
  await reload();
  showReading();
}

async function reload(keep = false) {
  if (!A) return;
  const f = String(A.folder);
  if (f === "uscita" || f.startsWith("uscita:")) return loadOutbox(f.startsWith("uscita:") ? f.slice(7) : null);
  const body = { folder: A.q && A.qAll ? "tutto" : A.folder, q: A.q, filtro: A.filtro, conversazioni: A.conv && !A.q, ordina: A.ordina, limit: 300, offset: 0 };
  A.req = body;
  let r;
  try { r = await call("list", body); } catch (e) { toast(e.message, true); return; }
  if (A.req !== body) return;
  A.items = r.items;
  A.total = r.totale;
  A.outbox = null;
  if (!keep) A.scroller.scrollTop = 0;
  // conversazioni aperte restano aperte
  for (const [th] of A.expanded) if (!A.items.some(x => x.thread === th)) A.expanded.delete(th);
  await Promise.all([...A.expanded.keys()].map(th => loadThread(th, true)));
  flatten();
  renderHead();
  renderRows(true);
  if (keep && A.cur && !A.rows.some(x => x.id === A.cur)) { A.cur = null; showReading(); }
}

async function maybeMore() {
  if (A.loadingMore || A.outbox || A.items.length >= A.total) return;
  const s = A.scroller;
  if (s.scrollTop + s.clientHeight < s.scrollHeight - ROW_H * 10) return;
  A.loadingMore = true;
  try {
    const r = await call("list", { ...A.req, offset: A.items.length });
    A.items.push(...r.items);
    flatten();
    renderRows(true);
  } finally { A.loadingMore = false; }
}

async function loadThread(th, silent) {
  const head = A.items.find(x => x.thread === th);
  if (!head) return;
  const r = await call("thread", { thread: th, account: head.account });
  A.expanded.set(th, r.items.reverse());
  if (!silent) { flatten(); renderRows(true); }
}

function flatten() {
  const out = [];
  for (const it of A.items) {
    out.push(it);
    const kids = A.conv && A.expanded.get(it.thread);
    if (kids && kids.length > 1) for (const k of kids) out.push({ ...k, child: true, headId: it.id });
  }
  A.rows = out;
  A.spacer.style.height = out.length * ROW_H + "px";
}

function pecChip(m) {
  if (m.pec_state) {
    const cls = { consegnata: "ok", accettata: "warn", inviata: "mute", parziale: "warn", "parziale-errore": "bad", errore: "bad", "non-accettata": "bad" }[m.pec_state] || "mute";
    return el("span", { class: "chip ml-pecst " + cls, title: tr("mail.pec_stato_" + m.pec_state.replace("-", "_")) }, icon(cls === "ok" ? "ok" : cls === "bad" ? "errore" : "attesa"), tr("mail.pec_stato_" + m.pec_state.replace("-", "_")));
  }
  if (m.pec === "posta-certificata") return el("span", { class: "chip ml-pecst info" }, icon("pec"), "PEC");
  if (PEC_RECEIPTS.has(m.pec)) {
    const bad = /errore|non-acc|virus/.test(m.pec);
    return el("span", { class: "chip ml-pecst " + (bad ? "bad" : m.pec === "avvenuta-consegna" ? "ok" : "mute") }, tr("mail.ric_" + m.pec.replace(/-/g, "_")));
  }
  return null;
}

function catColor(name) { return (A.S.categorie || []).find(c => c.nome === name)?.colore || "var(--muted)"; }

function rowEl(m, idx) {
  const sent = m.folder_role === "sent" || isSentFolder(m.folder_id);
  const people = sent ? (m.to || []).map(who).join(", ") || tr("mail.senza_destinatari") : m.from_name || m.from_addr || "?";
  const unread = m.conv_unread !== undefined && !m.child ? m.conv_unread > 0 : !m.seen;
  const conv = A.conv && !m.child && m.conv_n > 1;
  const open = conv && A.expanded.has(m.thread);
  const r = el("div", {
    class: "ml-row" + (unread ? " unread" : "") + (A.sel.has(m.id) ? " sel" : "") + (A.cur === m.id ? " cur" : "") + (m.child ? " child" : "") + (m.flag_done ? " done" : ""),
    style: { top: idx * ROW_H + "px" }, draggable: "true", "data-id": m.id,
  });
  const av = sent && !m.child ? (m.to?.[0] || {}) : { n: m.from_name, a: m.from_addr };
  const left = el("div", { class: "ml-av", style: { background: avatarColor(av.a || "") } }, initials(who(av)));
  if (conv) {
    const tw = el("button", { class: "ml-tw" + (open ? " open" : ""), title: tr("mail.mostra_conversazione"), html: IC.destra,
      onclick: e => { e.stopPropagation(); if (open) { A.expanded.delete(m.thread); flatten(); renderRows(true); } else loadThread(m.thread); } });
    r.append(tw);
  }
  const l1 = el("div", { class: "l1" }, el("span", { class: "who" }, sent && !m.child ? tr("mail.a_breve") + " " + people : m.child && sent ? tr("mail.tu") : people),
    conv ? el("span", { class: "ml-cn mono" }, String(m.conv_n)) : null,
    el("span", { class: "when mono" }, fmtWhen(m.date)));
  const marks = el("span", { class: "marks" });
  if (m.priority === 1) marks.append(icon("importante", "imp"));
  if (m.has_att) marks.append(icon("allegato"));
  if (m.invite) marks.append(icon("calendario"));
  if (m.remind_at) marks.append(icon("sveglia", m.remind_at * 1000 <= Date.now() ? "due" : ""));
  if (m.commessa) {
    const c = A.F?.commesse.find(x => x.id === m.commessa);
    if (c) marks.append(el("span", { class: "ml-comtag", title: c.nome }, c.codice || c.nome));
  }
  const l2 = el("div", { class: "l2" }, el("span", { class: "subj" }, m.subject || tr("mail.senza_oggetto")), pecChip(m), marks);
  const l3 = el("div", { class: "l3" }, ...(m.categories || []).map(c => el("span", { class: "ml-cat", style: { "--c": catColor(c) } }, c)), el("span", { class: "pv" }, m.preview || ""));
  const flag = el("button", { class: "ml-flag" + (m.flagged ? " on" : "") + (m.flag_done ? " done" : ""), title: m.flag_done ? tr("mail.completato") : tr("mail.contrassegna"),
    html: m.flag_done ? IC.ok : IC.bandiera, onclick: e => { e.stopPropagation(); setFlags([m.id], m.flagged && !m.flag_done ? { flag_done: 1 } : m.flag_done ? { flagged: 0, flag_done: 0 } : { flagged: 1 }); } });
  const del_ = el("button", { class: "ml-rdel", title: tr("mail.elimina"), html: IC.elimina, onclick: e => { e.stopPropagation(); del(false, [m.id]); } });
  r.append(left, el("div", { class: "txt" }, l1, l2, l3), el("div", { class: "acts" }, flag, del_));
  r.addEventListener("click", e => clickRow(e, m));
  r.addEventListener("dblclick", () => openInTab(m));
  r.addEventListener("contextmenu", e => { e.preventDefault(); if (!A.sel.has(m.id)) { A.sel = new Set([m.id]); A.cur = m.id; renderRows(true); showReading(); } rowMenu(e); });
  r.addEventListener("dragstart", e => {
    const ids = A.sel.has(m.id) ? [...A.sel] : [m.id];
    e.dataTransfer.setData("application/x-mbv-mail", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
  });
  return r;
}

function isSentFolder(fid) {
  for (const a of A.F?.account || []) { const f = a.cartelle.find(x => x.id === fid); if (f) return f.role === "sent" || f.role === "drafts"; }
  return false;
}

function renderRows(force) {
  if (!A || A.outbox) return;
  const s = A.scroller;
  const first = Math.max(0, Math.floor(s.scrollTop / ROW_H) - 5);
  const last = Math.min(A.rows.length, Math.ceil((s.scrollTop + s.clientHeight) / ROW_H) + 5);
  if (!force && A._rng && A._rng[0] === first && A._rng[1] === last) return;
  A._rng = [first, last];
  for (const r of [...s.querySelectorAll(".ml-row, .ml-empty")]) r.remove();
  if (!A.rows.length) {
    s.append(el("div", { class: "ml-empty" }, A.q ? tr("mail.nessun_risultato") : tr("mail.cartella_vuota")));
    return;
  }
  for (let i = first; i < last; i++) s.append(rowEl(A.rows[i], i));
}

function clickRow(e, m) {
  if (e.ctrlKey || e.metaKey) {
    A.sel.has(m.id) ? A.sel.delete(m.id) : A.sel.add(m.id);
    A.cur = m.id;
    A.anchor = m.id;
  } else if (e.shiftKey && A.anchor) {
    const i = A.rows.findIndex(x => x.id === A.anchor), j = A.rows.findIndex(x => x.id === m.id);
    A.sel = new Set(A.rows.slice(Math.min(i, j), Math.max(i, j) + 1).map(x => x.id));
    A.cur = m.id;
  } else {
    A.sel = new Set([m.id]);
    A.cur = m.id;
    A.anchor = m.id;
  }
  renderRows(true);
  showReading();
  A.scroller.focus({ preventScroll: true });
}

function moveCursor(d, extend) {
  if (!A.rows.length) return;
  let i = A.rows.findIndex(x => x.id === A.cur);
  i = Math.max(0, Math.min(A.rows.length - 1, (i < 0 ? -1 : i) + d));
  const m = A.rows[i];
  if (extend && A.anchor) {
    const a = A.rows.findIndex(x => x.id === A.anchor);
    A.sel = new Set(A.rows.slice(Math.min(a, i), Math.max(a, i) + 1).map(x => x.id));
  } else { A.sel = new Set([m.id]); A.anchor = m.id; }
  A.cur = m.id;
  const s = A.scroller;
  if (i * ROW_H < s.scrollTop) s.scrollTop = i * ROW_H;
  else if ((i + 1) * ROW_H > s.scrollTop + s.clientHeight) s.scrollTop = (i + 1) * ROW_H - s.clientHeight;
  renderRows(true);
  showReading();
}

function listKeys(e) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveCursor(e.key === "ArrowDown" ? 1 : -1, e.shiftKey); }
  else if (e.key === "Home") { e.preventDefault(); A.cur = null; moveCursor(-1e9 + 1); }
  else if (e.key === "End") { e.preventDefault(); A.cur = A.rows.at(-1)?.id; moveCursor(0); }
  else if (e.key === "PageDown" || e.key === "PageUp") { e.preventDefault(); moveCursor((e.key === "PageDown" ? 1 : -1) * Math.floor(A.scroller.clientHeight / ROW_H)); }
  else if (e.key === "ArrowRight") { const m = A.rows.find(x => x.id === A.cur); if (m && A.conv && m.conv_n > 1 && !A.expanded.has(m.thread)) loadThread(m.thread); }
  else if (e.key === "ArrowLeft") { const m = A.rows.find(x => x.id === A.cur); const th = m?.thread; if (th && A.expanded.has(th)) { A.expanded.delete(th); A.cur = A.items.find(x => x.thread === th)?.id; flatten(); renderRows(true); } }
  else if (e.key === "Enter") { const m = A.rows.find(x => x.id === A.cur); if (m) openInTab(m); }
}

const selIds = () => (A.sel.size ? [...A.sel] : A.cur ? [A.cur] : []);
const curMsg = () => A.rows.find(x => x.id === A.cur) || A.items.find(x => x.id === A.cur);

// ------------------------------------------------------------------ lettura
async function showReading() {
  clearTimeout(A.readTimer);
  const box = A.read;
  if (A.layout === "no") return;
  const id = A.cur;
  if (!id || A.sel.size > 1) {
    A.readApi?.dispose?.();
    A.readApi = null;
    box.innerHTML = "";
    box.append(el("div", { class: "ml-noread" }, el("div", { html: IC.posta }),
      A.sel.size > 1 ? el("p", {}, tn("mail.n_selezionati", A.sel.size)) : el("p", {}, tr("mail.seleziona_messaggio"))));
    return;
  }
  if (A.readApi?.id === id) return;
  const { showMessage } = await import("./mailread.js");
  if (A.cur !== id) return;
  A.readApi?.dispose?.();
  A.readApi = await showMessage(box, id, { app: appApi() });
  const m = curMsg();
  if (m && !m.seen) {
    const delay = (A.S.segna_letto_dopo ?? 2) * 1000;
    if (delay >= 0) A.readTimer = setTimeout(() => { if (A?.cur === id) setFlags([id], { seen: 1 }, true); }, delay);
  }
}

function appApi() {
  return {
    reply: (mode, id) => replyTo(mode, id), setFlags, refresh: () => reload(true), refreshFolders, go, del, moveTo, linkCommessa,
    openInTab, categories: () => A.S.categorie || [], commesse: () => A.F?.commesse || [], ownerView: A.ctx.tab.view, openFile: A.ctx.openFile,
    accounts: () => A.F?.account || [], catColor, settings: () => A.S,
  };
}

async function openInTab(m) {
  try {
    const f = await call("eml_file", { id: m.id });
    A.ctx.openFile(f.path);
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ azioni
export async function setFlags(ids, vals, quiet) {
  if (!ids.length) return;
  await call("set", { ids, ...vals });
  for (const r of [...(A?.items || []), ...[...(A?.expanded.values() || [])].flat()]) {
    if (ids.includes(r.id)) {
      Object.assign(r, vals);
      if ("seen" in vals && r.conv_unread !== undefined) r.conv_unread = Math.max(0, r.conv_unread + (vals.seen ? -1 : 1));
    }
  }
  if (A) { flatten(); renderRows(true); if (!quiet) refreshFolders(); else setTimeout(refreshFolders, 300); }
}

function toggleRead(force) {
  const ids = selIds();
  if (!ids.length) return;
  const m = A.rows.find(x => x.id === ids[0]);
  setFlags(ids, { seen: force !== undefined ? force : m && !m.seen ? 1 : 0 });
}

async function del(permanent, ids = selIds()) {
  if (!ids.length) return;
  if (permanent && !(await confirmBox(tr("mail.elimina_definitivo"), tn("mail.elimina_definitivo_conferma", ids.length), tr("mail.elimina"), true))) return;
  const idx = A.rows.findIndex(x => x.id === ids[0]);
  await call("delete", { ids, permanent });
  afterRemove(ids, idx);
}

function afterRemove(ids, idx) {
  A.items = A.items.filter(x => !ids.includes(x.id));
  for (const [k, v] of A.expanded) A.expanded.set(k, v.filter(x => !ids.includes(x.id)));
  A.total = Math.max(0, A.total - ids.length);
  flatten();
  const next = A.rows[Math.min(idx, A.rows.length - 1)];
  A.sel = new Set(next ? [next.id] : []);
  A.cur = next?.id || null;
  renderRows(true);
  showReading();
  refreshFolders();
}

async function archive(ids = selIds()) {
  if (!ids.length) return;
  const idx = A.rows.findIndex(x => x.id === ids[0]);
  await call("archive", { ids });
  afterRemove(ids, idx);
}

async function moveTo(ids, folder) {
  const idx = A.rows.findIndex(x => x.id === ids[0]);
  await call("move", { ids, folder });
  afterRemove(ids, idx);
  toast(tn("mail.spostati_n", ids.length));
}

function folderChoices(accountId) {
  const out = [];
  for (const a of A.F.account) {
    if (accountId && a.id !== accountId && A.F.account.length > 1) continue;
    out.push({ sec: a.nome || a.email });
    for (const f of a.cartelle.filter(x => !x.noselect && !["all", "flaggedall", "important"].includes(x.role)))
      out.push({ label: f.role ? tr("mail.cart_" + f.role) : f.path, icon: ROLE_ICON[f.role] || "cartella", run: () => moveTo(selIds(), f.id) });
  }
  return out;
}

function moveMenu(b) {
  const ids = selIds();
  if (!ids.length) return;
  const m = A.rows.find(x => x.id === ids[0]);
  const items = folderChoices(m?.account);
  b ? menuAt(b, items) : popMenu(innerWidth / 2 - 140, 120, items);
}

const FLAG_DUE = () => {
  const d = new Date(); const day = h => { const x = new Date(); x.setHours(17, 0, 0, 0); x.setDate(x.getDate() + h); return x.getTime() / 1000; };
  const monday = () => { const x = new Date(d); x.setDate(x.getDate() + ((8 - x.getDay()) % 7 || 7)); x.setHours(9, 0, 0, 0); return x.getTime() / 1000; };
  return [["mail.oggi", day(0)], ["mail.domani", day(1)], ["mail.settimana_prossima", monday()], ["mail.senza_data", 0]];
};

function flagMenu(b) {
  const ids = selIds();
  if (!ids.length) return;
  menuAt(b, [
    ...FLAG_DUE().map(([k, ts]) => ({ label: tr(k), icon: "bandiera", run: () => setFlags(ids, { flagged: 1, flag_done: 0, flag_due: ts }) })),
    { label: tr("mail.data_personalizzata"), icon: "calendario", run: async () => { const ts = await askDate(tr("mail.scadenza")); if (ts) setFlags(ids, { flagged: 1, flag_due: ts }); } },
    "-",
    { label: tr("mail.segna_completato"), icon: "ok", run: () => setFlags(ids, { flag_done: 1 }) },
    { label: tr("mail.togli_contrassegno"), icon: "chiudi", run: () => setFlags(ids, { flagged: 0, flag_done: 0 }) },
  ]);
}

function catMenu(b, at) {
  const ids = selIds();
  if (!ids.length) return;
  const m = A.rows.find(x => x.id === ids[0]);
  const has = new Set(m?.categories || []);
  const items = [...(A.S.categorie || []).map(c => ({
    label: c.nome, color: c.colore, check: has.has(c.nome),
    run: () => {
      for (const id of ids) {
        const r = A.rows.find(x => x.id === id);
        const cur = new Set(r?.categories || []);
        has.has(c.nome) ? cur.delete(c.nome) : cur.add(c.nome);
        setFlags([id], { categories: [...cur] }, true);
      }
    },
  })), "-", { label: tr("mail.togli_categorie"), icon: "chiudi", run: () => setFlags(ids, { categories: [] }) },
  { label: tr("mail.gestisci_categorie"), icon: "impostazioni", run: () => import("./mailsettings.js").then(x => x.openSettings("categorie")) }];
  at ? popMenu(at.x, at.y, items) : menuAt(b, items);
}

async function askDate(title, withTime = true) {
  const now = new Date(Date.now() + 3600000);
  const pad = n => String(n).padStart(2, "0");
  const v = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
  const input = el("input", { type: withTime ? "datetime-local" : "date", value: withTime ? v : v.slice(0, 10), class: "field", style: { width: "100%" } });
  const r = await modal(title, input, [{ label: tr("common.annulla"), value: null }, { label: "OK", primary: true, value: () => input.value }]);
  return r ? new Date(r).getTime() / 1000 : null;
}
export { askDate };

function remindMenu(b) {
  const ids = selIds();
  if (!ids.length) return;
  const at = (h, m = 0, addDays = 0) => { const x = new Date(); x.setDate(x.getDate() + addDays); x.setHours(h, m, 0, 0); return x.getTime() / 1000; };
  menuAt(b, [
    { label: tr("mail.tra_un_ora"), icon: "sveglia", run: () => setFlags(ids, { remind_at: Date.now() / 1000 + 3600 }) },
    { label: tr("mail.stasera"), icon: "sveglia", run: () => setFlags(ids, { remind_at: at(18) }) },
    { label: tr("mail.domani_mattina"), icon: "sveglia", run: () => setFlags(ids, { remind_at: at(9, 0, 1) }) },
    { label: tr("mail.lunedi"), icon: "sveglia", run: () => { const x = new Date(); x.setDate(x.getDate() + ((8 - x.getDay()) % 7 || 7)); x.setHours(9, 0, 0, 0); setFlags(ids, { remind_at: x.getTime() / 1000 }); } },
    { label: tr("mail.data_personalizzata"), icon: "calendario", run: async () => { const ts = await askDate(tr("mail.ricordamelo")); if (ts) setFlags(ids, { remind_at: ts }); } },
    "-",
    { label: tr("mail.togli_promemoria"), icon: "chiudi", run: () => setFlags(ids, { remind_at: 0 }) },
  ]);
}

function commessaMenu(b, at) {
  const ids = selIds();
  if (!ids.length) return;
  const items = [{ sec: tr("mail.collega_archivia") },
    ...(A.F?.commesse || []).filter(c => !c.chiusa).map(c => ({ label: (c.codice ? c.codice + " · " : "") + c.nome, icon: "commessa", run: () => linkCommessa(ids, c, true) })),
    "-",
    { label: tr("mail.solo_collega"), icon: "link", disabled: !(A.F?.commesse || []).length, run: () => chooseCommessa(c => linkCommessa(ids, c, false)) },
    { label: tr("mail.scollega"), icon: "chiudi", run: () => setFlags(ids, { commessa: "" }) },
    { label: tr("mail.nuova_commessa"), icon: "piu", run: () => import("./mailsettings.js").then(x => x.editCommessa(null, async c => { await refreshFolders(); if (c) linkCommessa(ids, c, true); })) },
    { label: tr("mail.salva_allegati_cartella"), icon: "salva", run: () => saveAttachmentsTo(ids) }];
  at ? popMenu(at.x, at.y, items) : menuAt(b, items);
}

function chooseCommessa(fn) {
  popMenu(innerWidth / 2 - 150, 140, (A.F?.commesse || []).map(c => ({ label: (c.codice ? c.codice + " · " : "") + c.nome, icon: "commessa", run: () => fn(c) })));
}

export async function linkCommessa(ids, c, archiveToo) {
  try {
    if (archiveToo && c.cartella) {
      const r = await call("commessa_archivia", { ids, commessa: c.id });
      const n = r.archiviati.reduce((s, x) => s + x.file.length, 0);
      toast(tr("mail.archiviato_in", c.nome, n), false, 4500);
    } else {
      await setFlags(ids, { commessa: c.id });
      if (archiveToo && !c.cartella) toast(tr("mail.commessa_senza_cartella"), true, 5000);
      else toast(tr("mail.collegato_a", c.nome));
    }
    for (const r of A?.items || []) if (ids.includes(r.id)) r.commessa = c.id;
    if (A) { flatten(); renderRows(true); refreshFolders(); }
  } catch (e) { toast(e.message, true, 6000); }
}

async function saveAttachmentsTo(ids, parti) {
  const dest = await pickFolder();
  if (!dest) return;
  try {
    const r = await call("save_atts", { ids, dest, parti });
    toast(tn("mail.allegati_salvati", r.file.length, { cartella: r.cartella }), false, 4500);
  } catch (e) { toast(e.message, true); }
}
export { saveAttachmentsTo };

function rowMenu(e) {
  const ids = selIds();
  const m = A.rows.find(x => x.id === ids[0]);
  if (!m) return;
  popMenu(e.clientX, e.clientY, [
    { label: tr("mail.rispondi"), icon: "rispondi", hint: "Ctrl+R", run: () => replyTo("reply") },
    { label: tr("mail.rispondi_tutti"), icon: "tutti", hint: "Ctrl+Shift+R", run: () => replyTo("replyall") },
    { label: tr("mail.inoltra"), icon: "inoltra", hint: "Ctrl+F", run: () => replyTo("forward") },
    { label: tr("mail.inoltra_allegato"), icon: "allegato", run: () => replyTo("forward", m.id, { as_eml: true }) },
    "-",
    { label: m.seen ? tr("mail.segna_non_letto") : tr("mail.segna_letto"), icon: "letto", hint: m.seen ? "Ctrl+U" : "Ctrl+Q", run: () => toggleRead() },
    { label: tr("mail.categorizza"), icon: "categoria", run: () => catMenu(null, { x: e.clientX, y: e.clientY }) },
    { label: tr("mail.commessa"), icon: "commessa", run: () => commessaMenu(null, { x: e.clientX, y: e.clientY }) },
    { label: tr("mail.sposta"), icon: "sposta", hint: "Ctrl+Shift+V", run: () => popMenu(e.clientX, e.clientY, folderChoices(m.account)) },
    { label: tr("mail.archivia"), icon: "archivio", hint: "Backspace", run: () => archive() },
    "-",
    { label: tr("mail.apri_scheda"), icon: "apri", hint: tr("keys.Enter"), run: () => openInTab(m) },
    { label: tr("mail.salva_eml"), icon: "salva", run: () => saveEml(m) },
    { label: tr("mail.crea_regola"), icon: "regole", run: () => import("./mailsettings.js").then(x => x.editRule({ cond: { da: m.from_addr } })) },
    "-",
    { label: tr("mail.elimina"), icon: "elimina", hint: tr("keys.Delete"), run: () => del(false) },
  ]);
}

async function saveEml(m) {
  const { pickSavePath, readBytes, saveBytes } = await import("../core.js");
  const f = await call("eml_file", { id: m.id });
  const dest = await pickSavePath(f.nome, "");
  if (!dest) return;
  await saveBytes(dest, await readBytes(f.path));
  toast(tr("mail.salvato"));
}

async function syncAll(account) {
  await call("sync", { account: account || "" });
  toast(tr("mail.sincronizzazione_avviata"), false, 1600);
}

// ------------------------------------------------------------------ posta in uscita
async function loadOutbox(account) {
  const r = await call("outbox", {});
  A.outbox = r.items.filter(x => !account || x.account === account);
  A.total = A.outbox.length;
  renderHead();
  for (const x of [...A.scroller.querySelectorAll(".ml-row, .ml-empty")]) x.remove();
  A.spacer.style.height = "0px";
  if (!A.outbox.length) { A.scroller.append(el("div", { class: "ml-empty" }, tr("mail.uscita_vuota"))); return; }
  A.outbox.forEach((o, i) => {
    const when = o.send_at ? tr("mail.invio_programmato_il", fmtWhen(o.send_at, true)) : o.status === "invio" ? tr("mail.in_invio") : o.status === "errore" ? o.error : tr("mail.in_attesa_rete");
    const r = el("div", { class: "ml-row ml-out" + (o.status === "errore" ? " err" : ""), style: { top: i * ROW_H + "px" } },
      el("div", { class: "ml-av", html: IC[o.send_at ? "orologio" : "uscita"] }),
      el("div", { class: "txt" }, el("div", { class: "l1" }, el("span", { class: "who" }, tr("mail.a_breve") + " " + o.rcpt.join(", ")), el("span", { class: "when mono" }, fmtWhen(o.created))),
        el("div", { class: "l2" }, el("span", { class: "subj" }, o.subject || tr("mail.senza_oggetto"))), el("div", { class: "l3" }, el("span", { class: "pv" + (o.status === "errore" ? " bad" : "") }, when))));
    r.addEventListener("contextmenu", e => { e.preventDefault(); outboxMenu(e, o); });
    r.addEventListener("click", e => outboxMenu(e, o));
    A.scroller.append(r);
  });
  A.spacer.style.height = A.outbox.length * ROW_H + "px";
  A.read.innerHTML = "";
  A.read.append(el("div", { class: "ml-noread" }, el("div", { html: IC.uscita }), el("p", {}, tr("mail.uscita_spiegazione"))));
}

function outboxMenu(e, o) {
  const act = async (azione, extra = {}) => { const r = await call("outbox_op", { id: o.id, azione, ...extra }); refreshFolders(); reload(); return r; };
  popMenu(e.clientX, e.clientY, [
    { label: tr("mail.invia_ora"), icon: "invia", run: () => act("invia_ora") },
    { label: tr("mail.cambia_data_invio"), icon: "orologio", run: async () => { const ts = await askDate(tr("mail.invio_posticipato")); if (ts) act("data", { send_at: ts }); } },
    o.status === "errore" ? { label: tr("mail.riprova"), icon: "sync", run: () => act("riprova") } : null,
    { label: tr("mail.annulla_e_modifica"), icon: "bozze", run: async () => { const r = await act("annulla"); if (r.draft_id) openCompose({ mode: "edit", id: r.draft_id, is_draft: true }); } },
    "-",
    { label: tr("mail.elimina"), icon: "elimina", run: async () => { if (await confirmBox(tr("mail.elimina"), tr("mail.elimina_uscita_conferma"), tr("mail.elimina"), true)) act("elimina"); } },
  ]);
}

// ------------------------------------------------------------------ composizione (scheda a parte, come la finestra di Outlook)
let composeN = 0;
export async function openCompose(opts = {}) {
  let c;
  try { c = (await call("compose", opts)).c; } catch (e) { toast(e.message, true); return; }
  c.mode = opts.mode || "new";
  if (!c.account) c.account = defaultAccount();
  if (typeof opts.to === "string") c.to = [{ n: "", a: opts.to }];
  if (opts.atts) c.atts = opts.atts;
  if (opts.sign_first) c.sign_first = opts.sign_first;
  const name = c.subject || tr("mail.nuovo_messaggio");
  return window.MB.openFile("mail://scrivi/" + ++composeN, "mailcompose", { displayName: name, compose: c, fresh: true });
}

function defaultAccount() {
  const accs = A?.F?.account || [];
  const f = A && typeof A.folder === "number" ? accs.find(a => a.cartelle.some(x => x.id === A.folder)) : null;
  return (f || accs[0])?.id;
}

export function newMessage(extra = {}) {
  return openCompose({ mode: "new", ...extra });
}

function replyTo(mode, id, extra = {}) {
  const mid = id || A?.cur;
  if (!mid) return;
  return openCompose({ mode, id: mid, ...extra });
}

async function acceptDrop(paths) {
  if (A.view !== "posta") return false;
  const eml = paths.filter(p => /\.eml$/i.test(p));
  const f = typeof A.folder === "number" ? A.folder : null;
  if (eml.length === paths.length && f) {
    const r = await call("import_eml", { folder: f, paths: eml });
    toast(tn("mail.importati_n", r.n));
    reload(true);
    return true;
  }
  // altri file trascinati sulla posta: nuovo messaggio con gli allegati
  const c = (await call("compose", { mode: "new" })).c;
  c.account = defaultAccount();
  c.atts = paths.map(p => ({ path: p, nome: p.split(/[\\/]/).pop() }));
  window.MB.openFile("mail://scrivi/" + ++composeN, "mailcompose", { displayName: tr("mail.nuovo_messaggio"), compose: { ...c, mode: "new" }, fresh: true });
  return true;
}

async function importFiles(e, f) {
  const files = [...(e.dataTransfer?.files || [])];
  void files; void f; // i percorsi veri dei file trascinati arrivano da app.py (acceptDrop)
}

// ------------------------------------------------------------------ aggiornamento periodico e notifiche
async function poll() {
  if (!A || A.polling) return;
  A.polling = true;
  try {
    const st = await call("status", undefined, { nuovi: 1 });
    const stKey = JSON.stringify(Object.entries(st.account || {}).map(([k, v]) => [k, v.stato, v.errore]));
    const stChanged = stKey !== A.stKey;
    A.stKey = stKey;
    A.status = st;
    if (st.ver !== A.ver) {
      A.ver = st.ver;
      await refreshFolders();
      if (A.view === "posta" && !A.q) await reload(true);
    } else if (A.F && stChanged) {
      renderNav(); // stato degli account (punto colorato, errori)
    }
    for (const n of st.nuovi || []) {
      if (A.S.notifiche === false) break;
      notify(n);
    }
    for (const r of st.promemoria || []) remindPopup(r);
    updateStatus();
  } catch { /* motore non raggiungibile: si riprova */ } finally { if (A) A.polling = false; }
}

function notify(n) {
  const box = document.querySelector(".ml-notes") || document.body.appendChild(el("div", { class: "ml-notes" }));
  const card = el("div", { class: "ml-note", onclick: () => { window.MB.openMail(); card.remove(); setTimeout(() => { if (A) { A.cur = n.id; A.sel = new Set([n.id]); showReading(); } }, 300); } },
    icon("posta"), el("div", {}, el("b", {}, n.from_name || n.from_addr), el("div", {}, n.subject || tr("mail.senza_oggetto"))));
  box.append(card);
  setTimeout(() => card.remove(), 7000);
}

const reminded = new Set();
function remindPopup(r) {
  if (reminded.has(r.id + ":" + r.remind_at)) return;
  reminded.add(r.id + ":" + r.remind_at);
  const box = document.querySelector(".ml-notes") || document.body.appendChild(el("div", { class: "ml-notes" }));
  const card = el("div", { class: "ml-note remind" }, icon("sveglia"),
    el("div", {}, el("b", {}, tr("mail.promemoria")), el("div", {}, r.subject || tr("mail.senza_oggetto")),
      el("div", { class: "ml-noteact" },
        el("button", { class: "btn", onclick: e => { e.stopPropagation(); card.remove(); window.MB.openMail(); setTimeout(() => { if (A) { A.cur = r.id; A.sel = new Set([r.id]); showReading(); } }, 300); } }, tr("mail.apri")),
        el("button", { class: "btn", onclick: e => { e.stopPropagation(); card.remove(); call("set", { ids: [r.id], remind_at: Date.now() / 1000 + 3600 }); } }, tr("mail.rimanda_ora")),
        el("button", { class: "btn", onclick: e => { e.stopPropagation(); card.remove(); call("set", { ids: [r.id], remind_at: 0 }); } }, tr("mail.chiudi_promemoria")))));
  box.append(card);
}

function updateStatus() {
  if (!A?.status) return;
  const accs = Object.values(A.status.account || {});
  const syncing = accs.find(s => s.stato === "sync");
  const off = accs.some(s => s.stato === "offline");
  const last = Math.max(0, ...accs.map(s => s.ultimo || 0));
  A.ctx.status(syncing ? (syncing.avanzamento || tr("mail.sincronizzazione")) : off ? tr("mail.senza_rete_lettura") : last ? tr("mail.aggiornato_alle", new Date(last * 1000).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })) : "");
}

// ------------------------------------------------------------------ tasti di Outlook
function setupKeys() {
  const ctx = A.ctx;
  const inMail = () => A && A.view === "posta";
  keymap(ctx, "Outlook", [
    { keys: "Ctrl+N|Ctrl+Shift+M", desc: tr("mail.nuovo_messaggio"), run: () => (A.view === "calendario" ? A.otherApi?.newEvent?.() : A.view === "contatti" ? A.otherApi?.newContact?.() : newMessage()) },
    { keys: "Ctrl+R", desc: tr("mail.rispondi"), when: inMail, run: () => replyTo("reply") },
    { keys: "Ctrl+Shift+R", desc: tr("mail.rispondi_tutti"), when: inMail, run: () => replyTo("replyall") },
    { keys: "Ctrl+F", desc: tr("mail.inoltra"), when: inMail, run: () => replyTo("forward") },
    { keys: "Ctrl+Alt+F", desc: tr("mail.inoltra_allegato"), when: inMail, run: () => replyTo("forward", null, { as_eml: true }) },
    { keys: "Ctrl+E|F3", desc: tr("mail.cerca_titolo"), inFields: true, run: () => { A.search.focus(); A.search.select(); } },
    { keys: "Ctrl+Q", desc: tr("mail.segna_letto"), when: inMail, run: () => toggleRead(1) },
    { keys: "Ctrl+U", desc: tr("mail.segna_non_letto"), when: inMail, run: () => toggleRead(0) },
    { keys: "Delete", desc: tr("mail.elimina"), when: inMail, run: () => del(false) },
    { keys: "Shift+Delete", desc: tr("mail.elimina_definitivo"), when: inMail, run: () => del(true) },
    { keys: "Backspace", desc: tr("mail.archivia"), when: inMail, run: () => archive() },
    { keys: "Insert", desc: tr("mail.contrassegna"), when: inMail, run: () => { const m = curMsg(); if (m) setFlags(selIds(), m.flagged ? { flagged: 0, flag_done: 0 } : { flagged: 1 }); } },
    { keys: "Ctrl+Shift+V", desc: tr("mail.sposta"), when: inMail, run: () => moveMenu(null) },
    { keys: "Ctrl+Shift+I", desc: tr("mail.posta_arrivo_tutti"), run: () => go("unificata") },
    { keys: "Ctrl+Shift+O", desc: tr("mail.posta_uscita"), run: () => go("uscita") },
    { keys: "F9", desc: tr("mail.invia_ricevi"), run: () => syncAll() },
    { keys: "Ctrl+1", desc: tr("mail.posta"), run: () => setView("posta") },
    { keys: "Ctrl+2", desc: tr("mail.calendario"), run: () => setView("calendario") },
    { keys: "Ctrl+3", desc: tr("mail.contatti"), run: () => setView("contatti") },
    { keys: "Ctrl+A", desc: tr("mail.seleziona_tutto"), when: inMail, run: () => { A.sel = new Set(A.rows.map(x => x.id)); renderRows(true); showReading(); } },
    { keys: "Ctrl+.|Ctrl+Shift+.", desc: tr("mail.messaggio_successivo"), when: inMail, run: () => moveCursor(1) },
    { keys: "Ctrl+,|Ctrl+Shift+,", desc: tr("mail.messaggio_precedente"), when: inMail, run: () => moveCursor(-1) },
    { keys: "Escape", desc: tr("mail.deseleziona"), when: inMail, run: () => { A.sel.clear(); A.cur = null; renderRows(true); showReading(); } },
  ]);
}
