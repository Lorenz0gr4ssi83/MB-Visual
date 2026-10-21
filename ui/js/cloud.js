// MB Visual - Archivi cloud (solo app per PC): pannello accanto a Esplora con SharePoint/OneDrive, Google Drive, Dropbox,
// Autodesk Construction Cloud / BIM 360. I file si aprono senza sincronizzare le cartelle (download temporaneo) e ogni
// salvataggio torna sul cloud con il controllo della versione. Motore: mbvisual/cloud.py (API /api/cloud?op=...).
import { api, el, extOf, fmtSize, loadCss, modal, toast, waitJob } from "./core.js";
import { badgeFor } from "./app.js";

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
  const btn = el("button", { id: "btn-cloud", class: "cmd desktop-only", title: "Archivi cloud: SharePoint/OneDrive, Google Drive, Dropbox, Autodesk (senza sincronizzare le cartelle)", onclick: toggle });
  btn.insertAdjacentHTML("beforeend", ICON_CLOUD);
  btn.append(el("span", {}, "Cloud"));
  $("btn-explorer").after(btn);
  const panel = el("aside", { class: "explorer cloud", id: "cloudpanel", hidden: true },
    el("div", { class: "ex-head" }, el("span", { class: "label" }, "Archivi cloud"),
      el("button", { class: "mini", title: "ID applicazione dei servizi e guida alla registrazione", onclick: configure }, "Configura"),
      el("button", { class: "mini", id: "cl-up", title: "Cartella superiore", onclick: up }, "Su")),
    el("div", { class: "cl-svcs", id: "cl-svcs" }),
    el("div", { class: "cl-acc", id: "cl-acc" }),
    el("div", { class: "ex-path cl-crumbs", id: "cl-crumbs" }),
    el("input", { class: "ex-filter", id: "cl-search", type: "search", placeholder: "Cerca (Invio)", onkeydown: e => { if (e.key === "Enter") search(e.target.value.trim()); } }),
    el("div", { class: "ex-list", id: "cl-list" }),
    el("div", { class: "cl-foot" },
      el("button", { class: "mini", title: "Ricarica la cartella", onclick: () => load() }, "Aggiorna"),
      el("button", { class: "mini", id: "cl-saveh", title: "Salva il file attivo in questa cartella del cloud", onclick: () => saveToCloud(true) }, "Salva qui il file attivo")),
    el("div", { class: "cl-open", id: "cl-open" }));
  $("explorer").after(panel);
  setInterval(syncLoop, 2500);
  setInterval(remoteLoop, 60000);
  window.MBCloud = { saveToCloud, toggle, connected: () => ST.servizi.some(s => s.configurato && s.connesso) };
  await refreshState();
}

