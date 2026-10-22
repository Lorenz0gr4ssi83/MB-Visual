// MB Visual - Archivi cloud (solo app per PC): pannello accanto a Esplora con SharePoint/OneDrive, Google Drive, Dropbox,
// Autodesk Construction Cloud / BIM 360. I file si aprono senza sincronizzare le cartelle (download temporaneo) e ogni
// salvataggio torna sul cloud con il controllo della versione. Motore: mbvisual/cloud.py (API /api/cloud?op=...).
import { api, el, extOf, fmtSize, loadCss, modal, toast, waitJob } from "./core.js";
import { badgeFor } from "./app.js";
import { fmtDateTime, LOCALE, t as tr } from "./i18n.js";

const $ = id => document.getElementById(id);
const call = (op, params = {}, opts = {}) => api("cloud", { op, ...params }, opts);
const ICON_CLOUD = '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/></svg>';
const SHORT = { onedrive: "OneDrive", gdrive: "Google Drive", dropbox: "Dropbox", autodesk: "Autodesk" };
const KIND_BADGE = { drive: ["DRV", "var(--brand)"], shared: ["CON", "var(--t-doc)"], sites: ["SP", "var(--t-xls)"], site: ["SITO", "var(--t-xls)"],
  hub: ["HUB", "var(--t-cad)"], project: ["PRJ", "var(--t-3d)"] };

let ST = { servizi: [] };     // stato dei servizi (configurato, connesso, account)
let svc = null;               // servizio mostrato
let stack = [];               // cartelle aperte [{id, name}]
let items = [], query = "";   // contenuto della cartella o risultati della ricerca
let loginJob = null;
const busy = new Set();       // file in caricamento
const remoteSeen = new Map(); // percorso -> versione remota gia' segnalata

// ------------------------------------------------------------------ pannello
export async function setupCloud() {
  loadCss("css/cloud.css");
  const btn = el("button", { id: "btn-cloud", class: "cmd desktop-only", title: tr("cloud.archivi_cloud_sharepoint_onedrive_google"), onclick: toggle });
  btn.insertAdjacentHTML("beforeend", ICON_CLOUD);
  btn.append(el("span", {}, tr("cloud.cloud")));
  $("btn-explorer").after(btn);
  const panel = el("aside", { class: "explorer cloud", id: "cloudpanel", hidden: true },
    el("div", { class: "ex-head" }, el("span", { class: "label" }, tr("cloud.archivi_cloud")),
      el("button", { class: "mini", title: tr("cloud.id_applicazione_servizi_guida_registrazione"), onclick: configure }, tr("cloud.configura")),
      el("button", { class: "mini", id: "cl-up", title: tr("cloud.cartella_superiore"), onclick: up }, tr("cloud.su"))),
    el("div", { class: "cl-svcs", id: "cl-svcs" }),
    el("div", { class: "cl-acc", id: "cl-acc" }),
    el("div", { class: "ex-path cl-crumbs", id: "cl-crumbs" }),
    el("input", { class: "ex-filter", id: "cl-search", type: "search", placeholder: tr("cloud.cerca_invio"), onkeydown: e => { if (e.key === "Enter") search(e.target.value.trim()); } }),
    el("div", { class: "ex-list", id: "cl-list" }),
    el("div", { class: "cl-foot" },
      el("button", { class: "mini", title: tr("cloud.ricarica_cartella"), onclick: () => load() }, tr("cloud.aggiorna")),
      el("button", { class: "mini", id: "cl-saveh", title: tr("cloud.salva_file_attivo_questa_cartella"), onclick: () => saveToCloud(true) }, tr("cloud.salva_qui_file_attivo"))),
    el("div", { class: "cl-open", id: "cl-open" }));
  $("explorer").after(panel);
  setInterval(syncLoop, 2500);
  setInterval(remoteLoop, 60000);
  window.MBCloud = { saveToCloud, toggle, configure, connected: () => ST.servizi.some(s => s.configurato && s.connesso) };
  await refreshState();
}

