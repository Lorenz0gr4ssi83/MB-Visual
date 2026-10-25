// Componenti di MB Desk: scelti nel programma di installazione (o al primo avvio sul Mac) e da File > Componenti...
// I file restano tutti installati: un componente spento toglie pulsanti, voci di menu e "Crea nuovo"; i suoi file si
// aprono comunque in visualizzazione con l'invito ad attivarlo. Registro unico: ui/components.json; scelta salvata
// dal motore (mbvisual/components.py) in componenti.json. Nella web app sono sempre tutti accesi.
// Elementi legati a un componente: attributo data-comp="<id>" (nascosti dal foglio di stile generato in apply()).
import { api, el, modal, toast, WEB } from "./core.js";
import { t as tr } from "./i18n.js";

const MAC = /Mac/.test(navigator.platform || navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent);
let REG = { components: [], profiles: [] };
let ON = null;            // Set dei componenti facoltativi accesi (null = registro non ancora letto: tutto acceso)
let STATE = { esiste: true, profilo: "completo" };
const CAT = new Map(), EXT = new Map(), ALIAS = new Map(); // ALIAS: id interno (isOn, data-comp) -> applicazione
const app = id => ALIAS.get(id) || id;

export const ICON = id => `<svg viewBox="0 0 24 24">${REG.components.find(c => c.id === app(id))?.icon || ""}</svg>`;
export const compName = id => tr(`comp.${app(id)}.nome`);
const visible = () => REG.components.filter(c => !(c.win && (MAC || WEB)));
const optional = () => visible().filter(c => !c.fixed).map(c => c.id);

export async function initComponents() {
  try { REG = await (await fetch("components.json")).json(); } catch { return; }
  for (const c of REG.components) {
    for (const k of c.cats || []) CAT.set(k, c.id);
    for (const e of c.exts || []) EXT.set(e, c.id);
    for (const a of c.aliases || []) ALIAS.set(a, c.id);
  }
  if (WEB) { ON = new Set(optional()); return apply(); }
  try {
    STATE = await api("components", {}, { allowFail: true });
    ON = new Set(STATE.ok === false ? optional() : STATE.attivi || []);
  } catch { ON = new Set(optional()); }
  apply();
}

export function isOn(id) {
  if (!ON || WEB) return true;
  const c = REG.components.find(x => x.id === app(id));
  return !c || !!c.fixed || ON.has(c.id);
}

// componente che serve per modificare un file (null = Base): prima l'estensione, poi la categoria di formats.json
export function compFor(catId, ext) {
  return EXT.get(ext) || CAT.get(catId) || null;
}

// sul Mac il .dmg non ha pagine di installazione: la scelta si fa al primo avvio
export const needsFirstRun = () => !WEB && MAC && STATE && STATE.esiste === false;

function apply() {
  const off = REG.components.filter(c => !c.fixed && !isOn(c.id)).map(c => c.id);
  document.documentElement.dataset.compOff = off.join(" ");
  let st = document.getElementById("comp-css");
  if (!st) {
    st = el("style", { id: "comp-css" });
    st.textContent = REG.components.flatMap(c => [c.id, ...(c.aliases || [])].map(a => `html[data-comp-off~="${c.id}"] [data-comp="${a}"]{display:none!important}`)).join("\n");
    document.head.append(st);
  }
}

async function store(list, profilo) {
  const r = await api("components", {}, { json: { attivi: list, profilo } });
  STATE = r;
  ON = new Set(r.attivi || []);
  apply();
  window.dispatchEvent(new CustomEvent("mbv-components", { detail: { attivi: [...ON] } }));
}

function profileOf(set) {
  const all = optional();
  for (const p of REG.profiles) {
    const list = p.comps === "*" ? all : p.comps.filter(x => all.includes(x));
    if (list.length === set.size && list.every(x => set.has(x))) return p.id;
  }
  return "personalizzato";
}
const profileList = id => { const p = REG.profiles.find(x => x.id === id); return !p ? null : p.comps === "*" ? optional() : p.comps.filter(x => optional().includes(x)); };

// invito discreto nella barra di un file che richiede un componente spento
export function inviteChip(id, onclick) {
  id = app(id);
  const b = el("button", { class: "comp-invite", type: "button", title: tr(`comp.${id}.desc`), onclick: () => (onclick ? onclick() : showComponents({ focus: id })) });
  b.insertAdjacentHTML("beforeend", ICON(id));
  b.append(el("span", {}, tr(REG.components.find(c => c.id === id)?.invite === "usa" ? "comp.invito_usa" : "comp.invito", compName(id))));
  return b;
}