async function refreshState() {
  try { ST = await call("stato"); } catch { ST = { servizi: [] }; }
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
    box.append(el("button", { class: "cl-svc" + (s.id === svc ? " on" : ""), title: s.nome + (s.connesso ? " - collegato" : " - non collegato"),
      onclick: () => { svc = s.id; stack = []; query = ""; renderSvcs(); load(); } },
    el("span", { class: "dot" + (s.connesso ? " ok" : "") }), SHORT[s.id] || s.nome));
  }
  const acc = $("cl-acc");
  acc.innerHTML = "";
  const s = cur();
  if (s) {
    if (s.connesso) {
      const who = s.account ? [s.account.nome, s.account.email].filter(Boolean).join(" · ") : "";
      acc.append(el("span", { class: "who", title: who }, who || "Collegato"),
        el("button", { class: "mini", title: "Esci da " + s.nome + " su questo PC (il token salvato viene cancellato)", onclick: () => logout(s) }, "Esci"));
    } else {
      acc.append(el("span", { class: "who" }, "Non collegato"), el("button", { class: "mini primary", onclick: () => login(s) }, "Accedi"));
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
  if (!s) {
    return message(el("p", {}, "Nessun archivio cloud configurato."),
      el("p", { class: "note" }, "Per usare SharePoint/OneDrive, Google Drive, Dropbox o Autodesk Construction Cloud serve una registrazione dell'app presso il fornitore (gratuita, una volta sola): la guida spiega i passaggi."),
      el("button", { class: "btn primary", onclick: configure }, "Configura i servizi"), " ",
      el("button", { class: "btn", onclick: openGuide }, "Apri la guida"));
  }
  if (!s.connesso) {
    return message(el("p", {}, `Accedi a ${s.nome} per sfogliare i file.`),
      el("p", { class: "note" }, "L'accesso avviene nel browser predefinito. MB Visual conserva solo un token cifrato per il tuo utente di Windows: nessuna password viene salvata."),
      el("button", { class: "btn primary", onclick: () => login(s) }, "Accedi"));
  }
  message(el("div", { class: "spinner" }), "Caricamento...");
  try {
    const r = query ? await call("search", { svc, q: query, id: stack.at(-1)?.id || "" }) : await call("list", { svc, id: stack.at(-1)?.id || "" });
    items = r.items || [];
    render();
  } catch (e) { fail(e); }
  renderOpened();
}

function fail(e) {
  if (/accedi di nuovo|non sei collegato/i.test(e.message)) refreshState().then(() => { if (!cur()?.connesso) load(); });
  message(el("p", { class: "bad" }, e.message), el("button", { class: "btn", onclick: () => load() }, "Riprova"));
}

function render() {
  const box = $("cl-list");
  box.innerHTML = "";
  for (const i of items) {
    const kb = KIND_BADGE[i.kind];
    const badge = kb ? Object.assign(el("span", { class: "badge" }, kb[0]), { style: `background:${kb[1]}` }) : badgeFor(i.name, i.dir);
    const when = i.modified ? new Date(i.modified * 1000).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "";
    box.append(el("button", { class: "ex-item" + (i.dir ? " dir" : ""), title: i.name + (when ? `\nModificato il ${when}` : "") + (i.by ? ` da ${i.by}` : "") + (i.native ? "\nDocumento Google: si apre come copia Office" : ""),
      onclick: () => (i.dir ? enter(i) : openItem(i)) },
    badge, el("span", { class: "nm" }, i.name), el("span", { class: "sz" }, i.dir ? "" : fmtSize(i.size))));
  }
  if (!items.length) box.append(el("div", { class: "cl-msg note" }, query ? "Nessun file trovato" : "Cartella vuota"));
}

function enter(i) { stack.push({ id: i.id, name: i.name }); query = ""; load(); }
function up() { if (query) query = ""; else stack.pop(); load(); }
function search(q) {
  const s = cur();
  if (q && !stack.length && s && !s.cerca_radice) return toast("Apri un progetto e una cartella per cercare nei file Autodesk", true);
  query = q;
  load();
}

// ------------------------------------------------------------------ accesso e uscita
async function login(s) {
  if (loginJob) await call("login_cancel", { svc: s.id }, { allowFail: true });
  let r;
  try { r = await call("login", { svc: s.id }); } catch (e) { return message(el("p", { class: "bad" }, e.message)); }
  loginJob = r.job;
  message(el("div", { class: "spinner" }), el("p", {}, `Completa l'accesso a ${s.nome} nella finestra del browser che si e' aperta.`),
    el("p", { class: "note" }, "Al termine il browser mostra \"Accesso completato\": torna qui. Se la pagina non si e' aperta, riprova."),
    el("button", { class: "btn", onclick: () => login(s) }, "Riapri la pagina"), " ",
    el("button", { class: "btn", onclick: () => call("login_cancel", { svc: s.id }, { allowFail: true }) }, "Annulla"));
  try {
    const res = await waitJob(r.job);
    if (loginJob !== r.job) return;
    toast(`Collegato a ${s.nome}` + (res?.account?.email ? ": " + res.account.email : ""));
    await refreshState();
    load();
  } catch (e) {
    if (loginJob !== r.job) return; // sostituito da un nuovo tentativo
    message(el("p", { class: /annullato/i.test(e.message) ? "" : "bad" }, e.message), el("button", { class: "btn primary", onclick: () => login(s) }, "Accedi"));
  } finally { if (loginJob === r.job) loginJob = null; }
}

async function logout(s) {
  const ok = await modal("Esci da " + s.nome, el("p", {}, "Il token di accesso salvato su questo PC verra' cancellato. I file gia' aperti restano nelle schede ma non verranno piu' caricati sul cloud finche' non accedi di nuovo."),
    [{ label: "Annulla", value: false }, { label: "Esci", value: true, danger: true }]);
  if (!ok) return;
  await call("logout", { svc: s.id }, { allowFail: true });
  stack = [];
  await refreshState();
  load();
}

// ------------------------------------------------------------------ apertura
async function openItem(i) {
  const s = cur();
  toast(`Apertura di "${i.name}" da ${SHORT[s.id]}...`, false, 600000);
  try {
    const { job } = await call("open", { svc: s.id, id: i.id });
    const r = await waitJob(job, (p, m) => { if (m) $("st-extra").textContent = `${m}`; });
    $("st-extra").textContent = "";
    toast(r.locale ? `"${i.name}": aperta la copia sul PC con modifiche non ancora caricate` : `"${i.name}" aperto da ${SHORT[s.id]}`, false, r.locale ? 6000 : 1800);
    const opening = window.MB.openFile(r.path); // alcuni editor (ONLYOFFICE) impiegano secondi a partire
    setTimeout(renderOpened, 400);
    await opening;
  } catch (e) {
    $("st-extra").textContent = "";
    toast("Apertura non riuscita: " + e.message, true, 7000);
  }
}

// ------------------------------------------------------------------ file aperti dal cloud: caricamento dei salvataggi
async function renderOpened() {
  const box = $("cl-open");
  if (!box || $("cloudpanel").hidden) return;
  let r;
  try { r = await call("aperti"); } catch { return; }
  const open = new Set(window.MB.tabs.map(t => t.path.toLowerCase()));
  const files = r.files.filter(f => open.has(f.path.toLowerCase()));
  box.innerHTML = "";
  if (!files.length) return;
  box.append(el("div", { class: "label" }, "Aperti dal cloud"));
  for (const f of files) {
    const row = el("div", { class: "cl-of " + f.stato.replace(" ", "-"), title: `${f.nome} - ${SHORT[f.servizio]}: ${f.stato}` },
      el("span", { class: "dot" }), el("span", { class: "nm" }, f.nome), el("span", { class: "st" }, f.stato));
    if (f.stato === "da caricare") row.append(el("button", { class: "mini", onclick: () => upload(f, false) }, "Carica"));
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
    toast(`Caricamento di "${f.nome}" su ${where}...`, false, 600000);
    const { job } = await call("upload", { path: f.path, force: force ? 1 : 0 });
    const r = await waitJob(job);
    if (r.conflitto) return await conflict(f, r.remoto);
    toast(`Salvato su ${where}: ${f.nome}`);
  } catch (e) {
    await call("skip", { path: f.path }, { allowFail: true }); // non riprova da solo: si ricarica dal pannello o al prossimo salvataggio
    toast(`"${f.nome}" e' salvato solo sul PC: caricamento su ${where} non riuscito (${e.message}). Usa "Carica" nel pannello Cloud.`, true, 10000);
  } finally {
    busy.delete(f.path);
    renderOpened();
  }
}

async function nativeCopy(f) {
  const ok = await modal("Documento Google", el("p", {}, `"${f.nome}" e' un documento di Google (Documenti, Fogli o Presentazioni) aperto come copia Office: non si puo' sovrascrivere. Salvare le modifiche come nuovo file Office nella stessa cartella di Google Drive?`),
    [{ label: "Non ora", value: false }, { label: "Salva come nuovo file", value: true, primary: true }]);
  if (!ok) return call("skip", { path: f.path }, { allowFail: true });
  const { job } = await call("upload_copy", { path: f.path });
  const r = await waitJob(job);
  toast(`Salvato su Google Drive come "${r.nome}"`, false, 5000);
}

async function conflict(f, rem) {
  const where = SHORT[f.servizio] || "cloud";
  const when = rem.modificato ? new Date(rem.modificato * 1000).toLocaleString("it-IT") : "";
  const choice = await modal("Il file e' cambiato sul cloud", el("div", { style: { display: "grid", gap: "8px", maxWidth: "520px" } },
    el("p", { style: { margin: 0 } }, `"${f.nome}" e' stato modificato su ${where}${rem.autore ? " da " + rem.autore : ""}${when ? " il " + when : ""}, dopo che l'hai aperto in MB Visual.`),
    el("p", { class: "note", style: { margin: 0 } }, "Puoi salvare le tue modifiche come copia accanto all'originale (scelta sicura), sovrascrivere la versione sul cloud (le modifiche dell'altra persona restano nella cronologia delle versioni del servizio) oppure scartare le tue e aprire la versione del cloud.")),
  [{ label: "Decidi dopo", value: null }, { label: "Apri la versione del cloud", value: "remote" }, { label: "Sovrascrivi", value: "force", danger: true }, { label: "Salva come copia", value: "copy", primary: true }]);
  if (choice === "force") { busy.delete(f.path); return upload(f, true); }
  if (choice === "copy") {
    const { job } = await call("upload_copy", { path: f.path });
    const r = await waitJob(job);
    return toast(`Le tue modifiche sono su ${where} come "${r.nome}"`, false, 6000);
  }
  if (choice === "remote") {
    const sure = await modal("Scartare le modifiche?", el("p", {}, `Le modifiche fatte in MB Visual a "${f.nome}" andranno perse.`), [{ label: "Annulla", value: false }, { label: "Scarta e apri", value: true, danger: true }]);
    if (sure) return reloadFromCloud(f.path, f.nome, where);
  }
  await call("skip", { path: f.path }, { allowFail: true });
  toast(`"${f.nome}" non e' stato caricato: le modifiche restano sul PC (pannello Cloud -> Carica)`, true, 7000);
}

async function reloadFromCloud(path, nome, where) {
  const { job } = await call("refresh", { path });
  await waitJob(job);
  const t = window.MB.tabs.find(x => x.path.toLowerCase() === path.toLowerCase());
  if (t) t.dirty = false; // la scheda si ricarica da sola (controllo delle modifiche esterne in app.js)
  toast(`"${nome}" aggiornato con la versione di ${where}`);
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
    if (r.autore) toast(`"${info.nome}" aggiornato: nuova versione salvata da ${r.autore} su ${where}`, false, 5000);
    return;
  }
  const key = t.path + "|" + r.modificato;
  if (remoteSeen.has(key)) return;
  remoteSeen.set(key, true);
  toast(`Attenzione: su ${where} c'e' una nuova versione di "${info.nome}"${r.autore ? " salvata da " + r.autore : ""}. Al salvataggio ti verra' chiesto come procedere.`, true, 9000);
}

