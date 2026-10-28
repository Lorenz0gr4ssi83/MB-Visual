// Collaudo dei piani di progetto (ui/js/project): calcolo CPM su casi verificati a mano, calendari e festivi,
// livellamento, lettura/scrittura dei formati e, se ci sono, confronto con i file veri di Microsoft Project.
//   node tests/test_project.mjs [cartella dei campioni]
// Campioni (NON nel repo): %USERPROFILE%\.mbvisual\project-campioni = dati di prova del progetto MPXJ (LGPL, solo per le
// prove: github.com/joniles/mpxj, cartella junit/data, stesso progetto salvato da Project 2003-2019 in .mpp e .xml) +
// gan/HouseBuildingSample.gan (esempio di GanttProject, github.com/bardsoftware/ganttproject).
import fs from "fs";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const M = await imp("ui/js/project/pmodel.js");
const C = await imp("ui/js/project/pcal.js");
const IO = await imp("ui/js/project/pio.js");
const X = await imp("ui/js/project/pxml.js");

let ok = 0, ko = 0;
const check = (name, cond, extra = "") => { if (cond) ok++; else { ko++; console.log("NO  " + name + (extra ? "  " + extra : "")); } };
const D = s => C.parseDate(s);
const iso = m => C.toIso(m, false);

function plan(start = "2026-11-02T08:00") { return M.newProject(D(start)); }
function add(P, name, days, preds = [], extra = {}) { const t = M.newTask(P, { name, dur: Math.round(days * P.mpd), preds, ...extra }); P.tasks.push(t); return t; }

