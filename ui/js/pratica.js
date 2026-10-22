// Pratiche edilizie: finestra guidata dell'anagrafica di commessa (.mbcomm) e lettura della visura catastale.
// Il motore (mbvisual/edilizia.py, API /api/pratica?op=...) genera i moduli; questo file raccoglie i dati una volta sola.
// Struttura dell'anagrafica: `nuova()` in edilizia.py. Solo app per PC.
import { api, el, pickFiles, toast } from "./core.js";
import { t as tr } from "./i18n.js";

// ------------------------------------------------------------------ valori delle tendine (codici usati dai modelli)
export const TIPOLOGIE = ["manutenzione_straordinaria", "manutenzione_straordinaria_strutturale", "restauro", "restauro_strutturale",
  "ristrutturazione", "ristrutturazione_pesante", "nuova_costruzione", "nuova_costruzione_piano_attuativo", "barriere", "pertinenze",
  "geognostiche", "movimenti_terra", "serre", "variante_pdc", "variante_scia", "variante_scia_essenziale", "mutamento_uso", "altro"];
const TIPI_TITOLO = ["pdc", "suap", "autorizzazione", "comunicazione", "dia", "dia_alt", "scia", "cila", "cil", "condono", "pdc_sanatoria",
  "scia_sanatoria", "scia_variante77", "altro"];
const RUOLI = ["progettista", "direttore_lavori", "strutturista", "dl_strutture", "sicurezza", "impianti", "altro"];
const opt = (prefix, list) => list.map(v => [v, tr(prefix + v)]);

// percorso "a.b.c" in un oggetto
const getp = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
function setp(o, p, v) {
  const ks = p.split(".");
  let x = o;
  for (const k of ks.slice(0, -1)) x = x[k] ?? (x[k] = {});
  x[ks[ks.length - 1]] = v;
}

// campo: [percorso, chiave etichetta, tipo, opzioni, larghezza (colonne su 6)]
function input(obj, [path, key, type = "text", options, span = 2], onChange) {
  const v = getp(obj, path);
  let ctl;
  if (type === "check") {
    ctl = el("input", { type: "checkbox", checked: !!v || undefined });
    ctl.addEventListener("change", () => { setp(obj, path, ctl.checked); onChange?.(); });
    return el("label", { class: "pte-check", style: { gridColumn: `span ${span}` } }, ctl, el("span", {}, tr(key)));
  }
  if (type === "select") {
    ctl = el("select", { class: "field" }, ...options.map(([val, lab]) => el("option", { value: val, selected: val === (v ?? "") || undefined }, lab)));
    ctl.addEventListener("change", () => { setp(obj, path, ctl.value); onChange?.(); });
  } else if (type === "textarea") {
    ctl = el("textarea", { class: "field", rows: 4 });
    ctl.value = v ?? "";
    ctl.addEventListener("input", () => { setp(obj, path, ctl.value); onChange?.(); });
  } else {
    ctl = el("input", { class: "field", type: type === "date" ? "date" : "text", value: v ?? "", list: type === "list" ? options : undefined,
      spellcheck: "false", autocomplete: "off" });
    if (type === "upper") ctl.addEventListener("input", () => { ctl.value = ctl.value.toUpperCase(); });
    ctl.addEventListener("input", () => { setp(obj, path, ctl.value.trim()); onChange?.(); });
  }
  return el("label", { class: "pte-f", style: { gridColumn: `span ${span}` } }, el("span", {}, tr(key)), ctl);
}
const grid = (obj, fields, onChange) => el("div", { class: "pte-grid" }, ...fields.map(f => input(obj, f, onChange)));
const sub = text => el("div", { class: "pte-sub" }, text);