async function refreshState() {
  try { ST = await call("stato"); } catch (e) { ST = { servizi: [], errore: e.message }; }
  const vis = ST.servizi.filter(s => s.configurato);
  if (!vis.some(s => s.id === svc)) { svc = (vis.find(s => s.connesso) || vis[0])?.id || null; stack = []; }
  renderSvcs();
}

function toggle() {
  const p = $("cloudpanel");
  p.hidden = !p.hidden;
  $("btn-cloud").classList.toggle("on", !p.hidden);
  window.dispatchEvent(new Event("resize"));
  if (!p.hidden) refreshState().then(() => load());
}

const cur = () => ST.servizi.find(s => s.id === svc);

function renderSvcs() {
  const box = $("cl-svcs");
  box.innerHTML = "";
  for (const s of ST.servizi.filter(x => x.configurato)) {
    box.append(el("button", { class: "cl-svc" + (s.id === svc ? " on" : ""), title: s.nome + (s.connesso ? tr("cloud.collegato") : tr("cloud.non_collegato")),
      onclick: () => { svc = s.id; stack = []; query = ""; renderSvcs(); load(); } },
    el("span", { class: "dot" + (s.connesso ? " ok" : "") }), SHORT[s.id] || s.nome));
  }
  const acc = $("cl-acc");
  acc.innerHTML = "";
  const s = cur();
  if (s) {
    if (s.connesso) {
      const who = s.account ? [s.account.nome, s.account.email].filter(Boolean).join(" · ") : "";
      acc.append(el("span", { class: "who", title: who }, who || tr("cloud.collegato_2")),
        el("button", { class: "mini", title: tr("cloud.esci_0_questo_pc_token", s.nome), onclick: () => logout(s) }, tr("cloud.esci")));
    } else {
      acc.append(el("span", { class: "who" }, tr("cloud.non_collegato_2")), el("button", { class: "mini primary", onclick: () => login(s) }, tr("cloud.accedi")));
    }
  }
  $("cl-saveh").disabled = !(s?.connesso && stack.length);
}

function crumbs() {
  const box = $("cl-crumbs");
  box.innerHTML = "";
  const s = cur();
  if (!s) return;
  const seg = (text, i) => el("button", { class: "link", onclick: () => { stack = stack.slice(0, i); query = ""; load(); } }, text);
  box.append(seg(SHORT[s.id] || s.nome, 0));
  stack.forEach((f, i) => box.append(" › ", seg(f.name, i + 1)));
  if (query) box.append(" › ", el("i", {}, `ricerca "${query}"`));
}

function message(...nodes) {
  const box = $("cl-list");
  box.innerHTML = "";
  box.append(el("div", { class: "cl-msg" }, ...nodes));
}

async function load() {
  renderSvcs();
  crumbs();
  $("cl-search").value = query;
  const s = cur();
  if (!s && ST.errore) return message(el("p", { class: "bad" }, ST.errore), el("button", { class: "btn", onclick: () => refreshState().then(load) }, tr("cloud.riprova")));
  if (!s) {
    return message(el("p", {}, tr("cloud.nessun_archivio_cloud_configurato")),
      el("p", { class: "note" }, tr("cloud.usare_sharepoint_onedrive_google_drive")),
      el("button", { class: "btn primary", onclick: configure }, tr("cloud.configura_i_servizi")), " ",
      el("button", { class: "btn", onclick: openGuide }, tr("cloud.apri_guida")));
  }
  if (!s.connesso) {
    return message(el("p", {}, tr("cloud.accedi_0_sfogliare_i_file", s.nome)),
      el("p", { class: "note" }, tr("cloud.l_accesso_avviene_browser_predefinito")),
      el("button", { class: "btn primary", onclick: () => login(s) }, tr("cloud.accedi")));
  }
  message(el("div", { class: "spinner" }), tr("cloud.caricamento"));
  try {
    const r = query ? await call("search", { svc, q: query, id: stack.at(-1)?.id || "" }) : await call("list", { svc, id: stack.at(-1)?.id || "" });
    items = r.items || [];
    render();
  } catch (e) { fail(e); }
  renderOpened();
}

function fail(e) {
  refreshState().then(() => { if (!cur()?.connesso) load(); }); // accesso scaduto o revocato: torna il pulsante Accedi
  message(el("p", { class: "bad" }, e.message), el("button", { class: "btn", onclick: () => load() }, tr("cloud.riprova")));
}

