// Calendari iCalendar (.ics/.ical/.ifb/.vcs): vista mese ed elenco, dettagli dell'evento, ricerca; esporta PDF, CSV, Excel.
// Lettura in ui/js/pim.js (funziona anche nella web app).
import { button, el, loadCss, readBytes, WEB } from "../core.js";
import { decodeText, esc, parseCalendar, savePdf, saveTable } from "../pim.js";

const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const DOW = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];

export async function mount(ctx) {
  loadCss("css/formati.css");
  const cal = parseCalendar(decodeText(await readBytes(ctx.path)));
  const all = cal.elementi;
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  const first = all.find(e => e.inizio && e.inizio >= startOfDay(new Date())) || all.find(e => e.inizio) || null;
  let month = first ? new Date(first.inizio.getFullYear(), first.inizio.getMonth(), 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let mode = "mese", sel = null, query = "";

  const main = el("div", { style: { overflow: "auto", height: "100%" } });
  const detail = el("div", { class: "fx-pane" }, el("div", { class: "head" }, "Dettagli"), el("div", { class: "scroll" }));
  const split = el("div", { class: "fx-split with-right" }, main, detail);
  ctx.el.append(split);

  const title = el("b", { style: { padding: "0 8px", minWidth: "150px", fontSize: "14px" } });
  const search = el("input", { type: "search", placeholder: "Cerca negli eventi", style: { width: "220px" } });
  const bMese = button("Mese", null, () => { mode = "mese"; render(); });
  const bElenco = button("Elenco", null, () => { mode = "elenco"; render(); });
  ctx.tb.append(bMese, bElenco, el("span", { class: "sep" }),
    button("", "<svg viewBox='0 0 24 24'><path d='M15 6l-6 6 6 6'/></svg>", () => shift(-1), { iconOnly: true, title: "Mese precedente" }),
    button("Oggi", null, () => { const t = new Date(); month = new Date(t.getFullYear(), t.getMonth(), 1); render(); }),
    button("", "<svg viewBox='0 0 24 24'><path d='M9 6l6 6-6 6'/></svg>", () => shift(1), { iconOnly: true, title: "Mese successivo" }),
    title, el("span", { class: "grow" }), search);
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); if (query) mode = "elenco"; render(); });
  function shift(n) { month = new Date(month.getFullYear(), month.getMonth() + n, 1); if (mode === "elenco") mode = "mese"; render(); }

  const visible = () => all.filter(e => !query || [e.titolo, e.luogo, e.descrizione, e.categorie.join(" "), e.organizzatore?.nome].join(" ").toLowerCase().includes(query));

  function render() {
    bMese.classList.toggle("on", mode === "mese"); bElenco.classList.toggle("on", mode === "elenco");
    title.textContent = mode === "mese" ? `${MONTHS[month.getMonth()]} ${month.getFullYear()}` : `${visible().length} elementi`;
    main.innerHTML = "";
    if (mode === "mese") renderMonth(); else renderList();
    renderDetail();
    const ev = all.filter(e => e.tipo === "Evento").length;
    ctx.status(`${cal.nome ? cal.nome + " · " : ""}${ev} eventi${all.length - ev ? ` · ${all.length - ev} altri elementi` : ""}`);
  }

  function renderMonth() {
    const grid = el("div", { class: "cal-month" });
    DOW.forEach(d => grid.append(el("div", { class: "dow" }, d)));
    const start = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7));
    const today = startOfDay(new Date()).getTime();
    const list = visible();
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (i === 35 && d.getMonth() !== month.getMonth()) break;
      const cell = el("div", { class: "cal-day" + (d.getMonth() !== month.getMonth() ? " out" : "") + (d.getTime() === today ? " today" : "") }, el("span", { class: "n" }, d.getDate()));
      const evs = list.filter(e => occursOn(e, d)).sort((a, b) => (b.giornata - a.giornata) || ((a.inizio || 0) - (b.inizio || 0)));
      evs.slice(0, 4).forEach(e => cell.append(el("div", { class: "cal-ev" + (e.giornata ? " allday" : "") + (sel === e ? " sel" : ""), title: e.titolo, onclick: () => { sel = e; render(); } },
        (e.giornata || !e.inizio ? "" : hm(sameDay(e.inizio, d) ? e.inizio : d) + " ") + e.titolo)));
      if (evs.length > 4) cell.append(el("div", { class: "cal-more", onclick: () => { mode = "elenco"; query = ""; render(); scrollToDay(d); } }, `altri ${evs.length - 4}`));
      grid.append(cell);
    }
    main.append(el("div", { style: { padding: "12px" } }, grid));
  }

  function renderList() {
    const list = visible();
    if (!list.length) { main.append(el("div", { class: "fx-empty" }, query ? "Nessun elemento corrisponde alla ricerca." : "Il calendario e' vuoto.")); return; }
    const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, ...["Data", "Ora", "Titolo", "Luogo", "Tipo"].map(h => el("th", {}, h)))));
    const tb = el("tbody");
    let last = "";
    for (const e of list) {
      const d = e.inizio || e.scadenza;
      const key = d ? dayKey(d) : "";
      const tr = el("tr", { class: "click" + (sel === e ? " sel" : ""), "data-day": key, onclick: () => { sel = e; render(); } },
        el("td", { style: { whiteSpace: "nowrap" } }, key !== last && d ? d.toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : ""),
        el("td", { style: { whiteSpace: "nowrap" } }, timeRange(e)), el("td", {}, e.titolo, e.ripetuto ? el("span", { class: "fx-muted", title: e.regola || "" }, "  ↻") : null),
        el("td", {}, e.luogo), el("td", {}, e.tipo + (e.stato ? " · " + e.stato : "")));
      last = key;
      tb.append(tr);
    }
    t.append(tb);
    main.append(t);
  }
  function scrollToDay(d) { main.querySelector(`tr[data-day="${dayKey(d)}"]`)?.scrollIntoView({ block: "start" }); }

  function renderDetail() {
    const box = detail.querySelector(".scroll");
    box.innerHTML = "";
    if (!sel) { box.append(el("div", { class: "fx-empty" }, "Seleziona un evento per vederne i dettagli.")); return; }
    const e = sel;
    const dl = el("dl", { class: "kv stack", style: { padding: "12px 14px" } });
    const add = (k, v) => { if (v && (!Array.isArray(v) || v.length)) dl.append(el("dt", {}, k), el("dd", { style: { whiteSpace: "pre-wrap" } }, v)); };
    box.append(el("div", { style: { padding: "12px 14px 0", fontSize: "16px", fontWeight: 600 } }, e.titolo));
    add("Quando", whenText(e)); add("Ripetizione", e.regola); add("Scadenza", e.scadenza && e.scadenza.toLocaleDateString("it-IT"));
    add("Luogo", e.luogo); add("Stato", e.stato); add("Descrizione", e.descrizione);
    add("Organizzatore", e.organizzatore && `${e.organizzatore.nome}${e.organizzatore.email !== e.organizzatore.nome ? " <" + e.organizzatore.email + ">" : ""}`);
    add("Partecipanti", e.partecipanti.map(p => `${p.nome}${p.stato ? " - " + p.stato : ""}${p.ruolo ? " (" + p.ruolo + ")" : ""}`).join("\n"));
    add("Promemoria", e.promemoria.join("\n")); add("Categorie", e.categorie.join(", "));
    add("Priorita'", e.priorita && e.priorita !== "0" ? e.priorita : ""); add("Fuso orario", e.fuso); add("Collegamento", e.url);
    box.append(dl);
  }

  function rows() {
    return all.map(e => [e.inizio ? e.inizio.toLocaleDateString("it-IT") : "", e.giornata || !e.inizio ? "" : hm(e.inizio), e.fine ? e.fine.toLocaleDateString("it-IT") : "",
      e.giornata || !e.fine ? "" : hm(e.fine), e.giornata ? "si" : "no", e.titolo, e.luogo, e.descrizione, e.tipo, e.stato, e.categorie.join(", "),
      e.organizzatore?.nome || "", e.partecipanti.map(p => p.nome).join(", "), e.regola || "", e.scadenza ? e.scadenza.toLocaleDateString("it-IT") : ""]);
  }
  const COLS = ["Data inizio", "Ora inizio", "Data fine", "Ora fine", "Giornata intera", "Titolo", "Luogo", "Descrizione", "Tipo", "Stato", "Categorie", "Organizzatore", "Partecipanti", "Ripetizione", "Scadenza"];

  function pdfHtml() {
    let h = `<h1 style="font-family:sans-serif;font-size:18pt">${esc(cal.nome || ctx.name)}</h1><table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:9pt">`;
    h += `<tr>${[["Data", 15], ["Ora", 11], ["Titolo", 30], ["Luogo", 20], ["Note", 24]].map(([c, w]) => `<th style="text-align:left;border-bottom:1px solid #888;padding:3px;width:${w}%">${c}</th>`).join("")}</tr>`;
    let last = "";
    for (const e of all) {
      const d = e.inizio || e.scadenza;
      const k = d ? d.toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : "";
      h += `<tr><td style="padding:3px;border-bottom:1px solid #ddd;white-space:nowrap">${k !== last ? esc(k) : ""}</td><td style="padding:3px;border-bottom:1px solid #ddd">${esc(timeRange(e))}</td>` +
        `<td style="padding:3px;border-bottom:1px solid #ddd"><b>${esc(e.titolo)}</b></td><td style="padding:3px;border-bottom:1px solid #ddd">${esc(e.luogo)}</td>` +
        `<td style="padding:3px;border-bottom:1px solid #ddd">${esc([e.tipo !== "Evento" ? e.tipo : "", e.stato, e.descrizione.slice(0, 300)].filter(Boolean).join(" - "))}</td></tr>`;
      last = k;
    }
    return h + "</table>";
  }

  render();
  return {
    saveInPlace: false,
    saveFormats: WEB ? ["csv", "xlsx"] : ["pdf", "csv", "xlsx"],
    saveLabels: { pdf: "Elenco degli eventi", csv: "Eventi in tabella (separatore ;)", xlsx: "Eventi in un foglio Excel" },
    async save(target) {
      const ext = target.split(".").pop().toLowerCase();
      if (ext === "pdf") await savePdf(target, pdfHtml(), true);
      else await saveTable(target, "Eventi", COLS, rows());
      return { switchTo: false };
    },
  };
}

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function dayKey(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function hm(d) { return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }); }
function occursOn(e, d) {
  const s = e.inizio || e.scadenza;
  if (!s) return false;
  const a = startOfDay(s), b = startOfDay(e.fine && e.fine > s ? e.fine : s);
  return d >= a && d <= b;
}
function timeRange(e) {
  if (!e.inizio) return e.scadenza ? "scadenza" : "";
  if (e.giornata) return e.fine && !sameDay(e.fine, e.inizio) ? "fino al " + e.fine.toLocaleDateString("it-IT", { day: "2-digit", month: "short" }) : "tutto il giorno";
  return hm(e.inizio) + (e.fine ? " - " + (sameDay(e.fine, e.inizio) ? "" : e.fine.toLocaleDateString("it-IT", { day: "2-digit", month: "short" }) + " ") + hm(e.fine) : "");
}
function whenText(e) {
  if (!e.inizio) return "";
  const day = d => d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (e.giornata) return day(e.inizio) + (e.fine && !sameDay(e.fine, e.inizio) ? " - " + day(e.fine) : "") + " (tutto il giorno)";
  return day(e.inizio) + ", " + timeRange(e);
}