// ------------------------------------------------------------------ gruppi di campi
const PERSONA = [
  ["cognome", "pratica.f_cognome", "text", null, 2], ["nome", "pratica.f_nome", "text", null, 2], ["cf", "pratica.f_cf", "upper", null, 2],
  ["nato_a", "pratica.f_nato_a", "text", null, 2], ["nato_prov", "pratica.f_prov", "upper", null, 1], ["nato_il", "pratica.f_nato_il", "date", null, 1],
  ["nato_stato", "pratica.f_stato", "text", null, 2],
  ["res_comune", "pratica.f_res_comune", "text", null, 2], ["res_prov", "pratica.f_prov", "upper", null, 1], ["res_cap", "pratica.f_cap", "text", null, 1],
  ["res_stato", "pratica.f_stato", "text", null, 2],
  ["res_indirizzo", "pratica.f_indirizzo", "text", null, 4], ["res_civico", "pratica.f_civico", "text", null, 2],
  ["pec", "pratica.f_pec", "text", null, 2], ["email", "pratica.f_email", "text", null, 2], ["telefono", "pratica.f_telefono", "text", null, 2],
];
const DITTA = [
  ["ditta.ragione", "pratica.f_ragione", "text", null, 4], ["ditta.cf_piva", "pratica.f_cf_piva", "upper", null, 2],
  ["ditta.qualita", "pratica.f_qualita_ditta", "text", null, 2], ["ditta.cciaa", "pratica.f_cciaa", "text", null, 2],
  ["ditta.cciaa_prov", "pratica.f_prov", "upper", null, 1], ["ditta.cciaa_n", "pratica.f_cciaa_n", "text", null, 1],
  ["ditta.sede_comune", "pratica.f_sede_comune", "text", null, 2], ["ditta.sede_prov", "pratica.f_prov", "upper", null, 1],
  ["ditta.sede_cap", "pratica.f_cap", "text", null, 1], ["ditta.sede_indirizzo", "pratica.f_indirizzo", "text", null, 2],
  ["ditta.pec", "pratica.f_pec", "text", null, 3], ["ditta.telefono", "pratica.f_telefono", "text", null, 3],
];
const STUDIO = [
  ["studio_comune", "pratica.f_studio_comune", "text", null, 2], ["studio_prov", "pratica.f_prov", "upper", null, 1],
  ["studio_cap", "pratica.f_cap", "text", null, 1], ["studio_indirizzo", "pratica.f_indirizzo", "text", null, 2],
  ["studio_civico", "pratica.f_civico", "text", null, 1], ["cellulare", "pratica.f_cellulare", "text", null, 2],
];
const ALBO = [["albo", "pratica.f_albo", "list", "pte-albi", 3], ["albo_prov", "pratica.f_albo_prov", "text", null, 2], ["albo_n", "pratica.f_albo_n", "text", null, 1]];

// ------------------------------------------------------------------ visura catastale
// Legge la visura scelta e unisce i dati: immobile (solo campi vuoti, salvo conferma) e intestati come committenti
export async function importVisura(a, { replace = false } = {}) {
  const ps = await pickFiles();
  if (!ps?.length) return null;
  let r;
  try { r = await api("pratica", { op: "visura" }, { json: { path: ps[0] } }); } catch (e) { toast(e.message, true, 8000); return null; }
  const imm = a.immobile;
  let n = 0;
  for (const [k, v] of Object.entries(r.immobile || {})) {
    if (k === "codice_comune" || k === "provincia") continue;
    if (v && (replace || !imm[k])) { imm[k] = v; n++; }
  }
  if (r.immobile?.comune && !a.comune.nome) a.comune.nome = r.immobile.comune;
  let added = 0;
  for (const p of r.intestati || []) {
    if (a.committenti.some(c => c.cf && c.cf === p.cf)) continue;
    const empty = a.committenti.length === 1 && !a.committenti[0].cognome && !a.committenti[0].cf && !a.committenti[0].ditta?.ragione;
    const base = empty ? a.committenti[0] : blankPerson();
    Object.assign(base, p, { ditta: { ...base.ditta, ...(p.ditta || {}) } });
    if (!empty) a.committenti.push(base);
    added++;
  }
  toast(tr("pratica.visura_letta", n, added), false, 5000);
  return r;
}

