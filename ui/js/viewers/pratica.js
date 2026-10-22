// Pratica edilizia (.mbcomm): riepilogo dell'anagrafica di commessa, scelta dei moduli e generazione nella cartella
// "<commessa> - moduli", firma digitale (ui/js/firma.js) e fascicolo PDF unico con indice e segnalibri.
// Motore: mbvisual/edilizia.py (API /api/pratica). Finestra guidata dei dati: ui/js/pratica.js. Solo app per PC.
import { api, baseName, button, dirName, el, fmtSize, loadCss, toast, waitJob, WEB } from "../core.js";
import { fmtDateTime, t as tr, tn } from "../i18n.js";
import { importVisura, openWizard } from "../pratica.js";

const GROUPS = ["titoli", "lavori", "allegati", "relazioni", "firma"];
const IC = {
  data: '<svg viewBox="0 0 24 24"><path d="M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h5"/></svg>',
  visura: '<svg viewBox="0 0 24 24"><path d="M4 20V8l8-4 8 4v12M4 20h16M9 20v-6h6v6"/></svg>',
  gen: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
};

export async function mount(ctx) {
  loadCss("css/pratica.css");
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  if (WEB) {
    ctx.el.append(el("div", { class: "center" }, el("div", { class: "panel" }, tr("pratica.solo_pc"))));
    return {};
  }
  const meta = await api("pratica", { op: "moduli" }, { json: {} });
  let { anagrafica: a, cartella } = await api("pratica", { op: "leggi" }, { json: { path: ctx.path } });
  let files = [];
  const chosen = new Set(JSON.parse(localStorage.getItem("mbv-pratica-moduli") || '["cila","soggetti","procura"]'));
  const order = []; // ordine dei file nel fascicolo (percorsi)
  const excluded = new Set();
  let lastFascicolo = null;

  async function persist() {
    a = (await api("pratica", { op: "scrivi" }, { json: { path: ctx.path, anagrafica: a } })).anagrafica;
    ctx.setDirty(false);
  }
  async function editData(step = 0) {
    const r = await openWizard(a, { regioni: meta.regioni, step });
    if (!r) return;
    a = r;
    try { await persist(); toast(tr("pratica.dati_salvati")); } catch (e) { toast(e.message, true); }
    render();
  }

  // ---- barra
  const regSel = el("select", { class: "field", title: tr("pratica.f_regione") },
    ...meta.regioni.map(r => el("option", { value: r.codice }, r.codice ? r.nome : tr("pratica.nazionale"))));
  regSel.value = a.regione || "";
  regSel.addEventListener("change", async () => { a.regione = regSel.value; await persist(); render(); });
  ctx.tb.append(
    button(tr("pratica.dati_commessa"), IC.data, () => editData()),
    button(tr("pratica.leggi_visura"), IC.visura, async () => { if (await importVisura(a)) { await persist(); render(); } }),
    el("span", { class: "sep" }), el("label", {}, tr("pratica.f_regione"), regSel), el("span", { class: "sep" }),
    button(tr("pratica.genera"), IC.gen, () => generate(), { class: "primary" }),
    button(tr("pratica.fascicolo"), IC.book, () => makeBook()),
    el("span", { class: "grow" }),
    button(tr("pratica.apri_cartella"), IC.folder, () => api("reveal", { path: files[0]?.path || ctx.path }).catch(e => toast(e.message, true))));

  const left = el("div", { class: "pte-col" });
  const right = el("div", { class: "pte-col" });
  ctx.el.append(el("div", { class: "pte-view" }, left, right));

  async function refreshFiles() {
    try { files = (await api("pratica", { op: "file" }, { json: { cartella } })).file || []; } catch { files = []; }
    for (const f of files) if (!order.includes(f.path)) order.push(f.path);
    for (let i = order.length - 1; i >= 0; i--) if (!files.some(f => f.path === order[i])) order.splice(i, 1);
  }

  // ---- riepilogo dell'anagrafica
  function summary() {
    const it = a.intervento, imm = a.immobile;
    const pers = p => [p.cognome, p.nome].filter(Boolean).join(" ") || p.ditta?.ragione || "";
    const missing = [];
    if (!a.comune.nome) missing.push([tr("pratica.manca_comune"), 0]);
    if (!a.committenti.some(pers)) missing.push([tr("pratica.manca_committente"), 1]);
    if (!a.committenti.every(c => !pers(c) || c.cf || c.ditta?.cf_piva)) missing.push([tr("pratica.manca_cf"), 1]);
    if (!imm.foglio || !imm.particella) missing.push([tr("pratica.manca_catasto"), 2]);
    if (!imm.via) missing.push([tr("pratica.manca_indirizzo"), 2]);
    if (!a.tecnici.some(x => x.ruolo === "progettista" && x.cognome)) missing.push([tr("pratica.manca_progettista"), 3]);
    if (!it.descrizione) missing.push([tr("pratica.manca_descrizione"), 5]);
    if (!it.tipologia) missing.push([tr("pratica.manca_tipologia"), 5]);
    const row = (k, v, step) => el("div", { class: "pte-kv", onclick: () => editData(step) }, el("dt", {}, k), el("dd", {}, v || el("span", { class: "pte-empty" }, "-")));
    const reg = meta.regioni.find(r => r.codice === a.regione);
    return el("section", { class: "panel pte-panel" },
      el("div", { class: "pte-panel-h" }, el("h3", {}, a.commessa.nome || baseName(ctx.path).replace(/\.mbcomm$/i, "")),
        a.commessa.codice ? el("span", { class: "pte-code" }, a.commessa.codice) : null, el("span", { class: "grow" }),
        el("button", { class: "btn", onclick: () => editData() }, tr("pratica.modifica"))),
      missing.length ? el("div", { class: "pte-missing" }, el("b", {}, tn("pratica.n_dati_mancanti", missing.length)),
        ...missing.map(([m, s]) => el("button", { class: "link", onclick: () => editData(s) }, m))) : el("div", { class: "pte-ok" }, tr("pratica.dati_completi")),
      el("dl", { class: "pte-dl" },
        row(tr("pratica.sportello_breve"), [a.comune.sportello, a.comune.nome].filter(Boolean).join(" · "), 0),
        row(tr("pratica.passo_committenti"), a.committenti.map(pers).filter(Boolean).join(", "), 1),
        row(tr("pratica.passo_immobile"), [[imm.via, imm.civico].filter(Boolean).join(" "), imm.comune || a.comune.nome].filter(Boolean).join(", "), 2),
        row(tr("pratica.catasto"), [imm.catasto && tr("pratica." + imm.catasto), imm.foglio && `${tr("pratica.f_foglio")} ${imm.foglio}`,
          imm.particella && `${tr("pratica.f_particella")} ${imm.particella}`, imm.subalterno && `${tr("pratica.f_sub")} ${imm.subalterno}`, imm.categoria].filter(Boolean).join(" · "), 2),
        row(tr("pratica.passo_tecnici"), a.tecnici.filter(x => x.cognome).map(x => `${x.cognome} ${x.nome} (${tr("pratica.ruolo_" + x.ruolo)})`).join(", "), 3),
        row(tr("pratica.passo_imprese"), a.imprese.map(x => x.ragione).filter(Boolean).join(", ") || (it.in_economia ? tr("pratica.f_in_economia") : ""), 4),
        row(tr("pratica.f_tipologia"), it.tipologia ? tr("pratica.tip_" + it.tipologia) : "", 5),
        row(tr("pratica.f_descrizione"), it.descrizione, 5),
        row(tr("pratica.f_inizio"), [it.inizio_lavori, it.fine_lavori].filter(Boolean).join(" → "), 5)),
      reg?.codice ? el("p", { class: "pte-warn" }, tr("pratica.regione_propria", reg.nome, reg.atto)) : el("p", { class: "pte-note" }, tr("pratica.regione_nazionale")));
  }

  // ---- moduli
  function modules() {
    const gen = new Map((a.generati || []).map(g => [g.id, g]));
    const box = el("section", { class: "panel pte-panel" }, el("div", { class: "pte-panel-h" }, el("h3", {}, tr("pratica.moduli")), el("span", { class: "grow" }),
      el("button", { class: "link", onclick: () => { meta.moduli.forEach(m => chosen.add(m.id)); render(); } }, tr("pratica.tutti")),
      el("button", { class: "link", onclick: () => { chosen.clear(); render(); } }, tr("pratica.nessuno"))));
    for (const g of GROUPS) {
      const list = meta.moduli.filter(m => m.gruppo === g);
      if (!list.length) continue;
      box.append(el("div", { class: "pte-group" }, tr("pratica.gruppo_" + g)));
      for (const m of list) {
        const cb = el("input", { type: "checkbox", checked: chosen.has(m.id) || undefined });
        cb.addEventListener("change", () => { cb.checked ? chosen.add(m.id) : chosen.delete(m.id); saveChoice(); updateGenBtn(); });
        const g0 = gen.get(m.id);
        box.append(el("div", { class: "pte-mod" + (chosen.has(m.id) ? " on" : "") },
          el("label", { class: "pte-mod-main" }, cb,
            el("span", { class: "pte-kind " + m.tipo }, m.tipo.toUpperCase()),
            el("span", { class: "pte-mod-txt" }, el("b", {}, tr(`pratica.mod_${m.id}`)), el("small", {}, tr(`pratica.mod_${m.id}_d`)), m.fonte ? el("small", { class: "pte-src" }, m.fonte) : null)),
          g0 ? el("div", { class: "pte-mod-gen" }, el("span", {}, tr("pratica.generato_il", fmtDateTime(new Date(g0.data)))),
            el("button", { class: "link", onclick: () => ctx.openFile(g0.path) }, tr("pratica.apri")),
            /\.pdf$/i.test(g0.path) ? el("button", { class: "link", onclick: () => sign(g0.path) }, tr("pratica.firma")) : null) : null));
      }
    }
    const over = el("input", { type: "checkbox", id: "pte-over" });
    genBtn = el("button", { class: "btn primary", onclick: () => generate(over.checked) });
    box.append(el("div", { class: "pte-actions" }, el("label", { class: "pte-check" }, over, el("span", {}, tr("pratica.sovrascrivi"))), el("span", { class: "grow" }), genBtn),
      el("p", { class: "pte-note" }, tr("pratica.dove_generati", cartella)));
    updateGenBtn();
    return box;
  }
  let genBtn = null;
  const updateGenBtn = () => { if (genBtn) { genBtn.textContent = tn("pratica.genera_n", chosen.size); genBtn.disabled = !chosen.size; } };
  const saveChoice = () => { try { localStorage.setItem("mbv-pratica-moduli", JSON.stringify([...chosen])); } catch { /* */ } };

  async function generate(overwrite = false) {
    const ids = meta.moduli.map(m => m.id).filter(id => chosen.has(id));
    if (!ids.length) return toast(tr("pratica.scegli_moduli"), true);
    ctx.status(tr("pratica.generazione"));
    try {
      const { job } = await api("pratica", { op: "genera" }, { json: { path: ctx.path, moduli: ids, sovrascrivi: overwrite } });
      const r = await waitJob(job, (p, m) => ctx.status(`${m || tr("pratica.generazione")} ${Math.round(p * 100)}%`));
      ({ anagrafica: a } = await api("pratica", { op: "leggi" }, { json: { path: ctx.path } }));
      for (const e of r.errori || []) toast(e.errore, true, 8000);
      toast(tn("pratica.n_generati", r.generati.length), false, 4000);
      await refreshFiles();
      render();
      if (r.generati.length === 1) ctx.openFile(r.generati[0].path);
    } catch (e) { toast(e.message, true, 8000); }
    ctx.status("");
  }

  async function sign(path) {
    const f = await import("../firma.js");
    await f.signDialog({ path, openFile: p => ctx.openFile(p) });
    await refreshFiles();
    render();
  }

  // ---- fascicolo
  const titleIn = el("input", { class: "field", value: "" });
  const flat = el("input", { type: "checkbox", checked: true });
  function book() {
    if (!titleIn.value) titleIn.value = [tr("pratica.titolo_fascicolo"), a.commessa.codice].filter(Boolean).join(" ");
    const list = el("div", { class: "pte-files" });
    const byPath = new Map(files.map(f => [f.path, f]));
    order.forEach((p, i) => {
      const f = byPath.get(p);
      if (!f) return;
      const cb = el("input", { type: "checkbox", checked: !excluded.has(p) || undefined });
      cb.addEventListener("change", () => { cb.checked ? excluded.delete(p) : excluded.add(p); });
      list.append(el("div", { class: "pte-file" }, cb, el("span", { class: "pte-kind " + f.nome.split(".").pop().toLowerCase() }, f.nome.split(".").pop().toUpperCase()),
        el("button", { class: "link pte-fname", title: f.path, onclick: () => ctx.openFile(f.path) }, f.nome),
        f.firmato ? el("span", { class: "pte-signed" }, tr("pratica.firmato")) : null,
        el("span", { class: "pte-size" }, fmtSize(f.size)),
        el("button", { class: "btn", title: tr("pratica.sposta_su"), disabled: i === 0 || undefined, onclick: () => { order.splice(i - 1, 0, order.splice(i, 1)[0]); render(); } }, "↑"),
        el("button", { class: "btn", title: tr("pratica.sposta_giu"), disabled: i === order.length - 1 || undefined, onclick: () => { order.splice(i + 1, 0, order.splice(i, 1)[0]); render(); } }, "↓")));
    });
    if (!files.length) list.append(el("p", { class: "pte-note" }, tr("pratica.nessun_file")));
    return el("section", { class: "panel pte-panel" },
      el("div", { class: "pte-panel-h" }, el("h3", {}, tr("pratica.fascicolo")), el("span", { class: "grow" }),
        el("button", { class: "link", onclick: async () => { await refreshFiles(); render(); } }, tr("pratica.aggiorna"))),
      el("p", { class: "pte-note" }, tr("pratica.fascicolo_nota")),
      list,
      el("div", { class: "pte-actions" }, el("label", { class: "pte-f grow" }, el("span", {}, tr("pratica.titolo")), titleIn)),
      el("div", { class: "pte-actions" }, el("label", { class: "pte-check" }, flat, el("span", {}, tr("pratica.appiattisci"))), el("span", { class: "grow" }),
        el("button", { class: "btn primary", disabled: !files.length || undefined, onclick: () => makeBook() }, tr("pratica.crea_fascicolo"))),
      lastFascicolo ? el("div", { class: "pte-result" }, el("b", {}, baseName(lastFascicolo)),
        el("button", { class: "link", onclick: () => ctx.openFile(lastFascicolo) }, tr("pratica.apri")),
        el("button", { class: "link", onclick: () => sign(lastFascicolo) }, tr("pratica.firma_digitalmente"))) : null);
  }

  async function makeBook() {
    await refreshFiles();
    const sel = order.filter(p => !excluded.has(p) && files.some(f => f.path === p));
    if (!sel.length) return toast(tr("pratica.nessun_file"), true);
    if (sel.some(p => /\.p7m$/i.test(p) || files.find(f => f.path === p)?.firmato)) toast(tr("pratica.firme_perse"), false, 7000);
    const stem = baseName(ctx.path).replace(/\.mbcomm$/i, "");
    const out = `${dirName(ctx.path)}\\${stem} - ${tr("pratica.nome_file_fascicolo")}.pdf`;
    ctx.status(tr("pratica.fascicolo_in_corso"));
    try {
      const { job } = await api("pratica", { op: "fascicolo" }, { json: { files: sel, out, titolo: titleIn.value.trim(), anagrafica: a, appiattisci: flat.checked } });
      const r = await waitJob(job, (p, m) => ctx.status(`${m || tr("pratica.fascicolo_in_corso")} ${Math.round(p * 100)}%`));
      lastFascicolo = r.path;
      toast(tr("pratica.fascicolo_creato", r.pagine), false, 4000);
      render();
      ctx.openFile(r.path);
    } catch (e) { toast(e.message, true, 8000); }
    ctx.status("");
  }

  function render() {
    left.innerHTML = "";
    right.innerHTML = "";
    left.append(summary(), book());
    right.append(modules());
    regSel.value = a.regione || "";
  }

  await refreshFiles();
  render();
  // pratica nuova: si parte dai dati della commessa
  if (!a.comune.nome && !a.committenti.some(c => c.cognome || c.cf)) setTimeout(() => editData(), 50);

  return {
    _pt: { get a() { return a; }, generate, makeBook, refreshFiles, editData, files: () => files },
    async save(target) {
      await api("pratica", { op: "scrivi" }, { json: { path: target, anagrafica: a } });
      return {};
    },
    saveFormats: ["mbcomm"],
    noConvert: true,
  };
}