// ------------------------------------------------------------------ Salva nel cloud (salva con nome verso il cloud)
export async function saveToCloud(here = false) {
  const t = window.MB.active;
  if (!t) return toast("Apri prima un file", true);
  await refreshState();
  const conn = ST.servizi.filter(s => s.configurato && s.connesso);
  if (!conn.length) {
    if ($("cloudpanel").hidden) toggle();
    return toast("Collegati prima a un archivio dal pannello Cloud", true, 5000);
  }
  let dsvc = here && svc && conn.some(s => s.id === svc) ? svc : (conn.find(s => s.id === svc) || conn[0]).id;
  let dstack = here && dsvc === svc ? [...stack] : [];
  const srcExt = extOf(t.path);
  const fmtSel = el("select", { class: "field" }, el("option", { value: srcExt }, `${srcExt.toUpperCase()} (formato attuale)`));
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
    list.append(el("div", { class: "cl-msg" }, "Caricamento..."));
    try {
      const r = await call("list", { svc: dsvc, id: dstack.at(-1)?.id || "" });
      list.innerHTML = "";
      for (const i of r.items) {
        list.append(el("button", { class: "ex-item" + (i.dir ? " dir" : " off"), disabled: !i.dir || undefined, title: i.name,
          onclick: () => { dstack.push({ id: i.id, name: i.name }); draw(); } },
        badgeFor(i.name, i.dir), el("span", { class: "nm" }, i.name), el("span", { class: "sz" }, i.dir ? "" : fmtSize(i.size))));
      }
      if (!r.items.length) list.append(el("div", { class: "cl-msg note" }, "Cartella vuota"));
    } catch (e) { list.innerHTML = ""; list.append(el("div", { class: "cl-msg bad" }, e.message)); }
  };
  svcSel.addEventListener("change", () => { dsvc = svcSel.value; dstack = []; draw(); });
  draw();
  const body = el("div", { class: "cl-saveform" },
    el("label", {}, "Archivio", svcSel), el("div", { class: "lbl" }, "Cartella di destinazione"), path, list,
    el("label", {}, "Nome del file", nameIn), el("label", {}, "Formato", fmtSel));
  const ok = await modal("Salva nel cloud", body, [{ label: "Annulla", value: false }, { label: "Salva qui", value: true, primary: true }]);
  if (!ok) return;
  const name = nameIn.value.trim();
  if (!name) return toast("Nome del file mancante", true);
  if (!dstack.length && dsvc !== "dropbox") return toast("Scegli una cartella di destinazione", true);
  try {
    const src = await prepareSource(t, fmtSel.value, name);
    let replace = false;
    for (;;) {
      toast(`Caricamento di "${name}" su ${SHORT[dsvc]}...`, false, 600000);
      const { job } = await call("save_new", {}, { json: { svc: dsvc, folder: dstack.at(-1)?.id || "", name, src, replace } });
      const r = await waitJob(job, (p, m) => { if (m) $("st-extra").textContent = m; });
      $("st-extra").textContent = "";
      if (r.esiste) {
        toast("", false, 1);
        const rep = await modal("File gia' esistente", el("p", {}, `Nella cartella c'e' gia' "${r.nome}". Sostituirlo con una nuova versione?`),
          [{ label: "Annulla", value: false }, { label: "Sostituisci", value: true, danger: true }]);
        if (!rep) return toast("Non salvato", true);
        replace = true;
        continue;
      }
      toast(`Salvato su ${SHORT[dsvc]}: ${r.nome}`, false, 4000);
      if (!$("cloudpanel").hidden && dsvc === svc) load();
      return;
    }
  } catch (e) {
    $("st-extra").textContent = "";
    toast("Salvataggio nel cloud non riuscito: " + e.message, true, 8000);
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
  toast(`Conversione in ${fmt.toUpperCase()}...`, false, 600000);
  const out = (await api("temp_path", { name: name.replace(/\.[^.]+$/, "") + "." + fmt })).path;
  const { job } = await api("convert", { path: src }, { json: { out } });
  const r = await waitJob(job, (p, m) => { $("st-extra").textContent = `${m || "Conversione"} ${Math.round(p * 100)}%`; });
  $("st-extra").textContent = "";
  if (r?.files?.length > 1 || r?.cartella) throw new Error("questo formato produce piu' file: salvalo sul PC e caricalo come archivio");
  return out;
}

