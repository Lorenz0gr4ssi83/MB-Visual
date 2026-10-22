// Calendario della posta (Ctrl+2): giorno, settimana lavorativa, settimana, mese, agenda; calendari degli account
// (CalDAV, Microsoft 365, Google, locali) con colori; nuovo evento con partecipanti (invito), ricorrenza e promemoria.
// Le occorrenze degli eventi ricorrenti CalDAV si calcolano con pim.js (RRULE, EXDATE, eccezioni).
import { el, loadCss, modal, toast } from "../core.js";
import { LOCALE, t as tr } from "../i18n.js";
import { parseCalendar } from "../pim.js";
import { ap, icon, popMenu } from "./mailapp.js";
import { IC } from "./mailicons.js";

const HOUR = 46;
const VIEWS = [["giorno", "mail.cal_giorno"], ["lavoro", "mail.cal_lavorativa"], ["settimana", "mail.cal_settimana"], ["mese", "mail.cal_mese"], ["agenda", "mail.cal_agenda"]];
const day0 = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monday = d => addDays(day0(d), -((d.getDay() + 6) % 7));
const hm = d => d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });

export async function mount(host, { search, call }) {
  loadCss("css/mailcal.css");
  let st = {};
  try { st = JSON.parse(localStorage.getItem("mbv-calendario") || "{}"); } catch { /* */ }
  const S = { view: st.view || "lavoro", date: day0(new Date()), hidden: new Set(st.hidden || []), items: [], cals: [], q: "" };
  const save = () => { try { localStorage.setItem("mbv-calendario", JSON.stringify({ view: S.view, hidden: [...S.hidden] })); } catch { /* */ } };
  const side = el("aside", { class: "cl-side" });
  const head = el("div", { class: "cl-head" });
  const body = el("div", { class: "cl-body" });
  host.append(el("div", { class: "cl-root" }, side, el("section", { class: "cl-main" }, head, body)));

  function range() {
    const d = S.date;
    if (S.view === "giorno") return [d, addDays(d, 1)];
    if (S.view === "lavoro") return [monday(d), addDays(monday(d), 5)];
    if (S.view === "settimana") return [monday(d), addDays(monday(d), 7)];
    if (S.view === "mese") { const f = monday(new Date(d.getFullYear(), d.getMonth(), 1)); return [f, addDays(f, 42)]; }
    return [d, addDays(d, 60)];
  }

  async function load() {
    const [a, z] = range();
    let r;
    try { r = await call("cal", { da: a.getTime() / 1000 - 86400, a: z.getTime() / 1000 + 86400 }); } catch (e) { toast(e.message, true); return; }
    S.cals = r.calendari;
    const out = [];
    for (const e of r.items) {
      if (e.ics) { // evento ricorrente: occorrenze nel periodo
        try {
          for (const o of parseCalendar(e.ics).elementi) {
            if (!o.inizio || o.inizio > z || (o.fine || o.inizio) < a) continue;
            out.push({ ...e, s: o.inizio, e: o.fine || new Date(o.inizio.getTime() + 3600000), ric: true });
          }
        } catch { /* */ }
      } else out.push({ ...e, s: new Date(e.start * 1000), e: new Date(e.end * 1000) });
    }
    S.items = out;
    render();
  }

  const visible = () => S.items.filter(e => !S.hidden.has(e.cal) && (!S.q || `${e.summary} ${e.location}`.toLowerCase().includes(S.q)));

  function render() {
    renderSide();
    renderHead();
    body.innerHTML = "";
    if (S.view === "mese") renderMonth();
    else if (S.view === "agenda") renderAgenda();
    else renderDays();
  }

  function renderSide() {
    side.innerHTML = "";
    ap(side, el("button", { class: "btn primary cl-new", onclick: () => editEvent(null) }, icon("piu"), tr("mail.nuovo_evento")), miniMonth(),
      el("div", { class: "label cl-sec" }, tr("mail.calendari")));
    const byAcc = {};
    for (const c of S.cals) (byAcc[c.account] ||= []).push(c);
    for (const list of Object.values(byAcc)) {
      for (const c of list) {
        const cb = el("input", { type: "checkbox", checked: !S.hidden.has(c.id) || undefined });
        cb.addEventListener("change", () => { cb.checked ? S.hidden.delete(c.id) : S.hidden.add(c.id); save(); render(); });
        side.append(el("label", { class: "cl-cal", style: { "--c": c.color || "var(--accent)" } }, cb, el("span", { class: "sw" }), el("span", { class: "nm" }, c.name)));
      }
    }
    if (!S.cals.length) side.append(el("p", { class: "muted cl-hint" }, tr("mail.nessun_calendario")));
  }

  function miniMonth() {
    const box = el("div", { class: "cl-mini" });
    const m0 = new Date(S.date.getFullYear(), S.date.getMonth(), 1);
    box.append(el("div", { class: "cl-minih" }, el("b", {}, m0.toLocaleDateString(LOCALE, { month: "long", year: "numeric" }))));
    const g = el("div", { class: "cl-minig" });
    for (let i = 0; i < 7; i++) g.append(el("span", { class: "dw" }, new Date(1970, 0, 5 + i).toLocaleDateString(LOCALE, { weekday: "narrow" })));
    const f = monday(m0), today = day0(new Date()).getTime();
    for (let i = 0; i < 42; i++) {
      const d = addDays(f, i);
      g.append(el("button", { class: "dd" + (d.getMonth() !== m0.getMonth() ? " out" : "") + (d.getTime() === today ? " today" : "") + (d.getTime() === S.date.getTime() ? " sel" : ""),
        onclick: () => { S.date = d; load(); } }, String(d.getDate())));
    }
    box.append(g);
    return box;
  }

  function renderHead() {
    head.innerHTML = "";
    const [a, z] = range();
    let title;
    if (S.view === "giorno") title = S.date.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    else if (S.view === "mese") title = S.date.toLocaleDateString(LOCALE, { month: "long", year: "numeric" });
    else title = `${a.toLocaleDateString(LOCALE, { day: "numeric", month: "short" })} – ${addDays(z, -1).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" })}`;
    const step = d => { S.date = S.view === "mese" ? new Date(S.date.getFullYear(), S.date.getMonth() + d, 1) : addDays(S.date, d * (S.view === "giorno" ? 1 : S.view === "agenda" ? 30 : 7)); load(); };
    head.append(
      el("button", { class: "btn", onclick: () => { S.date = day0(new Date()); load(); } }, tr("mail.oggi")),
      el("button", { class: "ml-fbtn", title: tr("mail.precedente"), html: IC.sinistra, onclick: () => step(-1) }),
      el("button", { class: "ml-fbtn", title: tr("mail.successivo"), html: IC.destra, onclick: () => step(1) }),
      el("h3", {}, title), el("span", { class: "grow" }),
      el("div", { class: "seg" }, ...VIEWS.map(([v, k]) => el("button", { class: S.view === v ? "on" : "", onclick: () => { S.view = v; save(); load(); } }, tr(k)))));
  }

  // ---------------------------------------------------------- giorno / settimana
  function renderDays() {
    const [a, z] = range();
    const days = [];
    for (let d = a; d < z; d = addDays(d, 1)) days.push(d);
    const grid = el("div", { class: "cl-days", style: { "--n": days.length } });
    const hdr = el("div", { class: "cl-dhead" }, el("div", { class: "gut" }));
    const all = el("div", { class: "cl-allday" }, el("div", { class: "gut mono" }, tr("mail.tutto_il_giorno")));
    const cols = el("div", { class: "cl-cols" });
    const gut = el("div", { class: "cl-gut" });
    for (let h = 0; h < 24; h++) gut.append(el("div", { class: "hr mono", style: { top: h * HOUR + "px" } }, `${String(h).padStart(2, "0")}:00`));
    cols.append(gut);
    const today = day0(new Date()).getTime();
    const vis = visible();
    for (const d of days) {
      hdr.append(el("div", { class: "dh" + (d.getTime() === today ? " today" : "") }, el("span", { class: "wd" }, d.toLocaleDateString(LOCALE, { weekday: "short" })), el("b", {}, String(d.getDate()))));
      const ad = el("div", { class: "adc" });
      const de = addDays(d, 1);
      for (const e of vis.filter(x => x.allday && x.s < de && x.e > d)) ad.append(chip(e, true));
      all.append(ad);
      const col = el("div", { class: "cl-col" + (d.getTime() === today ? " today" : "") });
      for (let h = 0; h < 24; h++) col.append(el("div", { class: "slot", style: { top: h * HOUR + "px" } }));
      col.addEventListener("dblclick", ev => {
        if (ev.target.closest(".cl-ev")) return;
        const y = ev.clientY - col.getBoundingClientRect().top;
        const mins = Math.floor(y / HOUR * 2) * 30;
        const s = new Date(d.getTime() + mins * 60000);
        editEvent(null, { s, e: new Date(s.getTime() + 3600000) });
      });
      const evs = vis.filter(x => !x.allday && x.s < de && x.e > d).sort((p, q) => p.s - q.s);
      layout(evs).forEach(({ e, col: c, cols: n }) => {
        const s = Math.max(e.s, d), en = Math.min(e.e, de);
        const top = (s - d) / 3600000 * HOUR, h = Math.max(20, (en - s) / 3600000 * HOUR - 2);
        const box = chip(e, false);
        Object.assign(box.style, { top: top + "px", height: h + "px", left: `calc(${(c / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)` });
        col.append(box);
      });
      if (d.getTime() === today) {
        const now = new Date();
        col.append(el("div", { class: "cl-now", style: { top: (now - d) / 3600000 * HOUR + "px" } }));
      }
      cols.append(col);
    }
    const scroll = el("div", { class: "cl-scroll" }, cols);
    grid.append(hdr, all, scroll);
    body.append(grid);
    const y = Math.max(0, (Math.min(7.5, ...vis.filter(x => !x.allday && x.s >= a && x.s < z).map(x => x.s.getHours() - 0.5)) || 7.5) * HOUR);
    requestAnimationFrame(() => { scroll.scrollTop = y; });
    scroll.scrollTop = y;
  }

  function layout(evs) {
    const out = [];
    let group = [], end = 0;
    const flush = () => {
      const cols = [];
      for (const e of group) {
        let c = cols.findIndex(t => t <= e.s);
        if (c < 0) { c = cols.length; cols.push(0); }
        cols[c] = e.e;
        out.push({ e, col: c, cols: 0 });
      }
      for (const o of out.slice(out.length - group.length)) o.cols = cols.length;
      group = [];
    };
    for (const e of evs) {
      if (group.length && e.s >= end) flush();
      group.push(e);
      end = Math.max(end, e.e);
    }
    if (group.length) flush();
    return out;
  }

  function chip(e, small) {
    const b = el("div", { class: "cl-ev" + (small ? " small" : ""), style: { "--c": e.color || "var(--accent)" }, title: e.summary },
      el("b", {}, e.summary || tr("mail.senza_titolo")),
      small ? null : el("span", {}, (e.allday ? "" : hm(e.s) + " – " + hm(e.e)) + (e.location ? " · " + e.location : "")),
      e.ric ? el("span", { class: "ric", html: IC.sync }) : null);
    b.addEventListener("click", ev => { ev.stopPropagation(); details(e, ev); });
    b.addEventListener("dblclick", ev => { ev.stopPropagation(); editEvent(e); });
    return b;
  }

  // ---------------------------------------------------------- mese
  function renderMonth() {
    const [a] = range();
    const grid = el("div", { class: "cl-month" });
    for (let i = 0; i < 7; i++) grid.append(el("div", { class: "dow" }, new Date(1970, 0, 5 + i).toLocaleDateString(LOCALE, { weekday: "short" })));
    const today = day0(new Date()).getTime();
    const vis = visible();
    for (let i = 0; i < 42; i++) {
      const d = addDays(a, i), de = addDays(d, 1);
      const cell = el("div", { class: "cl-day" + (d.getMonth() !== S.date.getMonth() ? " out" : "") + (d.getTime() === today ? " today" : "") },
        el("span", { class: "n" }, String(d.getDate())));
      const evs = vis.filter(x => x.s < de && x.e > d).sort((p, q) => (q.allday - p.allday) || (p.s - q.s));
      for (const e of evs.slice(0, 4)) {
        const c = el("div", { class: "cl-mev" + (e.allday ? " ad" : ""), style: { "--c": e.color || "var(--accent)" }, onclick: ev => { ev.stopPropagation(); details(e, ev); } },
          e.allday ? "" : el("span", { class: "mono" }, hm(e.s)), " ", e.summary);
        cell.append(c);
      }
      if (evs.length > 4) cell.append(el("button", { class: "link cl-more", onclick: ev => { ev.stopPropagation(); S.date = d; S.view = "giorno"; load(); } }, tr("mail.altri_n", evs.length - 4)));
      cell.addEventListener("dblclick", () => { const s = new Date(d.getTime() + 9 * 3600000); editEvent(null, { s, e: new Date(s.getTime() + 3600000) }); });
      grid.append(cell);
    }
    body.append(grid);
  }

  // ---------------------------------------------------------- agenda
  function renderAgenda() {
    const list = el("div", { class: "cl-agenda" });
    const vis = visible().filter(e => e.e >= S.date).sort((p, q) => p.s - q.s);
    let last = "";
    for (const e of vis) {
      const k = day0(e.s).toDateString();
      if (k !== last) { list.append(el("div", { class: "cl-aday label" }, e.s.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" }))); last = k; }
      list.append(el("button", { class: "cl-arow", style: { "--c": e.color || "var(--accent)" }, onclick: ev => details(e, ev) },
        el("span", { class: "tm mono" }, e.allday ? tr("mail.tutto_il_giorno") : `${hm(e.s)} – ${hm(e.e)}`), el("span", { class: "sw" }),
        el("b", {}, e.summary), el("span", { class: "muted" }, e.location || ""), el("span", { class: "muted" }, e.cal_name)));
    }
    if (!vis.length) list.append(el("p", { class: "muted" }, tr("mail.nessun_evento")));
    body.append(list);
  }

  // ---------------------------------------------------------- dettagli e modifica
  async function details(e, ev) {
    const items = [
      { sec: e.summary || tr("mail.senza_titolo") },
      { label: (e.allday ? e.s.toLocaleDateString(LOCALE) : `${e.s.toLocaleString(LOCALE, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} – ${hm(e.e)}`), icon: "orologio", disabled: true },
      e.location ? { label: e.location, icon: "commessa", disabled: true } : null,
      { label: e.cal_name, color: e.color, disabled: true },
      "-",
      { label: tr("mail.modifica"), icon: "bozze", disabled: !!e.readonly || e.rrule === "occ", run: () => editEvent(e) },
      { label: tr("mail.elimina"), icon: "elimina", disabled: !!e.readonly, run: async () => {
        const ok = await modal(tr("mail.elimina_evento"), el("p", {}, tr("mail.elimina_evento_domanda", e.summary)), [{ label: tr("common.annulla"), value: false }, { label: tr("mail.elimina"), value: true, danger: true }]);
        if (ok) { await call("cal_delete", { id: e.id }); load(); }
      } },
    ];
    popMenu(ev.clientX, ev.clientY, items);
  }

  async function editEvent(e, preset = {}) {
    let d = {};
    if (e) { try { d = (await call("cal_event", { id: e.id })).e; } catch (x) { return toast(x.message, true); } }
    const editable = S.cals.filter(c => !c.readonly);
    if (!editable.length) return toast(tr("mail.nessun_calendario"), true);
    const s0 = e ? new Date(d.start * 1000) : preset.s || new Date(Math.ceil(Date.now() / 1800000) * 1800000);
    const e0 = e ? new Date(d.end * 1000) : preset.e || new Date(s0.getTime() + 3600000);
    const pad = n => String(n).padStart(2, "0");
    const dt = x => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
    const f = (lab, inp) => el("label", { class: "ml-field" }, el("span", { class: "k" }, lab), inp);
    const title = el("input", { type: "text", class: "field", value: d.summary || "" });
    const loc = el("input", { type: "text", class: "field", value: d.location || "" });
    const allday = el("input", { type: "checkbox", checked: d.allday ? true : undefined });
    const st = el("input", { type: "datetime-local", class: "field", value: dt(s0) });
    const en = el("input", { type: "datetime-local", class: "field", value: dt(d.allday ? new Date(e0.getTime() - 1) : e0) });
    const cal = el("select", { class: "field" }, ...editable.map(c => el("option", { value: c.id }, c.name)));
    cal.value = String(e ? e.cal : (editable[0].id));
    const rep = el("select", { class: "field" }, ...[["", "mail.ric_nessuna"], ["FREQ=DAILY", "mail.ric_giorno"], ["FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "mail.ric_feriali"],
      ["FREQ=WEEKLY", "mail.ric_settimana"], ["FREQ=MONTHLY", "mail.ric_mese"], ["FREQ=YEARLY", "mail.ric_anno"]].map(([v, k]) => el("option", { value: v }, tr(k))));
    rep.value = d.rrule && !d.rrule.includes("UNTIL") && !d.rrule.includes("COUNT") ? (rep.querySelector(`option[value="${d.rrule}"]`) ? d.rrule : "") : "";
    const rem = el("select", { class: "field" }, ...[[-1, "mail.prom_nessuno"], [0, "mail.prom_inizio"], [5, "mail.prom_5"], [15, "mail.prom_15"], [30, "mail.prom_30"], [60, "mail.prom_60"], [1440, "mail.prom_giorno"]]
      .map(([v, k]) => el("option", { value: v }, tr(k))));
    rem.value = String(e ? d.promemoria ?? -1 : 15);
    const att = el("input", { type: "text", class: "field", value: (d.attendees || []).map(a => a.a).join(", "), placeholder: "nome@dominio.it, ..." });
    const desc = el("textarea", { class: "field", rows: 4 }, d.description || "");
    const toggleAll = () => { for (const x of [st, en]) { const v = x.value; x.type = allday.checked ? "date" : "datetime-local"; x.value = allday.checked ? v.slice(0, 10) : (v.length === 10 ? v + "T09:00" : v); } };
    allday.addEventListener("change", toggleAll);
    if (d.allday) toggleAll();
    const form = el("div", { class: "ml-form cl-form" }, f(tr("mail.titolo"), title), f(tr("mail.luogo"), loc),
      el("label", { class: "ml-check" }, allday, tr("mail.tutto_il_giorno")),
      el("div", { class: "ml-grid2" }, f(tr("mail.inizio"), st), f(tr("mail.fine"), en)),
      el("div", { class: "ml-grid3 eq" }, f(tr("mail.calendario"), cal), f(tr("mail.ripeti"), rep), f(tr("mail.promemoria"), rem)),
      f(tr("mail.partecipanti"), att), el("span", { class: "hint muted" }, tr("mail.partecipanti_hint")), f(tr("mail.note"), desc));
    const btns = [...(e ? [{ label: tr("mail.elimina"), value: "del", danger: true }] : []), { label: tr("common.annulla"), value: null }, { label: tr("common.salva"), value: "ok", primary: true }];
    setTimeout(() => title.focus(), 50);
    const r = await modal(e ? tr("mail.modifica_evento") : tr("mail.nuovo_evento"), form, btns);
    if (r === "del") { await call("cal_delete", { id: e.id }); return load(); }
    if (r !== "ok") return;
    let s = new Date(st.value), z = new Date(en.value);
    if (allday.checked) { s = new Date(st.value + "T00:00"); z = addDays(new Date(en.value + "T00:00"), 1); }
    if (!(z > s)) return toast(tr("mail.fine_prima_inizio"), true);
    const attendees = att.value.split(/[,;\s]+/).filter(x => x.includes("@")).map(a => ({ a: a.trim() }));
    try {
      await call("cal_save", { id: e?.id, cal: +cal.value, summary: title.value.trim() || tr("mail.senza_titolo"), location: loc.value.trim(), description: desc.value,
        start: s.getTime() / 1000, end: z.getTime() / 1000, allday: allday.checked, rrule: rep.value, promemoria: +rem.value, attendees });
      if (attendees.length) toast(tr("mail.invito_in_invio"));
      load();
    } catch (x) { toast(x.message, true, 6000); }
  }

  const onSearch = () => { S.q = search.value.trim().toLowerCase(); if (S.q && S.view !== "agenda") { S.view = "agenda"; } load(); };
  await load();
  const timer = setInterval(load, 60000);
  return {
    dispose() { clearInterval(timer); },
    newEvent: () => editEvent(null),
    search: onSearch,
  };
}
