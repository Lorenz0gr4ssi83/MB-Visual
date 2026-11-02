// Collaudo delle parti pure della modellazione 3D (senza browser): espressioni, risolutore dei vincoli, regioni.
//   node tests/test_modeler.mjs
import { evalExpr, evalParams } from "../ui/js/modeler/mexpr.js";
import { solve, analyze, measureDim, newSketch, mergePoints } from "../ui/js/modeler/msolver.js";
import { findRegions, matchRegion } from "../ui/js/modeler/mregions.js";

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => { if (cond) pass++; else { fail++; console.log("FALLITA:", name, extra); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// ---- espressioni
ok(near(evalExpr("2*(3+4)"), 14), "espr base");
ok(near(evalExpr("10,5 + 1"), 11.5), "virgola decimale");
ok(near(evalExpr("sin(30)"), 0.5), "seno in gradi");
ok(near(evalExpr("L/2", { L: 80 }), 40), "variabile");
ok(near(evalExpr("2 cm"), 20), "unita'");
ok(near(evalExpr("max(2; 7)"), 7), "funzione con ;");
ok(near(evalExpr("2^3^2"), 512), "potenza a destra");
const pr = evalParams([{ name: "a", expr: "b*2" }, { name: "b", expr: "5" }, { name: "c", expr: "c+1" }]);
ok(pr.vals.a === 10 && pr.errs.c, "parametri con dipendenze e ciclo");

// ---- risolutore: rettangolo con quote
function rect(w, h) {
  const sk = newSketch();
  const P = { a: [0, 0], b: [w + 3, 1], c: [w + 2, h - 2], d: [-1, h + 1] };
  for (const [k, [x, y]] of Object.entries(P)) sk.pts[k] = { x, y };
  sk.ents.push({ id: "l1", t: "line", p1: "a", p2: "b" }, { id: "l2", t: "line", p1: "b", p2: "c" }, { id: "l3", t: "line", p1: "c", p2: "d" }, { id: "l4", t: "line", p1: "d", p2: "a" });
  sk.cons.push({ id: "c1", t: "hor", e: "l1" }, { id: "c2", t: "hor", e: "l3" }, { id: "c3", t: "ver", e: "l2" }, { id: "c4", t: "ver", e: "l4" });
  return sk;
}
let sk = rect(100, 50);
let r = solve(sk);
ok(r.ok, "rettangolo H/V risolto", JSON.stringify(r));
ok(near(sk.pts.a.y, sk.pts.b.y, 1e-9) && near(sk.pts.b.x, sk.pts.c.x, 1e-9), "rettangolo: lati orizzontali e verticali");
let an = analyze(sk);
ok(an.dof === 4, "rettangolo libero: 4 gradi di liberta'", an.dof);
sk.cons.push({ id: "d1", t: "len", e: "l1", v: 80 }, { id: "d2", t: "len", e: "l2", v: 30 });
sk.pts.a.fix = true;
r = solve(sk);
ok(r.ok && near(Math.abs(sk.pts.b.x - sk.pts.a.x), 80) && near(Math.abs(sk.pts.c.y - sk.pts.b.y), 30), "quote pilotanti", JSON.stringify(sk.pts));
an = analyze(sk);
ok(an.dof === 0 && an.free.size === 0, "rettangolo completamente definito", an.dof);
// quota cambiata: si ricalcola
sk.cons.find(c => c.id === "d1").v = 120;
r = solve(sk);
ok(r.ok && near(Math.abs(sk.pts.b.x - sk.pts.a.x), 120), "quota cambiata");
// vincolo in conflitto
sk.cons.push({ id: "x", t: "len", e: "l3", v: 10 });
r = solve(sk);
ok(!r.ok && r.bad.length, "conflitto riconosciuto");
sk.cons.pop();
ok(solve(sk).ok, "conflitto tolto");

// cerchio tangente a una linea, uguale a un altro, concentrico
sk = newSketch();
Object.assign(sk.pts, { a: { x: 0, y: 0, fix: true }, b: { x: 100, y: 0, fix: true }, c: { x: 30, y: 25 }, d: { x: 70, y: 18 } });
sk.ents.push({ id: "l", t: "line", p1: "a", p2: "b" }, { id: "k1", t: "circle", c: "c", r: 10 }, { id: "k2", t: "circle", c: "d", r: 5 });
sk.cons.push({ id: "t", t: "tan", e1: "l", e2: "k1", s: 1 }, { id: "q", t: "equal", e1: "k1", e2: "k2" }, { id: "dd", t: "dia", e: "k1", v: 30 });
r = solve(sk);
const k1 = sk.ents[1], k2 = sk.ents[2];
ok(r.ok && near(k1.r, 15) && near(k2.r, 15) && near(sk.pts.c.y, 15), "tangente + uguale + diametro", JSON.stringify([k1.r, k2.r, sk.pts.c]));
// arco: estremi alla stessa distanza dal centro; angolo tra linee
sk = newSketch();
Object.assign(sk.pts, { o: { x: 0, y: 0, fix: true }, p: { x: 50, y: 0 }, q: { x: 3, y: 40 }, r: { x: 60, y: 10 } });
sk.ents.push({ id: "a", t: "arc", c: "o", p1: "p", p2: "q" }, { id: "l1", t: "line", p1: "o", p2: "p" }, { id: "l2", t: "line", p1: "o", p2: "r" });
sk.cons.push({ id: "h", t: "hor", e: "l1" }, { id: "g", t: "ang", e1: "l1", e2: "l2", v: 30 }, { id: "rr", t: "rad", e: "a", v: 40 });
r = solve(sk);
ok(r.ok && near(Math.hypot(sk.pts.q.x, sk.pts.q.y), 40) && near(measureDim(sk, sk.cons[1]), 30), "arco e angolo", JSON.stringify(sk.pts));
// unione di punti
sk = newSketch();
Object.assign(sk.pts, { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 10.1, y: 0.1 }, d: { x: 10, y: 10 } });
sk.ents.push({ id: "l1", t: "line", p1: "a", p2: "b" }, { id: "l2", t: "line", p1: "c", p2: "d" });
mergePoints(sk, "b", "c");
ok(sk.ents[1].p1 === "b" && !sk.pts.c, "unione dei punti");

// ---- regioni
const lineSk = (segs, circles = []) => {
  const s = newSketch();
  let n = 0;
  const pid = (x, y) => { for (const [k, p] of Object.entries(s.pts)) if (p.x === x && p.y === y) return k; const k = "p" + n++; s.pts[k] = { x, y }; return k; };
  segs.forEach(([x0, y0, x1, y1], i) => s.ents.push({ id: "e" + i, t: "line", p1: pid(x0, y0), p2: pid(x1, y1) }));
  circles.forEach(([x, y, rr], i) => s.ents.push({ id: "c" + i, t: "circle", c: pid(x, y), r: rr }));
  return s;
};
const sq = (x0, y0, x1, y1) => [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
let R = findRegions(lineSk(sq(0, 0, 100, 50)));
ok(R.length === 1 && near(R[0].area, 5000), "rettangolo: una regione", JSON.stringify(R.map(x => x.area)));
R = findRegions(lineSk(sq(0, 0, 100, 50), [[50, 25, 10]]));
const ring = R.find(x => x.holes.length === 1), disc = R.find(x => !x.holes.length);
ok(R.length === 2 && ring && disc && near(ring.area, 5000 - Math.PI * 100, 1e-9) && near(disc.area, Math.PI * 100, 1e-9), "rettangolo con cerchio: anello + disco", JSON.stringify(R.map(x => [x.area, x.holes.length])));
R = findRegions(lineSk([...sq(0, 0, 100, 50), [50, -20, 50, 70]]));
ok(R.length === 2 && R.every(x => near(x.area, 2500)), "linea che taglia: due regioni", JSON.stringify(R.map(x => x.area)));
R = findRegions(lineSk([...sq(0, 0, 60, 60), ...sq(30, 30, 90, 90)]));
ok(R.length === 3 && near(R.reduce((s, x) => s + x.area, 0), 3600 * 2 - 900), "rettangoli sovrapposti: 3 regioni", JSON.stringify(R.map(x => x.area)));
R = findRegions(lineSk([], [[0, 0, 10], [12, 0, 10]]));
ok(R.length === 3, "due cerchi che si intersecano: 3 regioni", R.length);
R = findRegions(lineSk([[0, 0, 10, 0], [10, 0, 10, 10]]));
ok(R.length === 0, "contorno aperto: nessuna regione");
R = findRegions(lineSk([...sq(0, 0, 100, 100), [100, 50, 150, 50]]));
ok(R.length === 1 && near(R[0].area, 10000), "linea pendente ignorata");
// cerchio tangente internamente a un lato
R = findRegions(lineSk(sq(0, 0, 100, 100), [[50, 10, 10]]));
ok(R.length === 2 && near(R.reduce((s, x) => s + x.area, 0), 10000, 1e-9), "cerchio tangente al lato", JSON.stringify(R.map(x => [x.area, x.holes.length])));
// arco + linea (semicerchio)
sk = newSketch();
Object.assign(sk.pts, { o: { x: 0, y: 0 }, a: { x: 20, y: 0 }, b: { x: -20, y: 0 } });
sk.ents.push({ id: "ar", t: "arc", c: "o", p1: "a", p2: "b" }, { id: "ln", t: "line", p1: "b", p2: "a" });
R = findRegions(sk);
ok(R.length === 1 && near(R[0].area, Math.PI * 200, 1e-9) && R[0].outer.some(s => s.t === "a"), "semicerchio", JSON.stringify(R.map(x => x.area)));
// firma: dopo una modifica la stessa regione si ritrova
const s1 = lineSk(sq(0, 0, 100, 50), [[50, 25, 10]]);
const ringSig = findRegions(s1).find(x => x.holes.length).sig;
s1.pts.p1.x = 150; s1.pts.p2.x = 150;
const m = matchRegion(findRegions(s1), ringSig);
ok(m && m.holes.length === 1 && near(m.area, 7500 - Math.PI * 100, 1e-9), "regione ritrovata dopo la modifica", m && m.area);

console.log(`${pass} riuscite, ${fail} fallite`);
process.exit(fail ? 1 : 0);