function render() {
  const box = $("cl-list");
  box.innerHTML = "";
  for (const i of items) {
    const kb = KIND_BADGE[i.kind];
    const badge = kb ? Object.assign(el("span", { class: "badge" }, kb[0]), { style: `background:${kb[1]}` }) : badgeFor(i.name, i.dir);
    const when = i.modified ? new Date(i.modified * 1000).toLocaleString(LOCALE, { dateStyle: "short", timeStyle: "short" }) : "";
    box.append(el("button", { class: "ex-item" + (i.dir ? " dir" : ""), title: i.name + (when ? tr("cloud.modificato_0", when) : "") + (i.by ? ` da ${i.by}` : "") + (i.native ? tr("cloud.documento_google_si_apre_come") : ""),
      onclick: () => (i.dir ? enter(i) : openItem(i)) },
    badge, el("span", { class: "nm" }, i.name), el("span", { class: "sz" }, i.dir ? "" : fmtSize(i.size))));
  }
  if (!items.length) box.append(el("div", { class: "cl-msg note" }, query ? tr("cloud.nessun_file_trovato") : tr("cloud.cartella_vuota")));
}

function enter(i) { stack.push({ id: i.id, name: i.name }); query = ""; load(); }
function up() { if (query) query = ""; else stack.pop(); load(); }
function search(q) {
  const s = cur();
  if (q && !stack.length && s && !s.cerca_radice) return toast(tr("cloud.apri_progetto_cartella_cercare_file"), true);
  query = q;
  load();
}

// ------------------------------------------------------------------ accesso e uscita
async function login(s) {
  if (loginJob) await call("login_cancel", { svc: s.id }, { allowFail: true });
  let r;
  try { r = await call("login", { svc: s.id }); } catch (e) { return message(el("p", { class: "bad" }, e.message)); }
  loginJob = r.job;
  message(el("div", { class: "spinner" }), el("p", {}, tr("cloud.completa_l_accesso_0_finestra", s.nome)),
    el("p", { class: "note" }, tr("cloud.termine_browser_mostra_accesso_completato")),
    el("button", { class: "btn", onclick: () => login(s) }, tr("cloud.riapri_pagina")), " ",
    el("button", { class: "btn", onclick: () => call("login_cancel", { svc: s.id }, { allowFail: true }) }, tr("common.annulla")));
  try {
    const res = await waitJob(r.job);
    if (loginJob !== r.job) return;
    toast(tr("cloud.collegato_0", s.nome) + (res?.account?.email ? ": " + res.account.email : ""));
    await refreshState();
    load();
  } catch (e) {
    if (loginJob !== r.job) return; // sostituito da un nuovo tentativo
    message(el("p", { class: "bad" }, e.message), el("button", { class: "btn primary", onclick: () => login(s) }, tr("cloud.accedi")));
  } finally { if (loginJob === r.job) loginJob = null; }
}

async function logout(s) {
  const ok = await modal(tr("cloud.esci_0", s.nome), el("p", {}, tr("cloud.token_accesso_salvato_questo_pc")),
    [{ label: tr("common.annulla"), value: false }, { label: tr("cloud.esci"), value: true, danger: true }]);
  if (!ok) return;
  await call("logout", { svc: s.id }, { allowFail: true });
  stack = [];
  await refreshState();
  load();
}

// ------------------------------------------------------------------ apertura
async function openItem(i) {
  const s = cur();
  toast(tr("cloud.apertura_0_1", i.name, SHORT[s.id]), false, 600000);
  try {
    const { job } = await call("open", { svc: s.id, id: i.id });
    const r = await waitJob(job, (p, m) => { if (m) $("st-extra").textContent = `${m}`; });
    $("st-extra").textContent = "";
    toast(r.locale ? tr("cloud.0_aperta_copia_pc_modifiche", i.name) : tr("cloud.0_aperto_1", i.name, SHORT[s.id]), false, r.locale ? 6000 : 1800);
    const opening = window.MB.openFile(r.path); // alcuni editor (ONLYOFFICE) impiegano secondi a partire
    setTimeout(renderOpened, 400);
    await opening;
  } catch (e) {
    $("st-extra").textContent = "";
    toast(tr("cloud.apertura_non_riuscita") + e.message, true, 7000);
  }
}