// prima di una funzione legata a un componente: se e' spento si propone di attivarlo (true = si puo' proseguire)
export async function needComp(id) {
  if (isOn(id)) return true;
  id = app(id);
  const box = el("div", { class: "comp-need" });
  box.insertAdjacentHTML("beforeend", `<span class="cm-ico">${ICON(id)}</span>`);
  box.append(el("div", {}, el("b", {}, compName(id)), el("p", {}, tr(`comp.${id}.desc`)), el("p", { class: "note" }, tr("comp.invito_azione", compName(id)))));
  const r = await modal(tr("comp.non_attivo"), box, [{ label: tr("common.annulla"), value: false }, { label: tr("comp.attiva"), value: true, primary: true }]);
  if (!r) return false;
  await store([...ON, id], profileOf(new Set([...ON, id])));
  toast(tr("comp.attivato", compName(id)));
  return true;
}

// vetrina dei componenti (stessa dell'installazione): profili + schede con interruttore
export function showComponents({ focus = null, welcome = false } = {}) {
  return new Promise(resolve => {
    const sel = new Set(ON || optional());
    const back = el("div", { class: "cm-back", role: "dialog", "aria-label": tr("comp.titolo") });
    const grid = el("div", { class: "cm-grid" });
    const count = el("span", { class: "cm-count" });
    // "Seleziona tutto" / "Deseleziona tutto" (i componenti sempre inclusi restano accesi)
    const allBtn = el("button", { class: "btn cm-all", onclick: () => { const o = optional(); if (o.every(x => sel.has(x))) sel.clear(); else o.forEach(x => sel.add(x)); render(); } });
    const close = v => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const cards = new Map();
    function render() {
      for (const [id, c] of cards) {
        const on = c.fixed || sel.has(id);
        c.card.classList.toggle("on", on);
        if (c.input) c.input.checked = on;
      }
      const opt = optional();
      count.textContent = tr("comp.attivi", opt.filter(x => sel.has(x)).length, opt.length);
      allBtn.textContent = opt.every(x => sel.has(x)) ? tr("comp.desel_tutto") : tr("comp.sel_tutto");
    }
    for (const c of visible()) {
      const card = el("label", { class: "cm-card" + (c.fixed ? " fixed" : ""), "data-id": c.id });
      card.insertAdjacentHTML("beforeend", `<span class="cm-ico">${ICON(c.id)}</span>`);
      const input = c.fixed ? null : el("input", { type: "checkbox", role: "switch", class: "cm-switch", "aria-label": compName(c.id),
        onchange: e => { if (e.target.checked) sel.add(c.id); else sel.delete(c.id); render(); } });
      card.append(el("span", { class: "cm-txt" }, el("b", {}, compName(c.id)), el("span", {}, tr(`comp.${c.id}.desc`))),
        c.fixed ? el("span", { class: "cm-pill" }, tr("comp.sempre")) : input);
      cards.set(c.id, { card, input, fixed: c.fixed });
      grid.append(card);
    }
    const okBtn = el("button", { class: "btn primary", onclick: async () => {
      okBtn.disabled = true;
      try { await store([...sel], profileOf(sel)); toast(tr("comp.salvato")); close(true); }
      catch (e) { okBtn.disabled = false; toast(e.message, true); }
    } }, welcome ? tr("comp.continua") : tr("comp.applica"));
    const onKey = e => { if (e.key === "Escape" && !welcome) { e.preventDefault(); close(false); } };
    back.append(el("div", { class: "cm-box" },
      el("header", { class: "cm-head" },
        el("div", {}, el("h2", {}, welcome ? tr("comp.benvenuto_titolo") : tr("comp.titolo")), el("p", {}, welcome ? tr("comp.benvenuto_testo") : tr("comp.sottotitolo"))),
        welcome ? null : el("button", { class: "nf-x cm-x", title: tr("common.chiudi"), html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>', onclick: () => close(false) })),
      el("p", { class: "cm-intro" }, tr("comp.intro")),
      el("div", { class: "cm-body" }, grid),
      el("footer", { class: "cm-foot" }, count, allBtn, el("span", { class: "grow" }), welcome ? null : el("button", { class: "btn", onclick: () => close(false) }, tr("common.annulla")), okBtn)));
    if (!welcome) back.addEventListener("pointerdown", e => { if (e.target === back) close(false); });
    document.body.append(back);
    document.addEventListener("keydown", onKey, true);
    render();
    if (focus && cards.has(focus)) { const c = cards.get(focus).card; c.classList.add("cm-focus"); c.scrollIntoView({ block: "center" }); }
  });
}