export const blankPerson = () => ({ tipo: "persona", cognome: "", nome: "", cf: "", nato_a: "", nato_prov: "", nato_stato: "Italia", nato_il: "",
  res_comune: "", res_prov: "", res_stato: "Italia", res_indirizzo: "", res_civico: "", res_cap: "", pec: "", email: "", telefono: "",
  titolo: "proprietario", quota: "", ditta: { ragione: "", cf_piva: "", qualita: "", cciaa: "", cciaa_prov: "", cciaa_n: "", sede_comune: "",
    sede_prov: "", sede_indirizzo: "", sede_cap: "", pec: "", telefono: "" } });

// ------------------------------------------------------------------ finestra guidata
const STEPS = ["commessa", "committenti", "immobile", "tecnici", "imprese", "intervento", "procuratore"];

// a: anagrafica (copiata: si modifica solo se si conferma); regioni: [{codice, nome, atto}]
export function openWizard(a0, { regioni = [], step = 0 } = {}) {
  const a = structuredClone(a0);
  let cur = Math.max(0, Math.min(STEPS.length - 1, step));
  return new Promise(resolve => {
    const back = el("div", { class: "pte-back", role: "dialog", "aria-label": tr("pratica.dati_commessa") });
    const nav = el("nav", { class: "pte-steps" });
    const body = el("div", { class: "pte-body" });
    const btnPrev = el("button", { class: "btn", onclick: () => go(cur - 1) }, tr("pratica.indietro"));
    const btnNext = el("button", { class: "btn", onclick: () => go(cur + 1) }, tr("common.avanti"));
    const btnOk = el("button", { class: "btn primary", onclick: () => close(a) }, tr("pratica.salva_dati"));
    const close = v => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(null); } };
    function go(i) {
      if (i < 0 || i >= STEPS.length) return;
      cur = i;
      render();
    }
    function render() {
      nav.innerHTML = "";
      STEPS.forEach((s, i) => nav.append(el("button", { class: "pte-step" + (i === cur ? " on" : "") + (stepDone(a, s) ? " done" : ""), onclick: () => go(i) },
        el("b", {}, String(i + 1)), el("span", {}, tr("pratica.passo_" + s)))));
      body.innerHTML = "";
      body.append(PAGES[STEPS[cur]](a, render, regioni));
      btnPrev.disabled = cur === 0;
      btnNext.disabled = cur === STEPS.length - 1;
      body.scrollTop = 0;
    }
    back.append(el("div", { class: "pte-box" },
      el("header", { class: "pte-head" }, el("h2", {}, tr("pratica.dati_commessa")), el("span", { class: "pte-hint" }, tr("pratica.dati_una_volta")),
        el("button", { class: "pte-x", title: tr("newfile.chiudi_esc"), html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>', onclick: () => close(null) })),
      el("div", { class: "pte-main" }, nav, body),
      el("footer", { class: "pte-foot" }, btnPrev, btnNext, el("span", { class: "grow" }), el("button", { class: "btn", onclick: () => close(null) }, tr("common.annulla")), btnOk),
      el("datalist", { id: "pte-albi" }, ...["Ordine degli Ingegneri", "Ordine degli Architetti P.P.C.", "Collegio dei Geometri e Geometri Laureati",
        "Collegio dei Periti Industriali", "Ordine dei Geologi", "Ordine dei Dottori Agronomi e Forestali"].map(v => el("option", { value: v }))),
      el("datalist", { id: "pte-titoli" }, ...["Permesso di costruire", "SCIA", "SCIA alternativa al permesso di costruire", "CILA", "CILA-Superbonus"].map(v => el("option", { value: v }))),
      el("datalist", { id: "pte-qualita" }, ...["proprietario", "comproprietario", "usufruttuario", "amministratore di condominio", "condomino delegato",
        "legale rappresentante", "conduttore", "titolare del diritto di superficie"].map(v => el("option", { value: v })))));
    document.body.append(back);
    document.addEventListener("keydown", onKey, true);
    render();
  });
}

function stepDone(a, s) {
  if (s === "commessa") return !!a.comune.nome;
  if (s === "committenti") return a.committenti.some(c => c.cognome || c.ditta?.ragione);
  if (s === "immobile") return !!(a.immobile.via && a.immobile.foglio && a.immobile.particella);
  if (s === "tecnici") return a.tecnici.some(x => x.ruolo === "progettista" && x.cognome);
  if (s === "imprese") return a.imprese.length > 0 || a.intervento.in_economia;
  if (s === "intervento") return !!(a.intervento.descrizione && a.intervento.tipologia);
  if (s === "procuratore") return !a.procuratore.attivo || !!a.procuratore.cognome;
  return false;
}

// elenco di schede ripetibili (committenti, tecnici, imprese, titoli)
function cards(list, make, addLabel, blank, rerender, title) {
  const box = el("div", { class: "pte-cards" });
  list.forEach((item, i) => {
    box.append(el("section", { class: "pte-card" },
      el("div", { class: "pte-card-h" }, el("b", {}, title(item, i)), el("span", { class: "grow" }),
        i > 0 ? el("button", { class: "btn", title: tr("pratica.sposta_su"), onclick: () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); rerender(); } }, "↑") : null,
        el("button", { class: "btn danger", onclick: () => { list.splice(i, 1); rerender(); } }, tr("pratica.rimuovi"))),
      make(item, i)));
  });
  box.append(el("button", { class: "btn", onclick: () => { list.push(blank()); rerender(); } }, "+ " + addLabel));
  return box;
}