// ------------------------------------------------------------------ file aperti dal cloud: caricamento dei salvataggi
const stLabel = st => tr({ sincronizzato: "cloud.st_sincronizzato", "da caricare": "cloud.st_da_caricare", caricamento: "cloud.st_caricamento" }[st] || st);
async function renderOpened() {
  const box = $("cl-open");
  if (!box || $("cloudpanel").hidden) return;
  let r;
  try { r = await call("aperti"); } catch { return; }
  const open = new Set(window.MB.tabs.map(t => t.path.toLowerCase()));
  const files = r.files.filter(f => open.has(f.path.toLowerCase()));
  box.innerHTML = "";
  if (!files.length) return;
  box.append(el("div", { class: "label" }, tr("cloud.aperti_cloud")));
  for (const f of files) {
    const row = el("div", { class: "cl-of " + f.stato.replace(" ", "-"), title: `${f.nome} - ${SHORT[f.servizio]}: ${stLabel(f.stato)}` },
      el("span", { class: "dot" }), el("span", { class: "nm" }, f.nome), el("span", { class: "st" }, stLabel(f.stato)));
    if (f.stato === "da caricare") row.append(el("button", { class: "mini", onclick: () => upload(f, false) }, tr("cloud.carica")));
    box.append(row);
  }
}

async function syncLoop() {
  if (document.hidden) return;
  let r;
  try { r = await call("pending", {}, { allowFail: true }); } catch { return; }
  for (const f of r.files || []) if (!busy.has(f.path)) upload(f, false);
  renderOpened();
}

async function upload(f, force) {
  if (busy.has(f.path)) return;
  busy.add(f.path);
  const where = SHORT[f.servizio] || "cloud";
  try {
    if (f.native) return await nativeCopy(f);
    toast(tr("cloud.caricamento_0_1", f.nome, where), false, 600000);
    const { job } = await call("upload", { path: f.path, force: force ? 1 : 0 });
    const r = await waitJob(job);
    if (r.conflitto) return await conflict(f, r.remoto);
    toast(tr("cloud.salvato_0_1", where, f.nome));
  } catch (e) {
    await call("skip", { path: f.path }, { allowFail: true }); // non riprova da solo: si ricarica dal pannello o al prossimo salvataggio
    toast(tr("cloud.0_salvato_solo_pc_caricamento", f.nome, where, e.message), true, 10000);
  } finally {
    busy.delete(f.path);
    renderOpened();
  }
}

async function nativeCopy(f) {
  const ok = await modal(tr("cloud.documento_google"), el("p", {}, tr("cloud.0_documento_google_documenti_fogli", f.nome)),
    [{ label: tr("cloud.non_ora"), value: false }, { label: tr("cloud.salva_come_nuovo_file"), value: true, primary: true }]);
  if (!ok) return call("skip", { path: f.path }, { allowFail: true });
  const { job } = await call("upload_copy", { path: f.path });
  const r = await waitJob(job);
  toast(tr("cloud.salvato_google_drive_come_0", r.nome), false, 5000);
}