// ---------------------------------------------------------------- 1. CPM di base (lunedi' 2/11/2026)
{
  const P = plan();
  const A = add(P, "A", 5), B = add(P, "B", 3, [{ u: 1, t: 1 }]), Cc = add(P, "C", 2, [{ u: 1, t: 1 }]), Dd = add(P, "D", 1, [{ u: 2, t: 1 }, { u: 3, t: 1 }]);
  const E = add(P, "Fine", 0, [{ u: 4, t: 1 }]);
  const F = add(P, "F", 2, [{ u: 1, t: 3, lag: 960 }]);   // SS + 2g
  const G = add(P, "G", 1, [{ u: 2, t: 0 }]);             // FF
  const H = add(P, "H", 2, [{ u: 1, t: 1, lag: -480 }]);  // FS - 1g (anticipo)
  M.schedule(P);
  check("A 2/11-6/11", iso(A.start) === "2026-11-02T08:00" && iso(A.finish) === "2026-11-06T17:00");
  check("B dopo A (lunedi' 9)", iso(B.start) === "2026-11-09T08:00" && iso(B.finish) === "2026-11-11T17:00");
  check("C margine 1g", Cc.ts === 480 && Cc.fs === 480 && !Cc.crit);
  check("D critica giovedi' 12", iso(Dd.start) === "2026-11-12T08:00" && Dd.crit);
  check("cardine alla fine di D", iso(E.start) === "2026-11-12T17:00" && M.isMilestone(E));
  check("SS+2g -> mercoledi' 4", iso(F.start) === "2026-11-04T08:00", iso(F.start));
  check("FF -> fine con B", G.finish === B.finish);
  check("FS-1g -> venerdi' 6", iso(H.start) === "2026-11-06T08:00", iso(H.start));
  check("percorso critico A-B-D", A.crit && B.crit && Dd.crit && !F.crit);
}
// ---------------------------------------------------------------- 2. riepiloghi, vincoli, scadenze, calendari
{
  const P = plan();
  const S = add(P, "Fase", 0, [], { lvl: 1 });
  const a = add(P, "a", 2, [], { lvl: 2 }), b = add(P, "b", 3, [{ u: 2, t: 1 }], { lvl: 2 });
  const c = add(P, "c", 1, [{ u: 1, t: 1 }], { lvl: 1 }); // collegata al riepilogo
  const d = add(P, "d", 2, [], { lvl: 1, ct: 4, cd: D("2026-11-18T08:00") }); // inizio non prima del 18
  const e = add(P, "e", 1, [], { lvl: 1, ct: 2, cd: D("2026-11-20T08:00") }); // inizio obbligatorio
  const f = add(P, "f", 10, [], { lvl: 1, dl: D("2026-11-10T17:00") });
  M.schedule(P);
  check("riepilogo dalle figlie", S.sum && S.start === a.start && S.finish === b.finish && S.dur === 5 * 480);
  check("successore del riepilogo", iso(c.start) === "2026-11-09T08:00");
  check("SNET", iso(d.start) === "2026-11-18T08:00");
  check("MSO", iso(e.start) === "2026-11-20T08:00");
  check("scadenza superata", f.late === true && f.ts < 0 && f.crit);
  // festivi italiani: 2026 -> Pasquetta 6/4, 8/12 martedi'
  check("Pasqua 2026", C.toDay(C.easter(2026)) === "2026-04-05");
  check("Pasqua 2027", C.toDay(C.easter(2027)) === "2027-03-28");
  const Q = plan("2026-12-07T08:00");
  M.addItalianHolidays(Q, Q.cal, 2026, 2027);
  const x = add(Q, "x", 3);
  M.schedule(Q);
  check("salta l'Immacolata (8/12)", iso(x.finish) === "2026-12-10T17:00", iso(x.finish));
  const y = add(Q, "y", 2, [{ u: 1, t: 1 }]);
  const z = add(Q, "z", 6, [{ u: 2, t: 1 }]);
  M.schedule(Q);
  check("Natale e Santo Stefano non lavorativi", iso(z.finish) === "2026-12-22T17:00" && !Q.calendars[0].exc.every(e => e.work.length));
  const cal = new C.WorkCal({ week: C.STD_WEEK(), exc: [] });
  check("ore lavorative tra lunedi' 8 e martedi' 17", cal.between(D("2026-11-02T08:00"), D("2026-11-03T17:00")) === 960);
  check("aggiunta lavoro oltre il fine settimana", iso(cal.add(D("2026-11-06T13:00"), 480)) === "2026-11-09T12:00");
  check("sottrazione lavoro", iso(cal.sub(D("2026-11-09T12:00"), 480)) === "2026-11-06T13:00");
  // durata trascorsa (1 giorno di calendario)
  const R = plan("2026-11-06T08:00");
  const el = add(R, "el", 0, [], { dur: 1440 * 2, du: "ed" });
  M.schedule(R);
  check("durata trascorsa 2gt", iso(el.finish) === "2026-11-08T08:00");
}
// ---------------------------------------------------------------- 3. durate e predecessori come testo
{
  const P = plan();
  check("5g", M.parseDuration(P, "5g").dur === 2400 && M.parseDuration(P, "5g").du === "d");
  check("2,5 h", M.parseDuration(P, "2,5 h").dur === 150);
  check("1s = settimana", M.parseDuration(P, "1s").dur === 2400 && M.parseDuration(P, "1w").du === "w");
  check("3gt trascorsi", M.parseDuration(P, "3egg")?.du === "ed" || M.parseDuration(P, "3ed").dur === 4320);
  check("stimata", M.parseDuration(P, "4g?").est === true);
  add(P, "a", 1); add(P, "b", 1); add(P, "c", 1, [{ u: 1, t: 1 }, { u: 2, t: 3, lag: 960, lu: "d" }]);
  M.schedule(P);
  check("testo predecessori", M.predsText(P, P.tasks[2]) === "1;2SS+2d", M.predsText(P, P.tasks[2]));
  const ps = M.parsePreds(P, "1FS+2d;2FF-1d;1SS+50%");
  check("lettura predecessori", ps.length === 3 && ps[0].lag === 960 && ps[1].t === 0 && ps[1].lag === -480 && ps[2].pc === 50);
}
// ---------------------------------------------------------------- 4. risorse, costi, sovrallocazione, livellamento
{
  const P = plan();
  P.resources.push({ uid: 1, name: "Mario", type: "work", max: 1, rate: 30, use: 0 }, { uid: 2, name: "Cemento", type: "material", rate: 100, use: 0, label: "m3" });
  const a = add(P, "a", 5), b = add(P, "b", 5);
  P.assignments.push({ uid: 1, task: a.uid, res: 1, units: 1 }, { uid: 2, task: b.uid, res: 1, units: 1 }, { uid: 3, task: a.uid, res: 2, units: 4 });
  M.schedule(P);
  check("costo lavoro + materiale", Math.abs(a.cost - (40 * 30 + 400)) < 1e-6, a.cost);
  check("lavoro della risorsa", P.resources[0].work === 4800);
  const us = M.resourceUsage(P);
  check("sovrallocata", us.over.has(1));
  const n = M.level(P);
  check("livellamento sposta b dopo a", n === 1 && b.start >= a.finish && !M.resourceUsage(P).over.size, `${iso(a.finish)} ${iso(b.start)}`);
  M.setBaseline(P);
  check("linea di base", P.tasks.every(t => t.bl[0].start === t.start));
}
// ---------------------------------------------------------------- 5. scrittura e rilettura dei formati (piano creato qui)
{
  const P = plan();
  P.name = "Prova àèìòù";
  add(P, "Fase 1", 0, [], { lvl: 1 });
  add(P, "Scavi & fondazioni", 4, [], { lvl: 2, notes: "nota <con> caratteri" });
  add(P, "Getto", 2, [{ u: 2, t: 1, lag: 480, lu: "d" }], { lvl: 2, pct: 50 });
  add(P, "Collaudo", 0, [{ u: 3, t: 1 }], { lvl: 1, ms: true });
  P.resources.push({ uid: 1, name: "Squadra A", type: "work", max: 1, rate: 45, use: 0 });
  P.assignments.push({ uid: 1, task: 2, res: 1, units: 0.5 });
  M.addItalianHolidays(P, P.cal, 2026, 2027);
  M.schedule(P);
  const ref = P.tasks.map(t => [t.name, t.lvl, t.start, t.finish, t.preds.length]).join("|");
  for (const [ext, w] of [["xml", IO.writeMspdi], ["mpx", IO.writeMpx], ["gan", IO.writeGan]]) {
    const R = IO.readProject(new TextEncoder().encode(w(P)), ext);
    const got = R.tasks.map(t => [t.name, t.lvl, t.start, t.finish, t.preds.length]).join("|");
    check(`${ext}: attivita' e date uguali`, got === ref, `\n  ${ref}\n  ${got}`);
    check(`${ext}: risorse e assegnazioni`, R.resources.length === 1 && R.assignments.length === 1 && Math.abs(R.assignments[0].units - 0.5) < 1e-9);
    if (ext !== "gan") check(`${ext}: note`, R.tasks[1].notes === "nota <con> caratteri");
    check(`${ext}: festivi`, R.calendars[0].exc.length >= 24, R.calendars[0].exc.length);
  }
  const x = IO.writeMspdi(P);
  check("XML ben formato", X.parseXml(x).c.length === 1 && /^<\?xml/.test(x));
}
// ---------------------------------------------------------------- 6. file veri (se presenti)
const SAMPLES = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME || "", ".mbvisual", "project-campioni");
if (fs.existsSync(SAMPLES)) {
  const files = [];
  const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(xml|mpx|xer|pmxml|gan)$/i.test(f) && !/pom|build/.test(f)) files.push(p); } };
  walk(SAMPLES);
  let read = 0, fail = 0, same = 0, tot = 0, lossless = 0, lossTot = 0;
  const COMPUTED = new Set("EarlyStart EarlyFinish LateStart LateFinish FreeSlack TotalSlack Cost Work ID WBS OutlineNumber Start Finish Duration DurationFormat Work Critical EarlyStart EarlyFinish LateStart LateFinish FreeSlack TotalSlack Cost Summary Milestone Estimated IsNull LevelingDelay LevelingDelayFormat CalendarUID Active Manual ManualStart ManualFinish ManualDuration ConstraintDate Priority FixedCost PercentComplete ActualStart ActualFinish Deadline Notes Name OutlineLevel UID ConstraintType".split(" "));
  for (const f of files) {
    const bytes = new Uint8Array(fs.readFileSync(f));
    const ext = path.extname(f).slice(1).toLowerCase();
    let P;
    try { P = IO.readProject(bytes, ext); read++; } catch (e) { fail++; console.log("illeggibile", path.basename(f), e.message); continue; }
    if (P.src !== "mspdi") continue;
    // calcolo: date uguali a quelle salvate da Project (file coerenti: inizio progetto <= attivita')
    const src = IO.readMspdi(IO.decode(bytes));
    const saved = new Map(src.tasks.map(t => [t.uid, [t.start, t.finish]]));
    if (Math.min(...[...saved.values()].map(v => v[0] ?? Infinity)) >= src.start) {
      M.schedule(src);
      for (const t of src.tasks) { if (t.isNull || t.manual) continue; const s = saved.get(t.uid); if (s[0] == null) continue; tot++; if (s[0] === t.start && s[1] === t.finish) same++; }
    }
    // senza perdite: gli elementi non gestiti di ogni attivita' tornano identici
    const out = X.parseXml(IO.writeMspdi(P));
    const orig = X.parseXml(IO.decode(bytes));
    const tasksOf = doc => new Map(X.kids(X.kid(X.kids(doc).find(n => X.local(n.n) === "Project"), "Tasks"), "Task").map(n => [X.val(n, "UID"), n]));
    const A = tasksOf(orig), B = tasksOf(out);
    // ogni elemento non gestito dell'originale si ritrova, con lo stesso contenuto, nell'attivita' riscritta
    const kept = (n, b) => X.kids(n).every(k => { const nm = X.local(k.n); if (COMPUTED.has(nm) || nm === "PredecessorLink" || nm === "Baseline") return true; return X.kids(b).some(z => X.local(z.n) === nm && X.text(z) === X.text(k)); });
    for (const [u, n] of A) { lossTot++; if (B.has(u) && kept(n, B.get(u))) lossless++; }
  }
  console.log(`file veri: ${read} letti, ${fail} illeggibili; date calcolate uguali a Project ${same}/${tot} (${(100 * same / Math.max(1, tot)).toFixed(1)}%); attivita' riscritte senza perdite ${lossless}/${lossTot}`);
  check("file veri tutti letti", fail === 0);
  check("calcolo come Project (>= 97%)", same / Math.max(1, tot) >= 0.97);
  check("XML senza perdite (>= 99%)", lossless / Math.max(1, lossTot) >= 0.99);
} else console.log("(campioni non trovati: saltata la prova sui file veri)");

console.log(`\n${ok} prove riuscite, ${ko} fallite`);
process.exit(ko ? 1 : 0);