// ------------------------------------------------------------------ configurazione (ID applicazione registrati dall'utente)
async function openGuide() {
  try { const r = await call("guida"); await window.MB.openFile(r.path); } catch (e) { toast(e.message, true); }
}

async function configure() {
  let c;
  try { c = await call("config"); } catch (e) { return toast("Configurazione non disponibile: " + e.message, true); }
  const fields = {};
  const box = el("div", { class: "cl-config" },
    el("p", { class: "note" }, "Ogni servizio richiede una registrazione gratuita dell'app presso il fornitore, fatta con il tuo account. Copia qui l'ID applicazione ottenuto; i servizi senza ID restano nascosti. ",
      el("button", { class: "link", onclick: openGuide }, "Guida passo passo")));
  for (const [id, s] of Object.entries(c.servizi)) {
    const f = fields[id] = { client_id: el("input", { type: "text", class: "field", value: s.client_id, placeholder: "ID applicazione (client ID)", spellcheck: false }) };
    const sec = el("fieldset", {}, el("legend", {}, s.nome), el("label", {}, "ID applicazione", f.client_id));
    if (id === "onedrive") {
      f.tenant = el("input", { type: "text", class: "field", value: s.tenant || "common", placeholder: "common", spellcheck: false });
      sec.append(el("label", {}, "Tenant (common, organizations o ID della directory)", f.tenant));
    }
    if (s.serve_segreto) {
      f.client_secret = el("input", { type: "password", class: "field", placeholder: s.segreto ? "gia' impostato (lascia vuoto per non cambiarlo)" : "segreto client dell'app desktop", autocomplete: "off" });
      sec.append(el("label", {}, "Segreto client (lo inserisci tu: resta cifrato su questo PC)", f.client_secret));
    }
    const ru = el("code", {}, s.redirect);
    sec.append(el("div", { class: "cl-redirect" }, id === "gdrive" ? "Indirizzo di ritorno (non va registrato per le app desktop): " : "Indirizzo di ritorno da registrare: ", ru,
      el("button", { class: "mini", onclick: () => navigator.clipboard?.writeText(s.redirect).then(() => toast("Indirizzo copiato")) }, "Copia")));
    box.append(sec);
  }
  const port = el("input", { type: "number", class: "field", value: c.porta, min: 1024, max: 65535, style: { width: "110px" } });
  box.append(el("label", { class: "cl-port" }, "Porta locale per il ritorno dall'accesso (se la cambi, aggiorna gli indirizzi registrati)", port));
  const ok = await modal("Archivi cloud - configurazione", box, [{ label: "Annulla", value: false }, { label: "Salva", value: true, primary: true }]);
  if (!ok) return;
  const servizi = {};
  for (const [id, f] of Object.entries(fields)) {
    servizi[id] = { client_id: f.client_id.value.trim() };
    if (f.tenant) servizi[id].tenant = f.tenant.value.trim() || "common";
    if (f.client_secret && f.client_secret.value.trim()) servizi[id].client_secret = f.client_secret.value.trim();
  }
  try {
    await call("config_set", {}, { json: { servizi, porta: Number(port.value) || c.porta } });
    toast("Configurazione salvata");
  } catch (e) { return toast(e.message, true); }
  await refreshState();
  if ($("cloudpanel").hidden) toggle(); else load();
}

export const CLOUD_ICON = ICON_CLOUD;