async function conflict(f, rem) {
  const where = SHORT[f.servizio] || "cloud";
  const when = rem.modificato ? fmtDateTime(rem.modificato * 1000) : "";
  const choice = await modal(tr("cloud.file_cambiato_cloud"), el("div", { style: { display: "grid", gap: "8px", maxWidth: "520px" } },
    el("p", { style: { margin: 0 } }, tr("cloud.cambiato_msg", f.nome, where, (rem.autore ? tr("cloud.da_autore", rem.autore) : "") + (when ? tr("cloud.il_data", when) : ""))),
    el("p", { class: "note", style: { margin: 0 } }, tr("cloud.puoi_salvare_tue_modifiche_come"))),
  [{ label: tr("cloud.decidi_dopo"), value: null }, { label: tr("cloud.apri_versione_cloud"), value: "remote" }, { label: tr("cloud.sovrascrivi"), value: "force", danger: true }, { label: tr("cloud.salva_come_copia"), value: "copy", primary: true }]);
  if (choice === "force") { busy.delete(f.path); return upload(f, true); }
  if (choice === "copy") {
    const { job } = await call("upload_copy", { path: f.path });
    const r = await waitJob(job);
    return toast(tr("cloud.tue_modifiche_sono_0_come", where, r.nome), false, 6000);
  }
  if (choice === "remote") {
    const sure = await modal(tr("cloud.scartare_modifiche"), el("p", {}, tr("cloud.modifiche_fatte_mb_visual_0", f.nome)), [{ label: tr("common.annulla"), value: false }, { label: tr("cloud.scarta_apri"), value: true, danger: true }]);
    if (sure) return reloadFromCloud(f.path, f.nome, where);
  }
  await call("skip", { path: f.path }, { allowFail: true });
  toast(tr("cloud.0_non_stato_caricato_modifiche", f.nome), true, 7000);
}

async function reloadFromCloud(path, nome, where) {
  const { job } = await call("refresh", { path });
  await waitJob(job);
  const t = window.MB.tabs.find(x => x.path.toLowerCase() === path.toLowerCase());
  if (t) t.dirty = false; // la scheda si ricarica da sola (controllo delle modifiche esterne in app.js)
  toast(tr("cloud.0_aggiornato_versione_1", nome, where));
}

// la scheda attiva aperta dal cloud: se un collega salva una nuova versione, la si scarica (o si avvisa se ci sono modifiche)
async function remoteLoop() {
  const t = window.MB.active;
  if (!t || document.hidden || busy.has(t.path)) return;
  let r;
  try { r = await call("aperti", {}, { allowFail: true }); } catch { return; }
  if (!(r.files || []).some(f => f.path.toLowerCase() === t.path.toLowerCase())) return;
  try { r = await call("check", { path: t.path }, { allowFail: true }); } catch { return; }
  if (!r.ok || !r.cambiato) return;
  const info = await call("info", { path: t.path }, { allowFail: true });
  const where = SHORT[info.servizio] || "cloud";
  if (!r.locale && !t.dirty) {
    try { await reloadFromCloud(t.path, info.nome, where); } catch { /* */ }
    if (r.autore) toast(tr("cloud.0_aggiornato_nuova_versione_salvata", info.nome, r.autore, where), false, 5000);
    return;
  }
  const key = t.path + "|" + r.modificato;
  if (remoteSeen.has(key)) return;
  remoteSeen.set(key, true);
  toast(tr("cloud.attenzione_0_c_nuova_versione", where, info.nome, r.autore ? tr("cloud.salvata", r.autore) : ""), true, 9000);
}

