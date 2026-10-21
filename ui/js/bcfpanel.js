// Pannello delle segnalazioni BCF: elenco con filtri, scheda della segnalazione (campi, punti di vista, commenti), apertura,
// salvataggio in .bcfzip (2.1 o 3.0) e report PDF/Excel. Si usa nel visualizzatore 3D (con il ponte di ui/js/bcfview.js:
// crea punti di vista e li ripristina) e da solo per i file .bcfzip aperti senza modello (ui/js/viewers/bcf.js).
import { askText, baseName, confirmBox, dirName, el, loadCss, modal, pickFiles, pickSavePath, readBytes, saveBlobAs, saveBytes, toast } from "./core.js";
import { bridge } from "./bcfview.js";
import { DEFAULTS, IT, dateIt, isOverdue, newStore, newTopic, nowIso, readBcf, statusTone, tr, uuid, writeBcf } from "./bcf.js";

const AUTHOR_KEY = "mbv-bcf-autore";
function storedAuthor() { try { return localStorage.getItem(AUTHOR_KEY) || ""; } catch { return ""; } }
export async function author(force = false) {
  let a = storedAuthor();
  if (!a || force) {
    const v = await askText("Autore delle segnalazioni", "Nome o email con cui firmare segnalazioni e commenti (lo usano Revit, Navisworks, Solibri, BIMcollab)", a);
    if (v === null) return a || "";
    a = v.trim();
    try { localStorage.setItem(AUTHOR_KEY, a); } catch { /* */ }
  }
  return a;
}

// ---- copia di recupero delle segnalazioni non salvate (IndexedDB: le istantanee sono Blob)
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("mbvisual-bcf", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("recupero");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => { const tx = db.transaction("recupero", mode); const q = fn(tx.objectStore("recupero")); tx.oncomplete = () => res(q?.result); tx.onerror = () => rej(tx.error); });
  } catch (e) { console.warn("BCF: copia di recupero non disponibile", e); return null; }
}
export const recovery = {
  get: key => idbDo("readonly", s => s.get(key)),
  put: (key, store) => idbDo("readwrite", s => s.put({ store, date: Date.now() }, key)),
  del: key => idbDo("readwrite", s => s.delete(key)),
};

const ICON = {
  plus: '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  back: '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6"/></svg>',
  cam: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 5h3l1-1.6h4L11 5h3v8H2z" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="9" r="2.3" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
};

