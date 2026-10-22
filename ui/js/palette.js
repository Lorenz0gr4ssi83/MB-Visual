// Palette dei comandi (Ctrl+K o la ricerca nella barra del titolo): comandi dell'app, file aperti, recenti e, se si
// scrive un'estensione, come si apre quel formato. I dati arrivano da app.js (openPalette); qui solo la finestra.
import { el } from "./core.js";
import { t as tr, keyName } from "./i18n.js";

const fold = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// punteggio: inizio del testo > inizio di una parola > dentro la parola; -1 = non corrisponde
function score(text, q) {
  const t = fold(text), i = t.indexOf(q);
  if (i < 0) return -1;
  return i === 0 ? 3 : /[\s›/\\._-]/.test(t[i - 1]) ? 2 : 1;
}

// testo con la parte cercata evidenziata
function marked(text, q) {
  if (!q) return document.createTextNode(text);
  const i = fold(text).indexOf(q);
  if (i < 0) return document.createTextNode(text);
  const f = document.createDocumentFragment();
  f.append(text.slice(0, i), el("mark", {}, text.slice(i, i + q.length)), text.slice(i + q.length));
  return f;
}

let open = null;

export function openPalette({ commands, tabs, recent, format }) {
  if (open) { open.input.focus(); return; }
  const input = el("input", { type: "text", placeholder: tr("pal.placeholder"), spellcheck: false, autocomplete: "off" });
  const list = el("div", { class: "pal-list", role: "listbox" });
  const back = el("div", { class: "pal-back" });
  const box = el("div", { class: "pal", role: "dialog", "aria-label": tr("pal.titolo") },
    el("div", { class: "pal-q", html: '<svg viewBox="0 0 24 24"><path d="M5 7l5 5-5 5M12 17h7"/></svg>' }),
    list,
    el("div", { class: "pal-foot" },
      el("span", {}, el("kbd", {}, "↑"), el("kbd", {}, "↓"), tr("pal.scegli")),
      el("span", {}, el("kbd", {}, keyName("Enter")), tr("pal.esegui")),
      el("span", {}, el("kbd", {}, "Esc"), tr("pal.chiudi"))));
  box.firstChild.append(input);
  back.append(box);
  let items = [], sel = 0;

  function close() {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    open = null;
  }
  function run(it) {
    close();
    try { it.run(); } catch (e) { console.error(e); }
  }

  function render() {
    const q = fold(input.value.trim());
    list.innerHTML = "";
    items = [];
    const group = (title, rows) => {
      if (!rows.length) return;
      list.append(el("div", { class: "pal-grp label" }, title));
      for (const r of rows) {
        const idx = items.length;
        const b = el("button", { class: "pal-it", role: "option", onclick: () => run(r.item), onpointermove: () => { if (sel !== idx) { sel = idx; mark(); } } },
          r.icon, el("span", { class: "tx" }, el("b", {}, marked(r.label, q)), r.sub ? el("small", {}, r.sub) : null), el("span", { class: "k" }, r.keys || ""));
        items.push({ ...r, node: b });
        list.append(b);
      }
    };
    const pick = (arr, text, limit) => arr.map(x => ({ x, s: q ? score(text(x), q) : 0 })).filter(o => o.s >= 0)
      .sort((a, b) => b.s - a.s).slice(0, limit).map(o => o.x);
    const ico = html => el("span", { class: "ii", html });
    const badge = it => { const s = el("span", { class: "ii" }); s.append(it.badge()); return s; };
    const fmt = q ? format(input.value) : null;
    if (fmt) group(tr("pal.formato"), [{ item: fmt, icon: badge(fmt), label: "." + fmt.ext,
      sub: fmt.names ? tr("pal.si_apre_come", fmt.names.join(" · ")) : tr("pal.non_in_elenco") }]);
    group(tr("pal.file_aperti"), pick(tabs, f => f.name, q ? 6 : 4).map(f => ({ item: f, icon: badge(f), label: f.name, sub: f.path })));
    group(tr("pal.comandi"), pick(commands, c => c.label, q ? 12 : 8).map(c => ({ item: c, icon: ico(c.icon), label: c.label, keys: c.keys })));
    group(tr("app.recenti"), pick(recent, f => f.name, q ? 6 : 4).map(f => ({ item: f, icon: badge(f), label: f.name, sub: f.path })));
    if (!items.length) list.append(el("div", { class: "pal-empty" }, tr("pal.nessun_risultato")));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    mark();
  }
  function mark() {
    items.forEach((it, i) => it.node.classList.toggle("on", i === sel));
    items[sel]?.node.scrollIntoView({ block: "nearest" });
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) { sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; mark(); }
    } else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (items[sel]) run(items[sel].item); }
  }
  input.addEventListener("input", () => { sel = 0; render(); });
  back.addEventListener("pointerdown", e => { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(back);
  open = { input };
  render();
  input.focus();
}