// ------------------------------------------------------------------ Salva nel cloud (salva con nome verso il cloud)
export async function saveToCloud(here = false) {
  const t = window.MB.active;
  if (!t) return toast(tr("cloud.apri_prima_file"), true);
  await refreshState();
  const conn = ST.servizi.filter(s => s.configurato && s.connesso);
  if (!conn.length) {
    if ($("cloudpanel").hidden) toggle();
    return toast(tr("cloud.collegati_prima_archivio_pannello_cloud"), true, 5000);
  }
  let dsvc = here && svc && conn.some(s => s.id === svc) ? svc : (conn.find(s => s.id === svc) || conn[0]).id;
  let dstack = here && dsvc === svc ? [...stack] : [];
  const srcExt = extOf(t.path);
  const fmtSel = el("select", { class: "field" }, el("option", { value: srcExt }, tr("cloud.0_formato_attuale", srcExt.toUpperCase())));
  api("convert_targets", { path: t.path }).then(r => (r.targets || []).filter(c => c.ext !== srcExt)
    .forEach(c => fmtSel.append(el("option", { value: c.ext }, `${c.ext.toUpperCase()} - ${c.label}`)))).catch(() => { /* */ });
  const nameIn = el("input", { type: "text", class: "field", value: (t.info?.nome || t.name).replace(/^(.*?)( \(copia[^)]*\))?(\.[^.]+)?$/, "$1") + (srcExt ? "." + srcExt : "") });
  fmtSel.addEventListener("change", () => { nameIn.value = nameIn.value.replace(/\.[^.]+$/, "") + "." + fmtSel.value; });
  const svcSel = el("select", { class: "field" }, ...conn.map(s => el("option", { value: s.id, selected: s.id === dsvc || undefined }, s.nome)));
  const path = el("div", { class: "cl-crumbs" });
  const list = el("div", { class: "cl-pick" });
  const draw = async () => {
    path.innerHTML = "";
    const seg = (text, i) => el("button", { class: "link", onclick: () => { dstack = dstack.slice(0, i); draw(); } }, text);
    path.append(seg(SHORT[dsvc], 0));
    dstack.forEach((f, i) => path.append(" › ", seg(f.name, i + 1)));
    list.innerHTML = "";
    list.append(el("div", { class: "cl-msg" }, tr("cloud.caricamento")));
    try {
      const r = await call("list", { svc: dsvc, id: dstack.at(-1)?.id || "" });
      list.innerHTML = "";
      for (const i of r.items) {
        list.append(el("button", { class: "ex-item" + (i.dir ? " dir" : " off"), disabled: !i.dir || undefined, title: i.name,
          onclick: () => { dstack.push({ id: i.id, name: i.name }); draw(); } },
        badgeFor(i.name, i.dir), el("span", { class: "nm" }, i.name), el("span", { class: "sz" }, i.dir ? "" : fmtSize(i.size))));
      }
      if (!r.items.length) list.append(el("div", { class: "cl-msg note" }, tr("cloud.cartella_vuota")));
    } catch (e) { list.innerHTML = ""; list.append(el("div", { class: "cl-msg bad" }, e.message)); }
  };
  svcSel.addEventListener("change", () => { dsvc = svcSel.value; dstack = []; draw(); });
  draw();
  const body = el("div", { class: "cl-saveform" },
    el("label", {}, tr("cloud.archivio"), svcSel), el("div", { class: "lbl" }, tr("cloud.cartella_destinazione")), path, list,
    el("label", {}, tr("cloud.nome_file"), nameIn), el("label", {}, tr("cloud.formato"), fmtSel));
  const ok = await modal(tr("cloud.salva_cloud"), body, [{ label: tr("common.annulla"), value: false }, { label: tr("cloud.salva_qui"), value: true, primary: true }]);
  if (!ok) return;
  const name = nameIn.value.trim();
  if (!name) return toast(tr("cloud.nome_file_mancante"), true);
  if (!dstack.length && dsvc !== "dropbox") return toast(tr("cloud.scegli_cartella_destinazione"), true);
  try {
    const src = await prepareSource(t, fmtSel.value, name);
    let replace = false;
    for (;;) {
      toast(tr("cloud.caricamento_0_1", name, SHORT[dsvc]), false, 600000);
      const { job } = await call("save_new", {}, { json: { svc: dsvc, folder: dstack.at(-1)?.id || "", name, src, replace } });
      const r = await waitJob(job, (p, m) => { if (m) $("st-extra").textContent = m; });
      $("st-extra").textContent = "";
      if (r.esiste) {
        toast("", false, 1);
        const rep = await modal(tr("cloud.file_gia_esistente"), el("p", {}, tr("cloud.cartella_c_gia_0_sostituirlo", r.nome)),
          [{ label: tr("common.annulla"), value: false }, { label: tr("cloud.sostituisci"), value: true, danger: true }]);
        if (!rep) return toast(tr("cloud.non_salvato"), true);
        replace = true;
        continue;
      }
      toast(tr("cloud.salvato_0_1", SHORT[dsvc], r.nome), false, 4000);
      if (!$("cloudpanel").hidden && dsvc === svc) load();
      return;
    }
  } catch (e) {
    $("st-extra").textContent = "";
    toast(tr("cloud.salvataggio_cloud_non_riuscito") + e.message, true, 8000);
  }
}