export function createPanel(opt) {
  loadCss("css/bcf.css");
  const S = {
    store: opt.store || newStore(), path: opt.path || null, dirty: false, current: null, vpIndex: 0,
    f: { q: "", status: "", type: "", priority: "", assigned: "", overdue: false },
  };
  const br = opt.bridge || null; // ponte con la scena 3D (assente nel visualizzatore BCF da solo)
  const root = el("div", { class: "bcf-panel" + (opt.overlay ? " bcf-overlay" : "") });
  const urls = new Map(); // istantanea -> object URL
  const urlOf = blob => { if (!blob) return ""; if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob)); return urls.get(blob); };

  function setDirty(v = true) {
    S.dirty = v;
    opt.onDirty?.(v);
    renderHead();
    if (v && opt.recoveryKey) { clearTimeout(S.recT); S.recT = setTimeout(() => recovery.put(opt.recoveryKey, S.store), 800); }
  }
  function touch(t) { t.modifiedDate = nowIso(); t.modifiedAuthor = storedAuthor() || t.modifiedAuthor; setDirty(); }

  // ---------------------------------------------------------------- intestazione
  const head = el("div", { class: "bcf-head" });
  const filters = el("div", { class: "bcf-filters" });
  const body = el("div", { class: "bcf-body" });
  root.append(head, filters, body);

  function renderHead() {
    head.innerHTML = "";
    const n = S.store.topics.length;
    const title = el("div", { class: "bcf-title" }, el("b", {}, "Segnalazioni BCF"), el("span", { class: "bcf-count" }, String(n)),
      S.dirty ? el("span", { class: "bcf-unsaved", title: "Modifiche non salvate in un file BCF" }, "non salvate") : null,
      el("span", { style: { flex: 1 } }),
      opt.onClose ? el("button", { class: "bcf-x", title: "Chiudi il pannello", html: ICON.close, onclick: () => opt.onClose() }) : null);
    const report = el("select", { title: "Report delle segnalazioni (quelle filtrate)", onchange: e => { const v = e.target.value; e.target.value = ""; if (v) doReport(v); } },
      el("option", { value: "" }, "Report..."), el("option", { value: "pdf" }, "Report PDF"), el("option", { value: "xlsx" }, "Report Excel"));
    const row = el("div", { class: "bcf-actions" },
      br ? el("button", { class: "btn primary", onclick: createTopic, title: "Nuova segnalazione con il punto di vista attuale (camera, selezione, sezione) e l'istantanea", html: ICON.plus + "Nuova" }) : null,
      el("button", { class: "btn", onclick: openBcf, title: br ? "Apri un file BCF e sovrapponi le segnalazioni a questo modello" : "Apri un altro file BCF" }, "Apri BCF"),
      el("button", { class: "btn", onclick: () => save(false), title: S.path ? "Salva in " + baseName(S.path) : "Salva in un file .bcfzip" }, "Salva"),
      el("button", { class: "btn", onclick: () => save(true), title: "Salva in un nuovo file, BCF 2.1 o 3.0" }, "Salva con nome"),
      report);
    head.append(title, row);
    if (S.path) head.append(el("div", { class: "bcf-file", title: S.path }, `${baseName(S.path)} · BCF ${S.store.version}`));
  }

  // ---------------------------------------------------------------- filtri
  function renderFilters() {
    filters.innerHTML = "";
    if (S.current) { filters.hidden = true; return; }
    filters.hidden = false;
    const T = S.store.topics;
    const opts = (kind, key) => [...new Set(T.map(t => t[key]).filter(Boolean))].sort().map(v => el("option", { value: v, selected: S.f[kind] === v }, kind === "assigned" ? v : tr(kind, v)));
    const sel = (kind, key, label) => el("select", { onchange: e => { S.f[kind] = e.target.value; renderList(); } }, el("option", { value: "" }, label), ...opts(kind, key));
    const q = el("input", { type: "search", placeholder: "Cerca nel titolo, descrizione, commenti...", value: S.f.q });
    q.addEventListener("input", () => { S.f.q = q.value; renderList(); });
    const od = el("input", { type: "checkbox", checked: S.f.overdue });
    od.addEventListener("change", () => { S.f.overdue = od.checked; renderList(); });
    filters.append(q, el("div", { class: "bcf-frow" }, sel("status", "status", "Tutti gli stati"), sel("type", "type", "Tutti i tipi"), sel("priority", "priority", "Ogni priorita'"),
      sel("assigned", "assignedTo", "Tutti gli assegnatari"), el("label", { class: "bcf-chk" }, od, "Scadute")));
  }
  function visible() {
    const f = S.f, q = f.q.trim().toLowerCase();
    return S.store.topics.filter(t => (!f.status || t.status === f.status) && (!f.type || t.type === f.type) && (!f.priority || t.priority === f.priority)
      && (!f.assigned || t.assignedTo === f.assigned) && (!f.overdue || isOverdue(t))
      && (!q || [t.title, t.description, t.assignedTo, t.creationAuthor, t.labels.join(" "), ...t.comments.map(c => c.text)].join("\n").toLowerCase().includes(q)));
  }

  // ---------------------------------------------------------------- elenco
  function renderList() {
    body.innerHTML = "";
    const list = visible();
    if (!S.store.topics.length) {
      body.append(el("div", { class: "bcf-empty" },
        el("p", {}, br ? "Nessuna segnalazione. Inquadra il punto da segnalare, seleziona gli elementi interessati (ed eventualmente una sezione) e premi Nuova." : "Il file non contiene segnalazioni."),
        el("p", { class: "note" }, "Le segnalazioni si salvano in formato BCF (.bcfzip), leggibile da Revit, Navisworks, Solibri, BIMcollab, Archicad, Tekla e dagli altri programmi BIM.")));
      return;
    }
    if (!list.length) { body.append(el("p", { class: "bcf-empty note" }, "Nessuna segnalazione corrisponde ai filtri.")); return; }
    for (const t of list) {
      const i = S.store.topics.indexOf(t);
      const snap = t.viewpoints.find(v => v.snapshot)?.snapshot;
      const card = el("div", { class: "bcf-card" + (S.lastOpened === t ? " sel" : ""), tabindex: "0" },
        el("div", { class: "bcf-thumb" }, snap ? el("img", { src: urlOf(snap), alt: "" }) : el("span", {}, "nessuna immagine")),
        el("div", { class: "bcf-cbody" },
          el("div", { class: "bcf-ctitle" }, el("span", { class: "bcf-num" }, String(i + 1)), t.title || "Senza titolo"),
          el("div", { class: "bcf-meta" }, pill(t.status), t.priority ? el("span", { class: "bcf-prio p-" + prioTone(t.priority) }, tr("priority", t.priority)) : null, el("span", {}, tr("type", t.type))),
          el("div", { class: "bcf-meta" }, t.assignedTo ? el("span", {}, "→ " + t.assignedTo) : null,
            t.dueDate ? el("span", { class: isOverdue(t) ? "bcf-late" : "" }, "entro " + dateIt(t.dueDate)) : null,
            t.comments.length ? el("span", {}, `${t.comments.length} comment${t.comments.length === 1 ? "o" : "i"}`) : null)));
      card.addEventListener("click", () => openTopic(t));
      card.addEventListener("keydown", e => { if (e.key === "Enter") openTopic(t); });
      body.append(card);
    }
  }
  const pill = s => (s ? el("span", { class: "bcf-pill t-" + statusTone(s) }, tr("status", s)) : null);
  const prioTone = p => ({ Critical: "c", High: "h", Major: "h" })[p] || "n";

  async function openTopic(t, vpIndex = 0) {
    S.current = t;
    S.lastOpened = t;
    S.vpIndex = Math.min(vpIndex, Math.max(0, t.viewpoints.length - 1));
    renderFilters();
    renderTopic();
    const v = t.viewpoints[S.vpIndex];
    if (v) await showViewpoint(v);
  }
  async function showViewpoint(v) {
    opt.onPreview?.(v);
    if (!br || !v.vi) return;
    try {
      const r = await br.apply(v.vi);
      if (r && r.wanted && r.found === 0) toast("Gli elementi indicati nel punto di vista non sono in questo modello (GUID diversi): ripristinata solo la camera", true, 5000);
    } catch (e) { console.error(e); toast("Punto di vista non ripristinato: " + e.message, true); }
  }

  // ---------------------------------------------------------------- scheda
  function choices(kind, extKey, cur) {
    const vals = [...new Set([...(S.store.extensions?.[extKey] || []), ...DEFAULTS[extKey], cur].filter(Boolean))];
    return vals.map(v => el("option", { value: v, selected: v === cur }, IT[kind][v] ? `${IT[kind][v]} (${v})` : v));
  }
  function renderTopic() {
    const t = S.current;
    body.innerHTML = "";
    const field = (label, input) => el("label", { class: "bcf-field" }, el("span", {}, label), input);
    const bind = (input, key, conv = v => v) => { input.addEventListener("change", () => { t[key] = conv(input.value); touch(t); if (key === "title") renderHead(); }); return input; };
    const title = bind(el("input", { type: "text", value: t.title, placeholder: "Titolo della segnalazione" }), "title");
    const desc = bind(el("textarea", { rows: 4, placeholder: "Descrizione del problema" }, t.description), "description");
    const type = bind(el("select", {}, ...choices("type", "types", t.type)), "type");
    const status = bind(el("select", {}, ...choices("status", "statuses", t.status)), "status");
    const prio = bind(el("select", {}, el("option", { value: "" }, "—"), ...choices("priority", "priorities", t.priority)), "priority");
    const users = [...new Set([...(S.store.extensions?.users || []), ...S.store.topics.flatMap(x => [x.assignedTo, x.creationAuthor])].filter(Boolean))];
    const dl = el("datalist", { id: "bcf-users-" + (S.dlId ??= uuid().slice(0, 8)) }, ...users.map(u => el("option", { value: u })));
    const assigned = bind(el("input", { type: "text", value: t.assignedTo, list: dl.id, placeholder: "nome o email" }), "assignedTo");
    const due = bind(el("input", { type: "date", value: t.dueDate ? t.dueDate.slice(0, 10) : "" }), "dueDate", v => (v ? v + "T00:00:00Z" : ""));
    const stage = bind(el("input", { type: "text", value: t.stage, placeholder: "es. Progetto esecutivo" }), "stage");
    const labels = bind(el("input", { type: "text", value: t.labels.join(", "), placeholder: "separate da virgole" }), "labels", v => v.split(",").map(s => s.trim()).filter(Boolean));
    const i = S.store.topics.indexOf(t);
    body.append(
      el("div", { class: "bcf-nav" },
        el("button", { class: "btn", html: ICON.back + "Elenco", onclick: () => { S.current = null; renderFilters(); renderList(); } }),
        el("span", { style: { flex: 1 } }),
        el("button", { class: "btn icon", title: "Segnalazione precedente", disabled: i <= 0, onclick: () => openTopic(S.store.topics[i - 1]) }, "‹"),
        el("span", { class: "note" }, `${i + 1} di ${S.store.topics.length}`),
        el("button", { class: "btn icon", title: "Segnalazione successiva", disabled: i >= S.store.topics.length - 1, onclick: () => openTopic(S.store.topics[i + 1]) }, "›")),
      title, dl,
      el("div", { class: "bcf-grid" }, field("Tipo", type), field("Stato", status), field("Priorita'", prio), field("Scadenza", due), field("Assegnato a", assigned), field("Fase", stage)),
      field("Etichette", labels), field("Descrizione", desc),
      el("div", { class: "bcf-info note" }, `Creata ${dateIt(t.creationDate, true)}${t.creationAuthor ? " da " + t.creationAuthor : ""}`
        + (t.modifiedDate ? ` · modificata ${dateIt(t.modifiedDate, true)}${t.modifiedAuthor ? " da " + t.modifiedAuthor : ""}` : "")),
      renderViewpoints(t), renderComments(t),
      el("div", { class: "bcf-foot" }, el("button", { class: "btn danger", onclick: () => removeTopic(t) }, "Elimina segnalazione")));
    if (!t.title) setTimeout(() => title.focus(), 0);
  }

  function renderViewpoints(t) {
    const box = el("div", { class: "bcf-sec" }, el("div", { class: "bcf-sech" }, el("b", {}, `Punti di vista (${t.viewpoints.length})`), el("span", { style: { flex: 1 } }),
      br ? el("button", { class: "btn", title: "Sostituisce il punto di vista mostrato con la vista attuale", disabled: !t.viewpoints.length, onclick: () => updateViewpoint(t) }, "Aggiorna") : null,
      br ? el("button", { class: "btn", title: "Aggiunge la vista attuale come nuovo punto di vista", html: ICON.cam + "Aggiungi", onclick: () => addViewpoint(t) }) : null));
    const strip = el("div", { class: "bcf-vps" });
    t.viewpoints.forEach((v, k) => {
      const sel = v.vi?.selection?.length || 0;
      const item = el("div", { class: "bcf-vp" + (k === S.vpIndex ? " sel" : ""), title: "Mostra questo punto di vista" + (sel ? ` · ${sel} elementi selezionati` : "") + (v.vi?.planes?.length ? " · con sezione" : "") },
        v.snapshot ? el("img", { src: urlOf(v.snapshot), alt: "" }) : el("span", {}, "vista " + (k + 1)),
        el("button", { class: "bcf-vpdel", title: "Elimina questo punto di vista", html: ICON.close, onclick: async e => {
          e.stopPropagation();
          if (!(await confirmBox("Elimina punto di vista", "Eliminare il punto di vista e la sua istantanea?", "Elimina", true))) return;
          t.viewpoints.splice(k, 1);
          t.comments.forEach(c => { if (c.viewpoint === v.guid) c.viewpoint = ""; });
          S.vpIndex = 0;
          touch(t);
          renderTopic();
        } }));
      item.addEventListener("click", () => { S.vpIndex = k; strip.querySelectorAll(".bcf-vp").forEach((x, j) => x.classList.toggle("sel", j === k)); showViewpoint(v); });
      strip.append(item);
    });
    if (!t.viewpoints.length) strip.append(el("p", { class: "note" }, br ? "Nessun punto di vista: usa Aggiungi per salvare la vista attuale." : "Nessun punto di vista."));
    box.append(strip);
    return box;
  }
  async function captureViewpoint() {
    const vi = br.capture();
    const snapshot = await br.snapshot();
    return { guid: uuid(), vi, snapshot };
  }
  async function addViewpoint(t) {
    t.viewpoints.push(await captureViewpoint());
    S.vpIndex = t.viewpoints.length - 1;
    touch(t);
    renderTopic();
  }
  async function updateViewpoint(t) {
    const old = t.viewpoints[S.vpIndex];
    if (!old) return;
    const nv = await captureViewpoint();
    old.vi = nv.vi;
    old.snapshot = nv.snapshot;
    touch(t);
    renderTopic();
    toast("Punto di vista aggiornato");
  }

  function renderComments(t) {
    const box = el("div", { class: "bcf-sec" }, el("div", { class: "bcf-sech" }, el("b", {}, `Commenti (${t.comments.length})`)));
    for (const c of t.comments) {
      const vk = c.viewpoint ? t.viewpoints.findIndex(v => v.guid === c.viewpoint) : -1;
      const edit = el("button", { class: "bcf-link", title: "Modifica il testo", onclick: async () => {
        const v = await modalText("Modifica commento", c.text);
        if (v === null) return;
        c.text = v;
        c.modifiedDate = nowIso();
        c.modifiedAuthor = await author();
        touch(t);
        renderTopic();
      } }, "modifica");
      const del = el("button", { class: "bcf-link", onclick: async () => {
        if (!(await confirmBox("Elimina commento", "Eliminare il commento?", "Elimina", true))) return;
        t.comments.splice(t.comments.indexOf(c), 1);
        touch(t);
        renderTopic();
      } }, "elimina");
      box.append(el("div", { class: "bcf-comment" },
        el("div", { class: "bcf-chead" }, el("b", {}, c.author || "—"), el("span", { class: "note" }, dateIt(c.date, true) + (c.modifiedDate ? " (modificato)" : "")),
          el("span", { style: { flex: 1 } }), vk >= 0 ? el("button", { class: "bcf-link", html: ICON.cam + "vista", title: "Mostra il punto di vista del commento", onclick: () => { S.vpIndex = vk; renderTopic(); showViewpoint(t.viewpoints[vk]); } }) : null, edit, del),
        el("div", { class: "bcf-ctext" }, c.text)));
    }
    const ta = el("textarea", { rows: 2, placeholder: "Scrivi un commento..." });
    const withVp = el("input", { type: "checkbox" });
    box.append(el("div", { class: "bcf-addc" }, ta, el("div", { class: "bcf-frow" },
      br ? el("label", { class: "bcf-chk", title: "Salva la vista attuale come nuovo punto di vista collegato al commento" }, withVp, "Allega la vista attuale") : null,
      el("span", { style: { flex: 1 } }),
      el("button", { class: "btn primary", onclick: async () => {
        const text = ta.value.trim();
        if (!text) return;
        const c = { guid: uuid(), date: nowIso(), author: await author(), text, viewpoint: "" };
        if (withVp.checked) { const v = await captureViewpoint(); t.viewpoints.push(v); c.viewpoint = v.guid; }
        t.comments.push(c);
        touch(t);
        renderTopic();
      } }, "Aggiungi commento"))));
    return box;
  }
  async function modalText(title, value) {
    const ta = el("textarea", { rows: 6, style: { width: "min(520px, 80vw)" } }, value);
    return modal(title, ta, [{ label: "Annulla", value: null }, { label: "OK", primary: true, value: () => ta.value }]);
  }

  // ---------------------------------------------------------------- azioni
  async function createTopic() {
    const who = await author();
    const t = newTopic(who);
    t.files = br.modelFiles();
    t.viewpoints.push(await captureViewpoint());
    S.store.topics.push(t);
    setDirty();
    S.current = t;
    S.lastOpened = t;
    S.vpIndex = 0;
    renderFilters();
    renderTopic();
  }
  async function removeTopic(t) {
    if (!(await confirmBox("Elimina segnalazione", `Eliminare "${t.title || "Senza titolo"}" con i suoi commenti e punti di vista?`, "Elimina", true))) return;
    S.store.topics.splice(S.store.topics.indexOf(t), 1);
    S.current = null;
    setDirty();
    renderFilters();
    renderList();
  }

  async function openBcf() {
    const ps = await pickFiles();
    const p = ps?.[0];
    if (!p) return;
    let store;
    try { store = await readBcf(await readBytes(p)); } catch (e) { return toast(baseName(p) + ": " + e.message, true, 6000); }
    if (S.store.topics.length) {
      const how = await modal("Apri BCF", el("p", {}, `Ci sono gia' ${S.store.topics.length} segnalazioni. Le ${store.topics.length} segnalazioni di "${baseName(p)}" si aggiungono a queste o le sostituiscono?`),
        [{ label: "Annulla", value: null }, { label: "Sostituisci", value: "replace" }, { label: "Aggiungi", value: "add", primary: true }]);
      if (!how) return;
      if (how === "add") {
        const have = new Set(S.store.topics.map(t => t.guid));
        let n = 0;
        for (const t of store.topics) { if (have.has(t.guid)) continue; S.store.topics.push(t); n++; }
        setDirty();
        toast(`Aggiunte ${n} segnalazioni` + (n < store.topics.length ? ` (${store.topics.length - n} erano gia' presenti)` : ""));
        return refresh();
      }
    }
    setStore(store, p);
    checkModel();
    toast(`${store.topics.length} segnalazioni da ${baseName(p)} (BCF ${store.version})`);
  }
  // le segnalazioni fanno riferimento a un altro modello? (si confronta il GUID del progetto IFC)
  function checkModel() {
    if (!br?.isIfc()) return;
    const mine = new Set(br.modelFiles().map(f => f.ifcProject).filter(Boolean));
    const theirs = new Set(S.store.topics.flatMap(t => t.files.map(f => f.ifcProject)).filter(Boolean));
    if (mine.size && theirs.size && ![...theirs].some(g => mine.has(g))) toast("Attenzione: le segnalazioni sono state create su un altro progetto IFC (GUID del progetto diverso); camera e sezioni restano valide se le coordinate coincidono", true, 7000);
  }

  async function save(asNew) {
    const st = S.store;
    let target = S.path, version = st.version?.startsWith("3") ? "3.0" : "2.1";
    if (asNew || !target) {
      const v = await modal("Salva segnalazioni BCF", el("div", {},
        el("p", {}, "Versione del formato BCF:"),
        el("p", { class: "note" }, "2.1 e' letta da tutti i programmi (Revit BCF Manager, Navisworks, Solibri, BIMcollab, Archicad, Tekla). 3.0 e' la versione piu' recente: usala se chi la riceve la supporta.")),
        [{ label: "Annulla", value: null }, { label: "BCF 3.0", value: "3.0" }, { label: "BCF 2.1", value: "2.1", primary: true }]);
      if (!v) return;
      version = v;
      const base = (opt.baseName || "segnalazioni").replace(/\.[^.]+$/, "");
      target = await pickSavePath(S.path ? baseName(S.path).replace(/\.[^.]+$/, ".bcfzip") : base + ".bcfzip", S.path ? dirName(S.path) : opt.dir || "");
      if (!target) return;
    }
    try {
      const blob = await writeBcf(st, version);
      await saveBytes(target, new Uint8Array(await blob.arrayBuffer()));
      st.version = version;
      if (!target.startsWith("download://")) S.path = target;
      toast("Segnalazioni salvate: " + baseName(target));
      setDirty(false);
      if (opt.recoveryKey) recovery.del(opt.recoveryKey);
      opt.onSaved?.(target);
    } catch (e) { toast("Salvataggio non riuscito: " + e.message, true, 6000); }
  }

  async function doReport(kind) {
    const list = visible();
    if (!list.length) return toast("Nessuna segnalazione da mettere nel report", true);
    const sub = { ...S.store, topics: list };
    const model = opt.modelName || "";
    const name = (S.path ? baseName(S.path) : opt.baseName || "segnalazioni").replace(/\.[^.]+$/, "") + " - report";
    try {
      toast("Preparazione del report...", false, 30000);
      const R = await import("./bcfreport.js");
      const blob = kind === "pdf" ? await R.pdfReport(sub, { title: "Report segnalazioni BCF", model }) : await R.excelReport(sub, "Segnalazioni BCF");
      toast("Report pronto", false, 1200);
      await saveBlobAs(`${name}.${kind}`, blob, S.path ? dirName(S.path) : opt.dir || "");
    } catch (e) { console.error(e); toast("Report non riuscito: " + e.message, true, 6000); }
  }

  // ---------------------------------------------------------------- stato
  function setStore(store, path = null, dirty = false) {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
    S.store = store;
    S.path = path;
    S.current = null;
    S.f = { q: "", status: "", type: "", priority: "", assigned: "", overdue: false };
    br?.clearOverlay();
    setDirty(dirty);
    refresh();
  }
  function refresh() { renderHead(); renderFilters(); if (S.current && S.store.topics.includes(S.current)) renderTopic(); else { S.current = null; renderFilters(); renderList(); } }
  refresh();

  return {
    el: root, setStore, refresh, save, openTopic,
    get store() { return S.store; }, get path() { return S.path; }, get dirty() { return S.dirty; },
    dispose() { for (const u of urls.values()) URL.revokeObjectURL(u); clearTimeout(S.recT); },
  };
}