const PAGES = {
  commessa(a, rerender, regioni) {
    const reg = regioni.find(r => r.codice === a.regione);
    return el("div", {},
      el("h3", {}, tr("pratica.passo_commessa")),
      grid(a, [["commessa.codice", "pratica.f_codice", "text", null, 2], ["commessa.nome", "pratica.f_nome_commessa", "text", null, 4]]),
      sub(tr("pratica.sportello")),
      grid(a, [["regione", "pratica.f_regione", "select", regioni.map(r => [r.codice, r.codice ? r.nome : tr("pratica.nazionale")]), 3],
        ["comune.nome", "pratica.f_comune", "text", null, 2], ["comune.prov", "pratica.f_prov", "upper", null, 1],
        ["comune.sportello", "pratica.f_sportello", "select", [["SUE", tr("pratica.sue")], ["SUAP", tr("pratica.suap")]], 2],
        ["comune.indirizzo", "pratica.f_indirizzo_sportello", "text", null, 4], ["comune.pec", "pratica.f_pec_sportello", "text", null, 6]], rerender),
      reg && reg.codice ? el("p", { class: "pte-warn" }, tr("pratica.regione_propria", reg.nome, reg.atto)) : el("p", { class: "pte-note" }, tr("pratica.regione_nazionale")),
      sub(tr("pratica.dati_ufficio")),
      grid(a, [["pratica.numero", "pratica.f_pratica_n", "text", null, 2], ["pratica.protocollo", "pratica.f_protocollo", "text", null, 2],
        ["pratica.data", "pratica.f_data_prot", "date", null, 2]]),
      el("p", { class: "pte-note" }, tr("pratica.dati_ufficio_nota")));
  },
  committenti(a, rerender) {
    const visura = el("button", { class: "btn", onclick: async () => { if (await importVisura(a)) rerender(); } }, tr("pratica.leggi_visura"));
    return el("div", {},
      el("div", { class: "pte-title-row" }, el("h3", {}, tr("pratica.passo_committenti")), el("span", { class: "grow" }), visura),
      el("p", { class: "pte-note" }, tr("pratica.committenti_nota")),
      cards(a.committenti, c => el("div", {},
        grid(c, [["tipo", "pratica.f_tipo_soggetto", "select", [["persona", tr("pratica.persona")], ["societa", tr("pratica.societa")]], 2],
          ["titolo", "pratica.f_titolo", "list", "pte-qualita", 3], ["quota", "pratica.f_quota", "text", null, 1]], rerender),
        grid(c, PERSONA),
        c.tipo === "societa" ? el("div", {}, sub(tr("pratica.dati_ditta")), grid(c, DITTA)) : null),
      tr("pratica.aggiungi_committente"), blankPerson, rerender,
      (c, i) => `${i + 1}. ${[c.cognome, c.nome].filter(Boolean).join(" ") || c.ditta?.ragione || tr("pratica.nuovo_soggetto")}`));
  },
  immobile(a, rerender) {
    const imm = a.immobile;
    const visura = el("button", { class: "btn", onclick: async () => { if (await importVisura(a)) rerender(); } }, tr("pratica.leggi_visura"));
    return el("div", {},
      el("div", { class: "pte-title-row" }, el("h3", {}, tr("pratica.passo_immobile")), el("span", { class: "grow" }), visura),
      grid(imm, [["via", "pratica.f_via", "text", null, 4], ["civico", "pratica.f_civico", "text", null, 1], ["cap", "pratica.f_cap", "text", null, 1],
        ["comune", "pratica.f_comune", "text", null, 3], ["prov", "pratica.f_prov", "upper", null, 1], ["scala", "pratica.f_scala", "text", null, 1],
        ["piano", "pratica.f_piano", "text", null, 1], ["interno", "pratica.f_interno", "text", null, 1],
        ["destinazione", "pratica.f_destinazione", "text", null, 3], ["coordinate", "pratica.f_coordinate", "text", null, 2]]),
      sub(tr("pratica.catasto")),
      grid(imm, [["catasto", "pratica.f_catasto", "select", [["fabbricati", tr("pratica.fabbricati")], ["terreni", tr("pratica.terreni")]], 2],
        ["sezione", "pratica.f_sezione", "text", null, 1], ["sez_urbana", "pratica.f_sez_urbana", "text", null, 1],
        ["foglio", "pratica.f_foglio", "text", null, 1], ["particella", "pratica.f_particella", "text", null, 1],
        ["subalterno", "pratica.f_sub", "text", null, 1], ["categoria", "pratica.f_categoria", "upper", null, 1], ["classe", "pratica.f_classe", "text", null, 1],
        ["consistenza", "pratica.f_consistenza", "text", null, 1], ["superficie", "pratica.f_superficie_cat", "text", null, 1], ["rendita", "pratica.f_rendita", "text", null, 1]]),
      sub(tr("pratica.urbanistica")),
      grid(imm, [["zona_urbanistica", "pratica.f_zona", "text", null, 2],
        ["zona_sismica", "pratica.f_zona_sismica", "select", [["", "-"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]], 2],
        ["anno_costruzione", "pratica.f_anno", "text", null, 2], ["ante67", "pratica.f_ante67", "check", null, 6],
        ["titolo_legittimo", "pratica.f_titolo_legittimo", "text", null, 3], ["titolo_legittimazione", "pratica.f_titolo_legittimazione", "text", null, 3],
        ["difformita", "pratica.f_difformita", "check", null, 6]]),
      sub(tr("pratica.titoli_edilizi")),
      cards(imm.titoli, x => grid(x, [["tipo", "pratica.f_tipo_titolo", "select", opt("pratica.tt_", TIPI_TITOLO), 3],
        ["numero", "pratica.f_numero", "text", null, 1], ["data", "pratica.f_data", "date", null, 2], ["descrizione", "pratica.f_descrizione_titolo", "text", null, 6]], rerender),
      tr("pratica.aggiungi_titolo"), () => ({ tipo: "pdc", numero: "", data: "", descrizione: "" }), rerender,
      (x, i) => `${i + 1}. ${tr("pratica.tt_" + (x.tipo || "altro"))}${x.numero ? " n. " + x.numero : ""}`));
  },
  tecnici(a, rerender) {
    return el("div", {},
      el("h3", {}, tr("pratica.passo_tecnici")),
      el("p", { class: "pte-note" }, tr("pratica.tecnici_nota")),
      cards(a.tecnici, x => el("div", {},
        grid(x, [["ruolo", "pratica.f_ruolo", "select", opt("pratica.ruolo_", RUOLI), 3],
          ...(x.ruolo === "altro" ? [["ruolo_altro", "pratica.f_ruolo_altro", "text", null, 3]] : []),
          ...(x.ruolo === "progettista" || x.ruolo === "strutturista" ? [["anche_dl", "pratica.f_anche_dl", "check", null, 3]] : [])], rerender),
        grid(x, [...ALBO, ...PERSONA, ...STUDIO])),
      tr("pratica.aggiungi_tecnico"), () => ({ ...blankPerson(), ruolo: a.tecnici.some(t => t.ruolo === "progettista") ? "direttore_lavori" : "progettista",
        anche_dl: false, albo: "", albo_prov: "", albo_n: "", studio_comune: "", studio_prov: "", studio_cap: "", studio_indirizzo: "", studio_civico: "",
        studio_stato: "Italia", cellulare: "" }), rerender,
      (x, i) => `${i + 1}. ${tr("pratica.ruolo_" + (x.ruolo || "altro"))}${x.cognome ? " - " + x.cognome + " " + x.nome : ""}`));
  },
  imprese(a, rerender) {
    return el("div", {},
      el("h3", {}, tr("pratica.passo_imprese")),
      grid(a, [["intervento.in_economia", "pratica.f_in_economia", "check", null, 6]]),
      cards(a.imprese, x => el("div", {},
        grid(x, [["ragione", "pratica.f_ragione", "text", null, 4], ["cf_piva", "pratica.f_cf_piva", "upper", null, 2],
          ["cciaa", "pratica.f_cciaa", "text", null, 2], ["cciaa_prov", "pratica.f_prov", "upper", null, 1], ["cciaa_n", "pratica.f_cciaa_n", "text", null, 1],
          ["pec", "pratica.f_pec", "text", null, 2],
          ["sede_comune", "pratica.f_sede_comune", "text", null, 2], ["sede_prov", "pratica.f_prov", "upper", null, 1], ["sede_cap", "pratica.f_cap", "text", null, 1],
          ["sede_indirizzo", "pratica.f_indirizzo", "text", null, 2],
          ["telefono", "pratica.f_telefono", "text", null, 2], ["lavori", "pratica.f_lavori_affidati", "text", null, 4]]),
        sub(tr("pratica.legale")),
        grid(x, [["legale_cognome", "pratica.f_cognome", "text", null, 2], ["legale_nome", "pratica.f_nome", "text", null, 2], ["legale_cf", "pratica.f_cf", "upper", null, 2],
          ["legale_nato_a", "pratica.f_nato_a", "text", null, 3], ["legale_nato_prov", "pratica.f_prov", "upper", null, 1], ["legale_nato_il", "pratica.f_nato_il", "date", null, 2]]),
        sub(tr("pratica.regolarita")),
        grid(x, [["cassa_sede", "pratica.f_cassa_sede", "text", null, 2], ["cassa_codice_impresa", "pratica.f_cassa_impresa", "text", null, 2], ["cassa_codice", "pratica.f_cassa_codice", "text", null, 2],
          ["inps_sede", "pratica.f_inps_sede", "text", null, 3], ["inps_matricola", "pratica.f_inps_matricola", "text", null, 3],
          ["inail_sede", "pratica.f_inail_sede", "text", null, 2], ["inail_codice", "pratica.f_inail_codice", "text", null, 2], ["inail_pat", "pratica.f_inail_pat", "text", null, 2]])),
      tr("pratica.aggiungi_impresa"), () => ({ ragione: "", cf_piva: "", sede_stato: "Italia", legale_nato_stato: "Italia" }), rerender,
      (x, i) => `${i + 1}. ${x.ragione || tr("pratica.nuova_impresa")}`));
  },
  intervento(a, rerender) {
    const itv = a.intervento;
    return el("div", {},
      el("h3", {}, tr("pratica.passo_intervento")),
      grid(a, [["intervento.descrizione", "pratica.f_descrizione", "textarea", null, 6],
        ["intervento.tipologia", "pratica.f_tipologia", "select", [["", "-"], ...opt("pratica.tip_", TIPOLOGIE)], 4],
        ["intervento.superbonus", "pratica.f_superbonus", "select", [["", "-"], ["energetico", tr("pratica.sb_energetico")], ["strutturale", tr("pratica.sb_strutturale")], ["entrambi", tr("pratica.sb_entrambi")]], 2],
        ...(itv.tipologia === "altro" ? [["intervento.tipologia_altro", "pratica.f_tipologia_altro", "text", null, 6]] : []),
        ["intervento.stato_lavori", "pratica.f_stato_lavori", "select", opt("pratica.stato_", ["da_iniziare", "dopo_assensi", "in_corso", "realizzati"]), 3],
        ["intervento.altri_atti", "pratica.f_altri_atti", "select", opt("pratica.atti_", ["nessuno", "segnalazioni", "assensi"]), 3],
        ["intervento.inizio_lavori", "pratica.f_inizio", "date", null, 2], ["intervento.fine_lavori", "pratica.f_fine", "date", null, 2],
        ["intervento.fine_parziale", "pratica.f_fine_parziale", "check", null, 2],
        ...(itv.stato_lavori === "in_corso" ? [["intervento.inizio_effettivo", "pratica.f_inizio_effettivo", "date", null, 2]] : []),
        ...(itv.stato_lavori === "realizzati" ? [["intervento.data_realizzazione", "pratica.f_data_realizzazione", "date", null, 2]] : []),
        ["intervento.cambio_uso", "pratica.f_cambio_uso", "select", opt("pratica.uso_", ["no", "stessa_categoria", "zone_abc", "intero_stessa"]), 6]], rerender),
      sub(tr("pratica.titolo_lavori")),
      grid(a, [["intervento.titolo_tipo", "pratica.f_titolo_tipo", "list", "pte-titoli", 3], ["intervento.titolo_n", "pratica.f_numero", "text", null, 1],
        ["intervento.titolo_data", "pratica.f_data", "date", null, 2], ["intervento.variante", "pratica.f_variante", "check", null, 6]]),
      sub(tr("pratica.dati_dimensionali")),
      grid(a, [["intervento.superficie", "pratica.f_superficie", "text", null, 2], ["intervento.volume", "pratica.f_volume", "text", null, 2],
        ["intervento.piani", "pratica.f_piani", "text", null, 1], ["intervento.importo", "pratica.f_importo", "text", null, 1]]),
      sub(tr("pratica.dichiarazioni")),
      grid(a, [["intervento.titolarita_esclusiva", "pratica.f_titolarita", "check", null, 6],
        ["intervento.parti_comuni", "pratica.f_parti_comuni", "select", opt("pratica.pc_", ["no", "condominio", "misto", "comunione", "art1102"]), 6],
        ["intervento.oneroso", "pratica.f_oneroso", "check", null, 2],
        ...(itv.oneroso ? [["intervento.contributo_calcolo", "pratica.f_contributo_calcolo", "select", [["tecnico", tr("pratica.calc_tecnico")], ["sportello", tr("pratica.calc_sportello")]], 2],
          ["intervento.contributo_pagato", "pratica.f_contributo_pagato", "check", null, 2]] : [["intervento.gratuito_norma", "pratica.f_gratuito_norma", "text", null, 4]]),
        ["intervento.sicurezza_81", "pratica.f_sicurezza", "check", null, 6],
        ...(itv.sicurezza_81 ? [["intervento.cantiere_200", "pratica.f_cantiere_200", "check", null, 6], ["intervento.notifica_99", "pratica.f_notifica", "check", null, 3],
          ["intervento.sicurezza_riserva", "pratica.f_sicurezza_riserva", "check", null, 3]] : []),
        ["intervento.note", "pratica.f_note", "textarea", null, 6]], rerender));
  },
  procuratore(a, rerender) {
    const p = a.procuratore;
    const prog = a.tecnici.find(x => x.ruolo === "progettista");
    return el("div", {},
      el("div", { class: "pte-title-row" }, el("h3", {}, tr("pratica.passo_procuratore")), el("span", { class: "grow" }),
        prog ? el("button", { class: "btn", onclick: () => { Object.assign(p, structuredClone(prog), { attivo: true }); rerender(); } }, tr("pratica.usa_progettista")) : null),
      el("p", { class: "pte-note" }, tr("pratica.procuratore_nota")),
      grid(a, [["procuratore.attivo", "pratica.f_procura_attiva", "check", null, 6]], rerender),
      p.attivo ? grid(p, PERSONA) : null);
  },
};
