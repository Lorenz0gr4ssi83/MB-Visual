// Pannello delle segnalazioni BCF: elenco con filtri, scheda della segnalazione (campi, punti di vista, commenti), apertura,
// salvataggio in .bcfzip (2.1 o 3.0) e report PDF/Excel. Si usa nel visualizzatore 3D (con il ponte di ui/js/bcfview.js:
// crea punti di vista e li ripristina) e da solo per i file .bcfzip aperti senza modello (ui/js/viewers/bcf.js).
import { askText, baseName, confirmBox, dirName, el, loadCss, modal, pickFiles, pickSavePath, readBytes, saveBlobAs, saveBytes, toast } from "./core.js";
import { bridge } from "./bcfview.js";
import { DEFAULTS, dateIt, hasLbl, isOverdue, newStore, newTopic, nowIso, readBcf, statusTone, lbl, uuid, writeBcf } from "./bcf.js";
import { LOCALE, t as tr } from "./i18n.js";

const AUTHOR_KEY = "mbv-bcf-autore";
function storedAuthor() { try { return localStorage.getItem(AUTHOR_KEY) || ""; } catch { return ""; } }
export async function author(force = false) {
  let a = storedAuthor();
  if (!a || force) {
    const v = await askText(tr("bcfpanel.autore_segnalazioni"), tr("bcfpanel.nome_email_cui_firmare_segnalazioni"), a);
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
    const title = el("div", { class: "bcf-title" }, el("b", {}, tr("bcfpanel.segnalazioni_bcf")), el("span", { class: "bcf-count" }, String(n)),
      S.dirty ? el("span", { class: "bcf-unsaved", title: tr("bcfpanel.modifiche_non_salvate_file_bcf") }, tr("bcfpanel.non_salvate")) : null,
      el("span", { style: { flex: 1 } }),
      opt.onClose ? el("button", { class: "bcf-x", title: tr("bcfpanel.chiudi_pannello"), html: ICON.close, onclick: () => opt.onClose() }) : null);
    const report = el("select", { title: tr("bcfpanel.report_segnalazioni_quelle_filtrate"), onchange: e => { const v = e.target.value; e.target.value = ""; if (v) doReport(v); } },
      el("option", { value: "" }, tr("bcfpanel.report")), el("option", { value: "pdf" }, tr("bcfpanel.report_pdf")), el("option", { value: "xlsx" }, tr("bcfpanel.report_excel")));
    const row = el("div", { class: "bcf-actions" },
      br ? el("button", { class: "btn primary", onclick: createTopic, title: tr("bcfpanel.nuova_segnalazione_punto_vista_attuale"), html: ICON.plus + tr("bcfpanel.nuova") }) : null,
      el("button", { class: "btn", onclick: openBcf, title: br ? tr("bcfpanel.apri_file_bcf_sovrapponi_segnalazioni") : tr("bcfpanel.apri_altro_file_bcf") }, tr("bcfpanel.apri_bcf")),
      el("button", { class: "btn", onclick: () => save(false), title: S.path ? tr("bcfpanel.salva_0", baseName(S.path)) : tr("bcfpanel.salva_file_bcfzip") }, tr("common.salva")),
      el("button", { class: "btn", onclick: () => save(true), title: tr("bcfpanel.salva_nuovo_file_bcf_2") }, tr("bcfpanel.salva_nome")),
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
    const opts = (kind, key) => [...new Set(T.map(t => t[key]).filter(Boolean))].sort().map(v => el("option", { value: v, selected: S.f[kind] === v }, kind === "assigned" ? v : lbl(kind, v)));
    const sel = (kind, key, label) => el("select", { onchange: e => { S.f[kind] = e.target.value; renderList(); } }, el("option", { value: "" }, label), ...opts(kind, key));
    const q = el("input", { type: "search", placeholder: tr("bcfpanel.cerca_titolo_descrizione_commenti"), value: S.f.q });
    q.addEventListener("input", () => { S.f.q = q.value; renderList(); });
    const od = el("input", { type: "checkbox", checked: S.f.overdue });
    od.addEventListener("change", () => { S.f.overdue = od.checked; renderList(); });
    filters.append(q, el("div", { class: "bcf-frow" }, sel("status", "status", tr("bcfpanel.tutti_stati")), sel("type", "type", tr("bcfpanel.tutti_i_tipi")), sel("priority", "priority", tr("bcfpanel.ogni_priorita")),
      sel("assigned", "assignedTo", tr("bcfpanel.tutti_assegnatari")), el("label", { class: "bcf-chk" }, od, tr("bcfpanel.scadute"))));
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
        el("p", {}, br ? tr("bcfpanel.nessuna_segnalazione_inquadra_punto_segnalare") : tr("bcfpanel.file_non_contiene_segnalazioni")),
        el("p", { class: "note" }, tr("bcfpanel.segnalazioni_si_salvano_formato_bcf"))));
      return;
    }
    if (!list.length) { body.append(el("p", { class: "bcf-empty note" }, tr("bcfpanel.nessuna_segnalazione_corrisponde_filtri"))); return; }
    for (const t of list) {
      const i = S.store.topics.indexOf(t);
      const snap = t.viewpoints.find(v => v.snapshot)?.snapshot;
      const card = el("div", { class: "bcf-card" + (S.lastOpened === t ? " sel" : ""), tabindex: "0" },
        el("div", { class: "bcf-thumb" }, snap ? el("img", { src: urlOf(snap), alt: "" }) : el("span", {}, tr("bcfpanel.nessuna_immagine"))),
        el("div", { class: "bcf-cbody" },
          el("div", { class: "bcf-ctitle" }, el("span", { class: "bcf-num" }, String(i + 1)), t.title || tr("bcfpanel.senza_titolo")),
          el("div", { class: "bcf-meta" }, pill(t.status), t.priority ? el("span", { class: "bcf-prio p-" + prioTone(t.priority) }, lbl("priority", t.priority)) : null, el("span", {}, lbl("type", t.type))),
          el("div", { class: "bcf-meta" }, t.assignedTo ? el("span", {}, "→ " + t.assignedTo) : null,
            t.dueDate ? el("span", { class: isOverdue(t) ? "bcf-late" : "" }, "entro " + dateIt(t.dueDate)) : null,
            t.comments.length ? el("span", {}, `${t.comments.length} comment${t.comments.length === 1 ? "o" : "i"}`) : null)));
      card.addEventListener("click", () => openTopic(t));
      card.addEventListener("keydown", e => { if (e.key === "Enter") openTopic(t); });
      body.append(card);
    }
  }
  const pill = s => (s ? el("span", { class: "bcf-pill t-" + statusTone(s) }, lbl("status", s)) : null);
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
      if (r && r.wanted && r.found === 0) toast(tr("bcfpanel.elementi_indicati_punto_vista_non"), true, 5000);
    } catch (e) { console.error(e); toast(tr("bcfpanel.punto_vista_non_ripristinato_0", e.message), true); }
  }

  // ---------------------------------------------------------------- scheda
  function choices(kind, extKey, cur) {
    const vals = [...new Set([...(S.store.extensions?.[extKey] || []), ...DEFAULTS[extKey], cur].filter(Boolean))];
    return vals.map(v => el("option", { value: v, selected: v === cur }, hasLbl(kind, v) && lbl(kind, v) !== v ? `${lbl(kind, v)} (${v})` : lbl(kind, v)));
  }
  function renderTopic() {
    const t = S.current;
    body.innerHTML = "";
    const field = (label, input) => el("label", { class: "bcf-field" }, el("span", {}, label), input);
    const bind = (input, key, conv = v => v) => { input.addEventListener("change", () => { t[key] = conv(input.value); touch(t); if (key === "title") renderHead(); }); return input; };
    const title = bind(el("input", { type: "text", value: t.title, placeholder: tr("bcfpanel.titolo_segnalazione") }), "title");
    const desc = bind(el("textarea", { rows: 4, placeholder: tr("bcfpanel.descrizione_problema") }, t.description), "description");
    const type = bind(el("select", {}, ...choices("type", "types", t.type)), "type");
    const status = bind(el("select", {}, ...choices("status", "statuses", t.status)), "status");
    const prio = bind(el("select", {}, el("option", { value: "" }, "—"), ...choices("priority", "priorities", t.priority)), "priority");
    const users = [...new Set([...(S.store.extensions?.users || []), ...S.store.topics.flatMap(x => [x.assignedTo, x.creationAuthor])].filter(Boolean))];
    const dl = el("datalist", { id: "bcf-users-" + (S.dlId ??= uuid().slice(0, 8)) }, ...users.map(u => el("option", { value: u })));
    const assigned = bind(el("input", { type: "text", value: t.assignedTo, list: dl.id, placeholder: tr("bcfpanel.nome_email") }), "assignedTo");
    const due = bind(el("input", { type: "date", value: t.dueDate ? t.dueDate.slice(0, 10) : "" }), "dueDate", v => (v ? v + "T00:00:00Z" : ""));
    const stage = bind(el("input", { type: "text", value: t.stage, placeholder: tr("bcfpanel.es_progetto_esecutivo") }), "stage");
    const labels = bind(el("input", { type: "text", value: t.labels.join(", "), placeholder: tr("bcfpanel.separate_virgole") }), "labels", v => v.split(",").map(s => s.trim()).filter(Boolean));
    const i = S.store.topics.indexOf(t);
    body.append(
      el("div", { class: "bcf-nav" },
        el("button", { class: "btn", html: ICON.back + tr("bcfpanel.elenco"), onclick: () => { S.current = null; renderFilters(); renderList(); } }),
        el("span", { style: { flex: 1 } }),
        el("button", { class: "btn icon", title: tr("bcfpanel.segnalazione_precedente"), disabled: i <= 0, onclick: () => openTopic(S.store.topics[i - 1]) }, "‹"),
        el("span", { class: "note" }, tr("bcfpanel.n_di_m", i + 1, S.store.topics.length)),
        el("button", { class: "btn icon", title: tr("bcfpanel.segnalazione_successiva"), disabled: i >= S.store.topics.length - 1, onclick: () => openTopic(S.store.topics[i + 1]) }, "›")),
      title, dl,
      el("div", { class: "bcf-grid" }, field(tr("bcfpanel.tipo"), type), field(tr("bcfpanel.stato"), status), field(tr("bcfpanel.priorita"), prio), field(tr("bcfpanel.scadenza"), due), field(tr("bcfpanel.assegnato"), assigned), field(tr("bcfpanel.fase"), stage)),
      field(tr("bcfpanel.etichette"), labels), field(tr("bcfpanel.descrizione"), desc),
      el("div", { class: "bcf-info note" }, [t.creationAuthor ? tr("bcfpanel.creata_0_1", dateIt(t.creationDate, true), t.creationAuthor) : tr("bcfpanel.creata_0", dateIt(t.creationDate, true)),
        t.modifiedDate ? (t.modifiedAuthor ? tr("bcfpanel.modificata_0_1", dateIt(t.modifiedDate, true), t.modifiedAuthor) : tr("bcfpanel.modificata_0", dateIt(t.modifiedDate, true))) : ""].filter(Boolean).join(" · ")),
      renderViewpoints(t), renderComments(t),
      el("div", { class: "bcf-foot" }, el("button", { class: "btn danger", onclick: () => removeTopic(t) }, tr("bcfpanel.elimina_segnalazione"))));
    if (!t.title) setTimeout(() => title.focus(), 0);
  }

  function renderViewpoints(t) {
    const box = el("div", { class: "bcf-sec" }, el("div", { class: "bcf-sech" }, el("b", {}, tr("bcfpanel.punti_vista_0", t.viewpoints.length)), el("span", { style: { flex: 1 } }),
      br ? el("button", { class: "btn", title: tr("bcfpanel.sostituisce_punto_vista_mostrato_vista"), disabled: !t.viewpoints.length, onclick: () => updateViewpoint(t) }, tr("bcfpanel.aggiorna")) : null,
      br ? el("button", { class: "btn", title: tr("bcfpanel.aggiunge_vista_attuale_come_nuovo"), html: ICON.cam + tr("common.aggiungi"), onclick: () => addViewpoint(t) }) : null));
    const strip = el("div", { class: "bcf-vps" });
    t.viewpoints.forEach((v, k) => {
      const sel = v.vi?.selection?.length || 0;
      const item = el("div", { class: "bcf-vp" + (k === S.vpIndex ? " sel" : ""), title: [tr("bcfpanel.mostra_questo_punto_vista"), sel ? tr("bcfpanel.0_elementi_selezionati", sel) : "", v.vi?.planes?.length ? tr("bcfpanel.sezione") : ""].filter(Boolean).join(" · ") },
        v.snapshot ? el("img", { src: urlOf(v.snapshot), alt: "" }) : el("span", {}, "vista " + (k + 1)),
        el("button", { class: "bcf-vpdel", title: tr("bcfpanel.elimina_questo_punto_vista"), html: ICON.close, onclick: async e => {
          e.stopPropagation();
          if (!(await confirmBox(tr("bcfpanel.elimina_punto_vista"), tr("bcfpanel.eliminare_punto_vista_sua_istantanea"), tr("common.elimina"), true))) return;
          t.viewpoints.splice(k, 1);
          t.comments.forEach(c => { if (c.viewpoint === v.guid) c.viewpoint = ""; });
          S.vpIndex = 0;
          touch(t);
          renderTopic();
        } }));
      item.addEventListener("click", () => { S.vpIndex = k; strip.querySelectorAll(".bcf-vp").forEach((x, j) => x.classList.toggle("sel", j === k)); showViewpoint(v); });
      strip.append(item);
    });
    if (!t.viewpoints.length) strip.append(el("p", { class: "note" }, br ? tr("bcfpanel.nessun_punto_vista_usa_aggiungi") : tr("bcfpanel.nessun_punto_vista")));
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
    toast(tr("bcfpanel.punto_vista_aggiornato"));
  }

  function renderComments(t) {
    const box = el("div", { class: "bcf-sec" }, el("div", { class: "bcf-sech" }, el("b", {}, tr("bcfpanel.commenti_0", t.comments.length))));
    for (const c of t.comments) {
      const vk = c.viewpoint ? t.viewpoints.findIndex(v => v.guid === c.viewpoint) : -1;
      const edit = el("button", { class: "bcf-link", title: tr("bcfpanel.modifica_testo"), onclick: async () => {
        const v = await modalText(tr("bcfpanel.modifica_commento"), c.text);
        if (v === null) return;
        c.text = v;
        c.modifiedDate = nowIso();
        c.modifiedAuthor = await author();
        touch(t);
        renderTopic();
      } }, "modifica");
      const del = el("button", { class: "bcf-link", onclick: async () => {
        if (!(await confirmBox(tr("bcfpanel.elimina_commento"), tr("bcfpanel.eliminare_commento"), tr("common.elimina"), true))) return;
        t.comments.splice(t.comments.indexOf(c), 1);
        touch(t);
        renderTopic();
      } }, "elimina");
      box.append(el("div", { class: "bcf-comment" },
        el("div", { class: "bcf-chead" }, el("b", {}, c.author || "—"), el("span", { class: "note" }, dateIt(c.date, true) + (c.modifiedDate ? tr("bcfpanel.modificato") : "")),
          el("span", { style: { flex: 1 } }), vk >= 0 ? el("button", { class: "bcf-link", html: ICON.cam + "vista", title: tr("bcfpanel.mostra_punto_vista_commento"), onclick: () => { S.vpIndex = vk; renderTopic(); showViewpoint(t.viewpoints[vk]); } }) : null, edit, del),
        el("div", { class: "bcf-ctext" }, c.text)));
    }
    const ta = el("textarea", { rows: 2, placeholder: tr("bcfpanel.scrivi_commento") });
    const withVp = el("input", { type: "checkbox" });
    box.append(el("div", { class: "bcf-addc" }, ta, el("div", { class: "bcf-frow" },
      br ? el("label", { class: "bcf-chk", title: tr("bcfpanel.salva_vista_attuale_come_nuovo") }, withVp, tr("bcfpanel.allega_vista_attuale")) : null,
      el("span", { style: { flex: 1 } }),
      el("button", { class: "btn primary", onclick: async () => {
        const text = ta.value.trim();
        if (!text) return;
        const c = { guid: uuid(), date: nowIso(), author: await author(), text, viewpoint: "" };
        if (withVp.checked) { const v = await captureViewpoint(); t.viewpoints.push(v); c.viewpoint = v.guid; }
        t.comments.push(c);
        touch(t);
        renderTopic();
      } }, tr("bcfpanel.aggiungi_commento")))));
    return box;
  }
  async function modalText(title, value) {
    const ta = el("textarea", { rows: 6, style: { width: "min(520px, 80vw)" } }, value);
    return modal(title, ta, [{ label: tr("common.annulla"), value: null }, { label: "OK", primary: true, value: () => ta.value }]);
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
    if (!(await confirmBox(tr("bcfpanel.elimina_segnalazione"), tr("bcfpanel.eliminare_0_i_suoi_commenti", t.title || tr("bcfpanel.senza_titolo")), tr("common.elimina"), true))) return;
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
      const how = await modal(tr("bcfpanel.apri_bcf"), el("p", {}, tr("bcfpanel.ci_sono_gia_0_segnalazioni", S.store.topics.length, store.topics.length, baseName(p))),
        [{ label: tr("common.annulla"), value: null }, { label: tr("bcfpanel.sostituisci"), value: "replace" }, { label: tr("common.aggiungi"), value: "add", primary: true }]);
      if (!how) return;
      if (how === "add") {
        const have = new Set(S.store.topics.map(t => t.guid));
        let n = 0;
        for (const t of store.topics) { if (have.has(t.guid)) continue; S.store.topics.push(t); n++; }
        setDirty();
        toast(n < store.topics.length ? tr("bcfpanel.aggiunte_0_segnalazioni_1_erano", n, store.topics.length - n) : tr("bcfpanel.aggiunte_0_segnalazioni", n));
        return refresh();
      }
    }
    setStore(store, p);
    checkModel();
    toast(tr("bcfpanel.0_segnalazioni_1_bcf_2", store.topics.length, baseName(p), store.version));
  }
  // le segnalazioni fanno riferimento a un altro modello? (si confronta il GUID del progetto IFC)
  function checkModel() {
    if (!br?.isIfc()) return;
    const mine = new Set(br.modelFiles().map(f => f.ifcProject).filter(Boolean));
    const theirs = new Set(S.store.topics.flatMap(t => t.files.map(f => f.ifcProject)).filter(Boolean));
    if (mine.size && theirs.size && ![...theirs].some(g => mine.has(g))) toast(tr("bcfpanel.attenzione_segnalazioni_sono_state_create"), true, 7000);
  }

  async function save(asNew) {
    const st = S.store;
    let target = S.path, version = st.version?.startsWith("3") ? "3.0" : "2.1";
    if (asNew || !target) {
      const v = await modal(tr("bcfpanel.salva_segnalazioni_bcf"), el("div", {},
        el("p", {}, tr("bcfpanel.versione_formato_bcf")),
        el("p", { class: "note" }, tr("bcfpanel.2_1_letta_tutti_i"))),
        [{ label: tr("common.annulla"), value: null }, { label: "BCF 3.0", value: "3.0" }, { label: "BCF 2.1", value: "2.1", primary: true }]);
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
      toast(tr("bcfpanel.segnalazioni_salvate_0", baseName(target)));
      setDirty(false);
      if (opt.recoveryKey) recovery.del(opt.recoveryKey);
      opt.onSaved?.(target);
    } catch (e) { toast(tr("bcfpanel.salvataggio_non_riuscito_0", e.message), true, 6000); }
  }

  async function doReport(kind) {
    const list = visible();
    if (!list.length) return toast(tr("bcfpanel.nessuna_segnalazione_mettere_report"), true);
    const sub = { ...S.store, topics: list };
    const model = opt.modelName || "";
    const name = (S.path ? baseName(S.path) : opt.baseName || "segnalazioni").replace(/\.[^.]+$/, "") + " - report";
    try {
      toast(tr("bcfpanel.preparazione_report"), false, 30000);
      const R = await import("./bcfreport.js");
      const blob = kind === "pdf" ? await R.pdfReport(sub, { title: tr("bcfpanel.report_segnalazioni_bcf"), model }) : await R.excelReport(sub, tr("bcfpanel.segnalazioni_bcf"));
      toast(tr("bcfpanel.report_pronto"), false, 1200);
      await saveBlobAs(`${name}.${kind}`, blob, S.path ? dirName(S.path) : opt.dir || "");
    } catch (e) { console.error(e); toast(tr("bcfpanel.report_non_riuscito_0", e.message), true, 6000); }
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
// h = scena e funzioni del visualizzatore (model3d.js); onToggle(aperto) aggiorna il pulsante della barra;
// shared = ponte gia' creato dal visualizzatore (lo usano anche le viste salvate di ui/js/navmanage.js)
export function attach3d(h, onToggle, shared) {
  const br = shared || bridge(h);
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
    const ok = await confirmBox(tr("bcfpanel.segnalazioni_non_salvate"), tr("bcfpanel.l_ultima_volta_questo_modello", r.store.topics.length, new Date(r.date).toLocaleString(LOCALE)), tr("bcfpanel.recupera"));
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