// ---------------------------------------------------------------- pannello nel visualizzatore 3D
// h = scena e funzioni del visualizzatore (model3d.js); onToggle(aperto) aggiorna il pulsante della barra
export function attach3d(h, onToggle) {
  const br = bridge(h);
  const key = "modello:" + h.ctx.path;
  const panel = createPanel({ bridge: br, overlay: true, recoveryKey: key, baseName: h.ctx.name, dir: dirName(h.ctx.path), modelName: h.ctx.name, onClose: () => toggle(false) });
  panel.el.hidden = true;
  h.box.append(panel.el);
  // segnalazioni rimaste non salvate l'ultima volta su questo modello (copia di recupero)
  let pending = recovery.get(key);
  async function offerRecovery() {
    const p = pending;
    pending = null;
    const r = p && (await p);
    if (!r?.store?.topics?.length || panel.store.topics.length) return;
    const ok = await confirmBox("Segnalazioni non salvate", `L'ultima volta su questo modello sono rimaste ${r.store.topics.length} segnalazioni non salvate in un file BCF (${new Date(r.date).toLocaleString("it-IT")}). Recuperarle?`, "Recupera");
    if (ok) panel.setStore(r.store, null, true);
    else recovery.del(key);
  }
  function toggle(v = panel.el.hidden) {
    panel.el.hidden = !v;
    onToggle?.(v);
    if (v && pending) offerRecovery();
    return v;
  }
  return {
    toggle, panel, bridge: br,
    load(store, path) { pending = null; panel.setStore(store, path); toggle(true); },
    dispose() { panel.dispose(); br.clearOverlay(); },
  };
}