// file da caricare: lo stato attuale del documento (anche non salvato) nel formato scelto
async function prepareSource(t, fmt, name) {
  const a = t.api || {};
  let src = t.path;
  if ((t.dirty || t.untitled) && a.save) {
    src = (await api("temp_path", { name: t.info?.nome || t.name })).path;
    await a.save(src);
  }
  if (fmt === extOf(src)) return src;
  toast(tr("cloud.conversione_0", fmt.toUpperCase()), false, 600000);
  const out = (await api("temp_path", { name: name.replace(/\.[^.]+$/, "") + "." + fmt })).path;
  const { job } = await api("convert", { path: src }, { json: { out } });
  const r = await waitJob(job, (p, m) => { $("st-extra").textContent = `${m || tr("cloud.conversione")} ${Math.round(p * 100)}%`; });
  $("st-extra").textContent = "";
  if (r?.files?.length > 1 || r?.cartella) throw new Error(tr("cloud.questo_formato_produce_piu_file"));
  return out;
}

// ------------------------------------------------------------------ configurazione (ID applicazione registrati dall'utente)
async function openGuide() {
  try { const r = await call("guida"); await window.MB.openFile(r.path); } catch (e) { toast(e.message, true); }
}

async function configure() {
  let c;
  try { c = await call("config"); } catch (e) { return toast(tr("cloud.configurazione_non_disponibile") + e.message, true); }
  const fields = {};
  const box = el("div", { class: "cl-config" },
    el("p", { class: "note" }, tr("cloud.ogni_servizio_richiede_registrazione_gratuita"),
      el("button", { class: "link", onclick: openGuide }, tr("cloud.guida_passo_passo"))));
  for (const [id, s] of Object.entries(c.servizi)) {
    const f = fields[id] = { client_id: el("input", { type: "text", class: "field", value: s.client_id, placeholder: tr("cloud.id_applicazione_client_id"), spellcheck: false }) };
    const sec = el("fieldset", {}, el("legend", {}, s.nome), el("label", {}, tr("cloud.id_applicazione"), f.client_id));
    if (id === "onedrive") {
      f.tenant = el("input", { type: "text", class: "field", value: s.tenant || "common", placeholder: "common", spellcheck: false });
      sec.append(el("label", {}, tr("cloud.tenant_common_organizations_id_directory"), f.tenant));
    }
    if (s.serve_segreto) {
      f.client_secret = el("input", { type: "password", class: "field", placeholder: s.segreto ? tr("cloud.gia_impostato_lascia_vuoto_non") : tr("cloud.segreto_client_dell_app_desktop"), autocomplete: "off" });
      sec.append(el("label", {}, tr("cloud.segreto_client_inserisci_tu_resta"), f.client_secret));
    }
    const ru = el("code", {}, s.redirect);
    sec.append(el("div", { class: "cl-redirect" }, id === "gdrive" ? tr("cloud.indirizzo_ritorno_non_va_registrato") : tr("cloud.indirizzo_ritorno_registrare"), ru,
      el("button", { class: "mini", onclick: () => navigator.clipboard?.writeText(s.redirect).then(() => toast(tr("cloud.indirizzo_copiato"))) }, tr("common.copia"))));
    box.append(sec);
  }
  const port = el("input", { type: "number", class: "field", value: c.porta, min: 1024, max: 65535, style: { width: "110px" } });
  box.append(el("label", { class: "cl-port" }, tr("cloud.porta_locale_ritorno_dall_accesso"), port));
  const ok = await modal(tr("cloud.archivi_cloud_configurazione"), box, [{ label: tr("common.annulla"), value: false }, { label: tr("common.salva"), value: true, primary: true }]);
  if (!ok) return;
  const servizi = {};
  for (const [id, f] of Object.entries(fields)) {
    servizi[id] = { client_id: f.client_id.value.trim() };
    if (f.tenant) servizi[id].tenant = f.tenant.value.trim() || "common";
    if (f.client_secret && f.client_secret.value.trim()) servizi[id].client_secret = f.client_secret.value.trim();
  }
  try {
    await call("config_set", {}, { json: { servizi, porta: Number(port.value) || c.porta } });
    toast(tr("cloud.configurazione_salvata"));
  } catch (e) { return toast(e.message, true); }
  await refreshState();
  if ($("cloudpanel").hidden) toggle(); else load();
}

export const CLOUD_ICON = ICON_CLOUD;
