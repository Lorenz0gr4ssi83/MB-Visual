// Clash Detective (come in Navisworks Manage): test di interferenza tra due insiemi di elementi, con schede Regole,
// Selezione, Risultati e Rapporto. Il calcolo gira in un Web Worker (ui/js/clashworker.js + clashcore.js) con avanzamento
// e Interrompi; i test e i risultati (stati, note, assegnatari) stanno nel file .mbvnav (ui/js/navdoc.js).
// N = servizi comuni del pannello (ui/js/navmanage.js).
import { askText, confirmBox, el, toast } from "./core.js";
import { t as tr, fmtDateTime, LOCALE } from "./i18n.js";
import { newTest, uid } from "./navdoc.js";
import { groupClashes, mergeRun, STATUSES } from "./clashcore.js";

const TYPES = ["hard", "clearance", "duplicate"];
const DEF_TOL = { hard: 0.01, clearance: 0.05, duplicate: 0.001 }; // metri
const MODES = ["all", "model", "class", "level", "selection"];
export const stLabel = s => tr("clash.st_" + s);
export const typeLabel = t => tr("clash.tipo_" + t);

export function clashPane(N, box) {
  const { h, THREE } = N;
  const S = { sub: "rules", sel: null, selGroup: null, filter: "", group: true, rest: "ghost", limit: 300, running: null, openGroups: new Set() };
  const tests = () => N.doc.clashTests;
  let test = tests()[0] || null;
  const num = (v, d = 3) => Number(v).toLocaleString(LOCALE, { maximumFractionDigits: d });
  // tolleranze salvate in metri, mostrate nelle unita' della scena
  const toDisp = m => (N.unit === "m" ? m : m * 1000);
  const fromDisp = v => (N.unit === "m" ? v : v / 1000);
  const fmtM = m => (m == null ? "—" : N.unit === "m" ? num(m, 3) + " m" : num(m * 1000, 1) + " mm");
  // punti salvati in coordinate del progetto (metri, Z in alto), come i punti di vista BCF
  const toProject = p => new THREE.Vector3(...p).applyMatrix4(N.br.w2s().invert()).toArray();
  const toScene = p => new THREE.Vector3(...p).applyMatrix4(N.br.w2s());

  // ---------------------------------------------------------------- struttura
  const top = el("div", { class: "nav-bar" });
  const runBar = el("div", { class: "nav-bar" });
  const prog = el("div", { class: "nav-prog", hidden: true });
  const summary = el("div", { class: "nav-summary note" });
  const subs = el("div", { class: "nav-subtabs" });
  const content = el("div", { class: "nav-content" });
  box.append(top, runBar, prog, summary, subs, content);

  function renderTop() {
    top.innerHTML = "";
    runBar.innerHTML = "";
    const T = tests();
    const pick = el("select", { class: "nav-grow", title: tr("clash.test_corrente"), onchange: e => { test = T.find(t => t.guid === e.target.value) || null; S.sel = null; renderAll(); } },
      ...T.map(t => el("option", { value: t.guid, selected: t === test }, `${t.name} (${t.clashes.filter(c => c.status !== "resolved").length})`)));
    if (!T.length) pick.append(el("option", { value: "" }, tr("clash.nessun_test")));
    const more = el("select", { title: tr("clash.altre_azioni"), disabled: !test, onchange: e => { const v = e.target.value; e.target.value = ""; if (v) testAction(v); } },
      el("option", { value: "" }, "⋯"), el("option", { value: "rename" }, tr("clash.rinomina")), el("option", { value: "dup" }, tr("clash.duplica")),
      el("option", { value: "compact" }, tr("clash.compatta")), el("option", { value: "reset" }, tr("clash.azzera")), el("option", { value: "del" }, tr("clash.elimina_test")));
    top.append(pick, el("button", { class: "btn", onclick: addTest, title: tr("clash.nuovo_test_titolo") }, tr("clash.nuovo")), more);
    const running = !!S.running;
    runBar.append(...[
      el("button", { class: "btn primary", disabled: !test || running, onclick: () => run([test]), title: tr("clash.esegui_titolo") }, "▶ " + tr("clash.esegui")),
      el("button", { class: "btn", disabled: tests().length < 2 || running, onclick: () => run(tests()), title: tr("clash.esegui_tutti_titolo") }, tr("clash.esegui_tutti")),
      el("span", { style: { flex: 1 } }),
      running ? el("button", { class: "btn danger", onclick: () => S.running?.cancel() }, tr("clash.interrompi")) : null].filter(Boolean));
    renderSummary();
  }
  function renderSummary() {
    summary.innerHTML = "";
    if (!test) return;
    const c = test.clashes, cnt = s => c.filter(x => x.status === s).length;
    const tol = test.type === "clearance" ? tr("clash.distanza_0", fmtM(test.tolerance)) : tr("clash.tolleranza_0", fmtM(test.tolerance));
    summary.append(el("div", {}, el("b", {}, typeLabel(test.type)), " · ", tol, " · ",
      test.lastRun ? tr("clash.ultima_esecuzione_0", fmtDateTime(test.lastRun)) : tr("clash.mai_eseguito")));
    if (test.lastRun) summary.append(el("div", { class: "nav-counts" },
      el("span", {}, tr("clash.0_interferenze", c.length)),
      ...STATUSES.map(s => cnt(s) ? el("span", { class: "nav-st st-" + s }, `${stLabel(s)} ${cnt(s)}`) : null)));
  }
  function renderSubs() {
    subs.innerHTML = "";
    for (const [k, label] of [["rules", tr("clash.regole")], ["select", tr("clash.selezione")], ["results", tr("clash.risultati")], ["report", tr("clash.rapporto")]])
      subs.append(el("button", { class: "nav-sub" + (S.sub === k ? " on" : ""), disabled: !test, onclick: () => { S.sub = k; renderSubs(); renderContent(); } }, label));
  }
  function renderContent() {
    content.innerHTML = "";
    if (!test) {
      content.append(el("div", { class: "nav-empty" }, el("p", {}, tr("clash.nessun_test_spiegazione")),
        el("button", { class: "btn primary", onclick: addTest }, tr("clash.aggiungi_test"))));
      return;
    }
    if (S.sub === "rules") rules();
    else if (S.sub === "select") selection();
    else if (S.sub === "results") results();
    else report();
  }
  function renderAll() { renderTop(); renderSubs(); renderContent(); }

  // ---------------------------------------------------------------- test
  async function addTest() {
    const name = await askText(tr("clash.nuovo_test"), tr("clash.nome_test"), tr("clash.test_n", tests().length + 1));
    if (name === null) return;
    const t = newTest(name.trim() || tr("clash.test_n", tests().length + 1));
    // con piu' modelli: proposta tipica di Navisworks, primo modello contro gli altri
    const names = h.partNames();
    if (names.length > 1) { t.setA = { mode: "model", values: [names[0]], items: [] }; t.setB = { mode: "model", values: names.slice(1), items: [] }; }
    tests().push(t);
    test = t;
    S.sub = names.length > 1 ? "rules" : "select";
    N.changed();
    renderAll();
  }
  async function testAction(v) {
    if (v === "rename") {
      const n = await askText(tr("clash.rinomina"), tr("clash.nome_test"), test.name);
      if (n?.trim()) { test.name = n.trim(); N.changed(); renderTop(); }
    } else if (v === "dup") {
      const t = JSON.parse(JSON.stringify(test));
      Object.assign(t, { guid: uid(), name: test.name + " (2)", clashes: [], lastRun: "", stats: null });
      tests().push(t);
      test = t;
      N.changed();
      renderAll();
    } else if (v === "compact") {
      const n = test.clashes.filter(c => c.status === "resolved").length;
      test.clashes = test.clashes.filter(c => c.status !== "resolved");
      toast(tr("clash.tolte_0_risolte", n));
      N.changed();
      renderAll();
    } else if (v === "reset") {
      if (!(await confirmBox(tr("clash.azzera"), tr("clash.azzera_domanda", test.name), tr("clash.azzera"), true))) return;
      Object.assign(test, { clashes: [], lastRun: "", stats: null });
      N.changed();
      renderAll();
    } else if (v === "del") {
      if (!(await confirmBox(tr("clash.elimina_test"), tr("clash.eliminare_test_0", test.name), tr("common.elimina"), true))) return;
      tests().splice(tests().indexOf(test), 1);
      test = tests()[0] || null;
      N.clearHighlight();
      N.changed();
      renderAll();
    }
  }

  // ---------------------------------------------------------------- Regole
  function rules() {
    const t = test;
    const field = (label, input, note) => el("label", { class: "nav-field" }, el("span", {}, label), input, note ? el("small", { class: "note" }, note) : null);
    const type = el("select", {}, ...TYPES.map(k => el("option", { value: k, selected: t.type === k }, typeLabel(k))));
    const tol = el("input", { type: "number", min: "0", step: N.unit === "m" ? "0.001" : "1", value: String(+toDisp(t.tolerance).toFixed(6)) });
    const same = el("input", { type: "checkbox", checked: t.skipSameModel });
    const grp = el("input", { type: "number", min: "0", step: N.unit === "m" ? "0.1" : "100", value: String(+toDisp(t.groupRadius || 0).toFixed(6)) });
    const tolLabel = () => tr("clash.tol_" + type.value, N.unit);
    const lab = el("span", {}, tolLabel());
    type.addEventListener("change", () => {
      const old = t.type;
      t.type = type.value;
      if (Math.abs(t.tolerance - DEF_TOL[old]) < 1e-12) { t.tolerance = DEF_TOL[t.type]; tol.value = String(+toDisp(t.tolerance).toFixed(6)); }
      lab.textContent = tolLabel();
      N.changed();
      renderTop();
    });
    tol.addEventListener("change", () => { t.tolerance = Math.max(0, fromDisp(+tol.value || 0)); N.changed(); renderSummary(); });
    same.addEventListener("change", () => { t.skipSameModel = same.checked; N.changed(); });
    grp.addEventListener("change", () => { t.groupRadius = Math.max(0, fromDisp(+grp.value || 0)); N.changed(); });
    content.append(
      field(tr("clash.tipo"), type, tr("clash.tipo_nota_" + t.type)),
      el("label", { class: "nav-field" }, lab, tol),
      el("label", { class: "nav-chk" }, same, tr("clash.ignora_stesso_modello")),
      field(tr("clash.raggruppa_entro", N.unit), grp, tr("clash.raggruppa_nota")),
      el("p", { class: "note" }, tr("clash.regole_nota")));
    type.addEventListener("change", () => { content.querySelector(".nav-field small").textContent = tr("clash.tipo_nota_" + t.type); });
  }

  // ---------------------------------------------------------------- Selezione (insiemi A e B)
  function selection() {
    const ifc = !!h.info.ifc;
    const col = (key, set) => {
      const wrap = el("div", { class: "nav-set" });
      const head = el("div", { class: "nav-sethead" }, el("b", {}, key === "A" ? tr("clash.insieme_a") : tr("clash.insieme_b")),
        el("span", { class: "nav-swatch " + (key === "A" ? "a" : "b") }));
      const mode = el("select", {}, ...MODES.filter(m => (m !== "level" || ifc) && (m !== "model" || h.partNames().length > 1 || set.mode === "model"))
        .map(m => el("option", { value: m, selected: set.mode === m }, tr("clash.modo_" + m))));
      const area = el("div", { class: "nav-setarea" });
      const count = el("div", { class: "note nav-setcount" });
      const upd = () => { count.textContent = tr("clash.0_elementi", N.unitsOf(set).length.toLocaleString(LOCALE)); };
      function draw() {
        area.innerHTML = "";
        if (set.mode === "all") area.append(el("p", { class: "note" }, tr("clash.tutti_nota")));
        else if (set.mode === "selection") {
          area.append(el("div", { class: "nav-bar" },
            el("button", { class: "btn", onclick: () => { set.items = N.selectionKeys(); if (!set.items.length) toast(tr("clash.selezione_vuota"), true); N.changed(); upd(); } }, tr("clash.usa_selezione")),
            el("button", { class: "btn", disabled: !set.items.length, onclick: () => { const u = N.unitsOf(set); h.select(u.map(r => r.obj)); h.zoomTo(u.map(r => r.obj)); } }, tr("clash.mostra"))));
        } else {
          const ch = N.choices(set.mode);
          const vals = new Set(set.values);
          const q = el("input", { type: "search", placeholder: tr("clash.filtra") });
          const list = el("div", { class: "nav-checks" });
          const rows = ch.map(({ v, n }) => {
            const cb = el("input", { type: "checkbox", checked: vals.has(v) });
            cb.addEventListener("change", () => { if (cb.checked) vals.add(v); else vals.delete(v); set.values = [...vals]; N.changed(); upd(); });
            const r = el("label", { class: "nav-chk" }, cb, el("span", { class: "nav-grow" }, v), el("span", { class: "note" }, n.toLocaleString(LOCALE)));
            r.dataset.v = v.toLowerCase();
            list.append(r);
            return [r, cb, v];
          });
          q.addEventListener("input", () => { const s = q.value.trim().toLowerCase(); for (const [r] of rows) r.hidden = !!s && !r.dataset.v.includes(s); });
          const all = on => { for (const [r, cb, v] of rows) if (!r.hidden) { cb.checked = on; if (on) vals.add(v); else vals.delete(v); } set.values = [...vals]; N.changed(); upd(); };
          area.append(el("div", { class: "nav-bar" }, q, el("button", { class: "nav-link", onclick: () => all(true) }, tr("clash.tutti")), el("button", { class: "nav-link", onclick: () => all(false) }, tr("clash.nessuno"))), list);
          if (!ch.length) area.append(el("p", { class: "note" }, tr("clash.nessuna_scelta")));
        }
        upd();
      }
      mode.addEventListener("change", () => { set.mode = mode.value; set.values = []; N.changed(); draw(); });
      wrap.append(head, mode, area, count);
      draw();
      return wrap;
    };
    content.append(col("A", test.setA),
      el("div", { class: "nav-swap" }, el("button", { class: "btn", title: tr("clash.scambia_titolo"), onclick: () => { [test.setA, test.setB] = [test.setB, test.setA]; N.changed(); renderContent(); } }, "⇅ " + tr("clash.scambia"))),
      col("B", test.setB));
  }

  // ---------------------------------------------------------------- esecuzione nel Web Worker
  function setProgress(p, msg) {
    prog.hidden = false;
    prog.innerHTML = "";
    prog.append(el("div", { class: "nav-progbar" }, el("span", { style: { width: Math.round(p * 100) + "%" } })), el("div", { class: "note" }, msg));
  }
  async function run(list) {
    if (S.running) return;
    await N.ready();
    N.clearHighlight();
    for (const t of list) {
      const ok = await runOne(t);
      if (!ok) break;
    }
    S.running = null;
    prog.hidden = true;
    renderAll();
  }
  async function runOne(t) {
    const A = N.unitsOf(t.setA), B = N.unitsOf(t.setB);
    if (!A.length || !B.length) { toast(tr("clash.insieme_vuoto", t.name, !A.length ? "A" : "B"), true, 5000); return false; }
    const inA = new Set(A), inB = new Set(B);
    const all = [...new Set([...A, ...B])];
    const worker = new Worker(new URL("./clashworker.js", import.meta.url), { type: "module" });
    let finish;
    const done = new Promise(r => (finish = r));
    let cancelled = false;
    S.running = { cancel() { cancelled = true; worker.terminate(); finish(null); } };
    renderTop();
    worker.onmessage = ev => {
      const m = ev.data;
      if (m.kind === "progress") setProgress(0.3 + 0.7 * m.p, tr("clash.verifica_0_1_2", t.name, m.pairs.toLocaleString(LOCALE), m.found.toLocaleString(LOCALE)));
      else if (m.kind === "done") finish(m);
      else if (m.kind === "error") { toast(tr("clash.errore_verifica", m.message), true, 8000); finish(null); }
    };
    worker.onerror = e => { toast(tr("clash.errore_verifica", e.message || "worker"), true, 8000); finish(null); };
    // geometria a blocchi (l'interfaccia resta viva anche con modelli grandi)
    const t0 = performance.now();
    let batch = [], transfer = [], tri = 0, last = 0;
    for (let i = 0; i < all.length; i++) {
      if (cancelled) return false;
      const rec = all[i];
      const g = N.geometryOf(rec);
      batch.push({ id: i + 1, pos: g.pos, idx: g.idx, model: rec.model, inA: inA.has(rec), inB: inB.has(rec) });
      transfer.push(g.pos.buffer, g.idx.buffer);
      tri += g.idx.length / 3;
      if (tri > 150000 || batch.length >= 400 || i === all.length - 1) {
        worker.postMessage({ cmd: "add", els: batch }, transfer);
        batch = []; transfer = []; tri = 0;
      }
      if (performance.now() - last > 120) {
        last = performance.now();
        setProgress(0.3 * (i / all.length), tr("clash.preparazione_0_1", (i + 1).toLocaleString(LOCALE), all.length.toLocaleString(LOCALE)));
        await new Promise(r => setTimeout(r, 0));
      }
    }
    if (cancelled) return false;
    worker.postMessage({ cmd: "run", opts: { type: t.type, tolerance: t.tolerance / N.mpu, skipSameModel: t.skipSameModel, maxResults: 20000 } });
    const r = await done;
    worker.terminate();
    if (!r) { if (cancelled) toast(tr("clash.interrotto")); return false; }
    // risultati: chiavi stabili degli elementi, punti in coordinate del progetto, distanze in metri
    const info = rec => ({ key: N.keyOf(rec), name: N.nameOf(rec), cls: rec.cls, model: N.modelName(rec), level: N.levelOf(rec) });
    const found = r.results.map(x => {
      const a = all[x.a - 1], b = all[x.b - 1];
      const ia = info(a), ib = info(b);
      return { key: [ia.key, ib.key].sort().join("|"), dist: x.dist * N.mpu, point: toProject(x.point), a: ia, b: ib, _p: x.point };
    });
    const groups = t.groupRadius > 0 ? groupClashes(found.map(f => f._p), t.groupRadius / N.mpu) : null;
    found.forEach((f, i) => { f.group = groups && groups[i] >= 0 ? groups[i] + 1 : null; delete f._p; });
    const now = new Date().toISOString();
    t.clashes = mergeRun(t.clashes, found, now).map(c => (c.status === "resolved" ? { ...c, group: null } : c));
    t.lastRun = now;
    t.stats = { candidates: r.candidates, elements: r.elements, ms: Math.round(performance.now() - t0) };
    if (r.results.length >= 20000) toast(tr("clash.troppe_interferenze"), true, 8000);
    N.changed();
    if (t === test) { S.sub = "results"; S.sel = null; }
    toast(tr("clash.finito_0_1_2", t.name, found.length.toLocaleString(LOCALE), (t.stats.ms / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })));
    return true;
  }

  // ---------------------------------------------------------------- Risultati
  const recsOf = c => [N.byKey(c.a.key), N.byKey(c.b.key)];
  function focusClashes(list, primary, snap = false) {
    const As = [], Bs = [];
    const fb = new THREE.Box3();
    let small = Infinity;
    for (const c of list) {
      const [a, b] = recsOf(c);
      if (a) As.push(a);
      if (b) Bs.push(b);
      const pt = toScene(c.point);
      const ba = a ? N.boxOf([a]) : new THREE.Box3(), bb = b ? N.boxOf([b]) : new THREE.Box3();
      const inter = ba.clone().intersect(bb);
      if (!inter.isEmpty()) fb.union(inter); else fb.expandByPoint(pt);
      // sezione dell'elemento piu' sottile (seconda dimensione dell'ingombro): misura della zona da mostrare
      for (const x of [ba, bb]) if (!x.isEmpty()) { const v = x.getSize(new THREE.Vector3()).toArray().sort((p, q) => p - q); small = Math.min(small, v[1]); }
    }
    if (!As.length && !Bs.length) { toast(tr("clash.elementi_non_trovati"), true); return; }
    if (!isFinite(small) || small <= 0) small = 1;
    const fsz = fb.getSize(new THREE.Vector3()).length();
    // contesto attorno all'interferenza: qualche volta la sezione dell'elemento piu' sottile, almeno un 2% del modello
    // (senza superare 6 sezioni: nei modelli grandi l'inquadratura resta vicina)
    N._size ??= N.boxOf(N.index().units).getSize(new THREE.Vector3()).length();
    fb.expandByScalar(Math.max(small * 2, fsz * 0.6, Math.min(N._size * 0.02, small * 6), 1e-3));
    const pt = primary ? toScene(primary.point) : fb.getCenter(new THREE.Vector3());
    N.highlight(As, Bs, { rest: S.rest, point: pt.toArray(), size: Math.max(fb.getSize(new THREE.Vector3()).length() * 0.035, 1e-4) });
    N.focusBox(fb, 1.3, !snap);
  }
  N.focusClash = (c, snap) => focusClashes([c], c, snap); // per il rapporto e il BCF (snap: immagine senza tener conto del pannello)
  function visibleClashes() {
    return test.clashes.filter(c => !S.filter || c.status === S.filter);
  }
  function results() {
    const t = test;
    if (!t.lastRun) { content.append(el("p", { class: "nav-empty" }, tr("clash.esegui_per_risultati"))); return; }
    const filt = el("select", { onchange: e => { S.filter = e.target.value; S.limit = 300; drawList(); } },
      el("option", { value: "" }, tr("clash.tutti_stati")), ...STATUSES.map(s => el("option", { value: s, selected: S.filter === s }, stLabel(s))));
    const grp = el("input", { type: "checkbox", checked: S.group });
    grp.addEventListener("change", () => { S.group = grp.checked; drawList(); });
    const rest = el("select", { title: tr("clash.resto_titolo"), onchange: e => { S.rest = e.target.value; const c = cur(); if (c) focusClashes([c], c); } },
      ...[["ghost", tr("clash.resto_trasparente")], ["hide", tr("clash.resto_nascosto")], ["normal", tr("clash.resto_normale")]].map(([v, l]) => el("option", { value: v, selected: S.rest === v }, l)));
    const hasGroups = t.clashes.some(c => c.group);
    content.append(el("div", { class: "nav-bar" }, filt, hasGroups ? el("label", { class: "nav-chk" }, grp, tr("clash.gruppi")) : null, el("span", { style: { flex: 1 } }), rest),
      el("div", { class: "nav-legend note" }, el("span", { class: "nav-swatch a" }), tr("clash.elemento_1"), el("span", { class: "nav-swatch b" }), tr("clash.elemento_2")));
    const list = el("div", { class: "nav-results", tabindex: "0" });
    const detail = el("div", { class: "nav-detail" });
    content.append(list, detail);
    list.addEventListener("keydown", e => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const flat = visibleClashes();
      const i = flat.findIndex(c => c.key === S.sel);
      const n = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (n) pickClash(n);
    });
    const cur = () => t.clashes.find(c => c.key === S.sel) || null;
    function statusSel(value, onchange) {
      const s = el("select", { class: "nav-stsel st-" + value, onclick: e => e.stopPropagation() }, ...STATUSES.map(x => el("option", { value: x, selected: x === value }, stLabel(x))));
      s.addEventListener("change", () => { s.className = "nav-stsel st-" + s.value; onchange(s.value); N.changed(); renderSummary(); });
      return s;
    }
    function row(c) {
      const r = el("div", { class: "nav-res" + (c.key === S.sel ? " sel" : "") + (c.group && S.group ? " child" : "") },
        el("div", { class: "nav-res1" }, statusSel(c.status, v => { c.status = v; }), el("b", {}, tr("clash.interferenza_n", c.num)),
          el("span", { class: "nav-grow" }), el("span", { class: "nav-dist" }, fmtM(c.dist))),
        el("div", { class: "nav-res2 note" }, el("span", { class: "nav-swatch a" }), el("span", { class: "nav-ell" }, c.a.name), el("span", { class: "nav-swatch b" }), el("span", { class: "nav-ell" }, c.b.name)));
      r.addEventListener("click", () => pickClash(c));
      r.dataset.key = c.key;
      return r;
    }
    function drawList() {
      list.innerHTML = "";
      const flat = visibleClashes();
      if (!flat.length) { list.append(el("p", { class: "nav-empty" }, t.clashes.length ? tr("clash.nessuna_con_filtro") : tr("clash.nessuna_interferenza"))); return; }
      let shown = 0;
      const byGroup = new Map();
      if (S.group) for (const c of flat) if (c.group) { if (!byGroup.has(c.group)) byGroup.set(c.group, []); byGroup.get(c.group).push(c); }
      const done = new Set();
      for (const c of flat) {
        if (shown >= S.limit) break;
        if (S.group && c.group) {
          if (done.has(c.group)) continue;
          done.add(c.group);
          const members = byGroup.get(c.group);
          const open = S.openGroups.has(c.group);
          const gst = members.every(m => m.status === members[0].status) ? members[0].status : "active";
          const g = el("div", { class: "nav-res group" + (S.selGroup === c.group ? " sel" : "") },
            el("div", { class: "nav-res1" },
              el("span", { class: "nav-twist", onclick: e => { e.stopPropagation(); if (open) S.openGroups.delete(c.group); else S.openGroups.add(c.group); drawList(); } }, open ? "▾" : "▸"),
              statusSel(gst, v => { members.forEach(m => (m.status = v)); drawList(); }),
              el("b", {}, tr("clash.gruppo_n", c.group)), el("span", { class: "note" }, tr("clash.0_interferenze", members.length)),
              el("span", { class: "nav-grow" }), el("span", { class: "nav-dist" }, fmtM(Math.max(...members.map(m => m.dist))))));
          g.addEventListener("click", () => { S.sel = null; S.selGroup = c.group; markSel(); focusClashes(members); drawDetail(null, members); });
          list.append(g);
          shown++;
          if (open) for (const m of members) { list.append(row(m)); shown++; }
        } else { list.append(row(c)); shown++; }
      }
      if (shown >= S.limit && flat.length > S.limit) list.append(el("button", { class: "btn nav-more", onclick: () => { S.limit += 500; drawList(); } }, tr("clash.mostra_altre_0", flat.length - S.limit)));
    }
    function markSel() { list.querySelectorAll(".nav-res").forEach(r => r.classList.toggle("sel", !!S.sel && r.dataset.key === S.sel)); }
    function pickClash(c) {
      S.sel = c.key;
      S.selGroup = null;
      if (c.group && S.group && !S.openGroups.has(c.group)) { S.openGroups.add(c.group); drawList(); }
      markSel();
      list.querySelector(".nav-res.sel")?.scrollIntoView({ block: "nearest" });
      focusClashes([c], c);
      drawDetail(c);
    }
    function drawDetail(c, members) {
      detail.innerHTML = "";
      if (members) {
        detail.append(el("div", { class: "nav-dhead" }, el("b", {}, tr("clash.gruppo_n", members[0].group)), el("span", { class: "note" }, tr("clash.0_interferenze", members.length))),
          el("p", { class: "note" }, tr("clash.gruppo_nota")));
        return;
      }
      if (!c) return;
      const [a, b] = recsOf(c);
      const elRow = (label, cls, x, rec) => el("div", { class: "nav-delem" },
        el("span", { class: "nav-swatch " + cls }),
        el("div", { class: "nav-grow" }, el("div", { class: "nav-ell", title: x.name }, el("b", {}, label + ": "), x.name),
          el("div", { class: "note nav-ell" }, [x.cls, x.level, x.model].filter(Boolean).join(" · "))),
        el("button", { class: "nav-link", disabled: !rec, onclick: () => { N.clearHighlight(); h.select([rec.obj]); } }, tr("clash.seleziona")));
      const assigned = el("input", { type: "text", value: c.assigned || "", placeholder: tr("clash.assegnato_a") });
      assigned.addEventListener("change", () => { c.assigned = assigned.value.trim(); N.changed(); });
      const note = el("textarea", { rows: 2, placeholder: tr("clash.nota") }, c.note || "");
      note.addEventListener("change", () => { c.note = note.value; N.changed(); });
      const p = c.point || [0, 0, 0];
      detail.append(
        el("div", { class: "nav-dhead" }, el("b", {}, tr("clash.interferenza_n", c.num)), c.group ? el("span", { class: "note" }, tr("clash.gruppo_n", c.group)) : null, el("span", { class: "nav-grow" }),
          el("span", { class: "nav-st st-" + c.status }, stLabel(c.status))),
        elRow(tr("clash.elemento_1"), "a", c.a, a), elRow(tr("clash.elemento_2"), "b", c.b, b),
        el("dl", { class: "kv nav-kv" },
          el("dt", {}, test.type === "clearance" ? tr("clash.distanza") : test.type === "duplicate" ? tr("clash.scostamento") : tr("clash.compenetrazione")), el("dd", {}, fmtM(c.dist)),
          el("dt", {}, tr("clash.punto")), el("dd", {}, p.map(v => num(v, 3)).join(" ; ") + " m"),
          el("dt", {}, tr("clash.trovata")), el("dd", {}, c.found ? fmtDateTime(c.found) : "—"),
          c.resolvedAt ? el("dt", {}, tr("clash.risolta_il")) : null, c.resolvedAt ? el("dd", {}, fmtDateTime(c.resolvedAt)) : null),
        el("div", { class: "nav-grid2" }, assigned, el("button", { class: "btn", onclick: () => { N.clearHighlight(); h.select([a, b].filter(Boolean).map(r => r.obj)); } }, tr("clash.seleziona_entrambi"))),
        note,
        el("div", { class: "nav-bar" }, el("button", { class: "btn", onclick: () => toBcf([c]), title: tr("clash.crea_segnalazione_titolo") }, tr("clash.crea_segnalazione"))));
    }
    drawList();
    const c = cur();
    if (c) { markSel(); drawDetail(c); }
  }

  // ---------------------------------------------------------------- Rapporto
  function report() {
    const inc = new Set(STATUSES.filter(s => s !== "resolved"));
    const checks = STATUSES.map(s => { const cb = el("input", { type: "checkbox", checked: inc.has(s) }); cb.addEventListener("change", () => (cb.checked ? inc.add(s) : inc.delete(s))); return el("label", { class: "nav-chk" }, cb, el("span", { class: "nav-st st-" + s }, stLabel(s))); });
    const imgs = el("input", { type: "checkbox", checked: true });
    const allTests = el("input", { type: "checkbox", checked: false });
    const pick = () => (allTests.checked ? tests() : [test]).map(t => ({ test: t, clashes: t.clashes.filter(c => inc.has(c.status)) }));
    const go = async kind => {
      const sets = pick();
      const n = sets.reduce((s, x) => s + x.clashes.length, 0);
      if (!n) return toast(tr("clash.nessuna_nel_rapporto"), true);
      const R = await import("./clashreport.js");
      try { await R.makeReport(N, kind, sets, { images: imgs.checked, setProgress, done: () => { prog.hidden = true; } }); }
      catch (e) { console.error(e); toast(tr("clash.rapporto_non_riuscito", e.message), true, 8000); prog.hidden = true; }
    };
    content.append(
      el("div", { class: "nav-field" }, el("span", {}, tr("clash.includi_stati")), el("div", { class: "nav-checkrow" }, ...checks)),
      el("label", { class: "nav-chk" }, imgs, tr("clash.con_immagini")),
      el("label", { class: "nav-chk" }, allTests, tr("clash.tutti_i_test")),
      el("div", { class: "nav-field" }, el("span", {}, tr("clash.formato")), el("div", { class: "nav-bar wrap" },
        el("button", { class: "btn primary", onclick: () => go("html") }, "HTML"),
        el("button", { class: "btn", onclick: () => go("pdf") }, "PDF"),
        el("button", { class: "btn", onclick: () => go("csv") }, "CSV"),
        el("button", { class: "btn", onclick: () => go("bcfzip"), title: tr("clash.bcf_file_titolo") }, "BCF (.bcfzip)"),
        el("button", { class: "btn", onclick: () => go("bcfpanel"), title: tr("clash.bcf_pannello_titolo") }, tr("clash.aggiungi_segnalazioni")))),
      el("p", { class: "note" }, tr("clash.rapporto_nota")));
  }
  async function toBcf(list) {
    const R = await import("./clashreport.js");
    try { await R.makeReport(N, "bcfpanel", [{ test, clashes: list }], { images: true, setProgress, done: () => { prog.hidden = true; } }); }
    catch (e) { console.error(e); toast(tr("clash.rapporto_non_riuscito", e.message), true, 8000); prog.hidden = true; }
  }

  renderAll();
  return {
    reload() { test = tests()[0] || null; S.sel = null; renderAll(); },
    onShow() { renderAll(); },
    dispose() { S.running?.cancel(); },
    get _state() { return { S, test, run, runOne }; }, // collaudo dalla console
  };
}
