// SAMB: motore di calcolo contro soluzioni in forma chiusa (senza CAESAR II). Uso: node tests/test_samb.mjs [file.cii...]
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseCii } from "../ui/js/ciiparse.js";
import { prepare, RIGID_R, RIGID_T, solveCase } from "../ui/js/samb/sambsolve.js";
import { bendFactors, buildModel, section } from "../ui/js/samb/sambmodel.js";
import { analyze } from "../ui/js/samb/sambcode.js";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok  " + name); };
const near = (a, b, tol, msg = "") => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${msg} ${a} contro ${b} (tolleranza ${tol * 100}%)`);
const E = 203000, G = E / 2.6, s = section(219.1, 8.18);
const T3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const anchor = node => T3.flatMap(d => [{ node, dof: "t", d, k: RIGID_T }, { node, dof: "r", d, k: RIGID_R }]);
const el = (i, j, extra = {}) => ({ i, j, A: s.A, Iy: s.I, Iz: s.I, J: s.J, E, G, Asy: s.A / 2, Asz: s.A / 2, k: 1, ...extra });
const line = (L, N, dir = [1, 0, 0]) => Array.from({ length: N + 1 }, (_, i) => ({ id: i, p: dir.map(v => v * L * i / N) }));
const chain = (N, extra) => Array.from({ length: N }, (_, i) => el(i, i + 1, extra));
const shearDefl = (w, L, c) => c * w * L * L / (G * s.A / 2); // contributo del taglio

const w = 0.5, L = 6000;
ok("mensola con peso: freccia e momento all'incastro", () => {
  const R = solveCase(prepare({ nodes: line(L, 8), elems: chain(8, { w }), restraints: anchor(0) }), { weight: true });
  near(R.disp[8][1], -(w * L ** 4 / (8 * E * s.I) + shearDefl(w, L, 1 / 2)), 1e-4, "freccia");
  near(R.reactions.get(0)[1], w * L, 1e-6, "reazione");
  near(Math.abs(R.reactions.get(0)[5]), w * L * L / 2, 1e-4, "momento");
});
ok("mensola verticale: nessuna freccia, solo accorciamento", () => {
  const R = solveCase(prepare({ nodes: line(L, 4, [0, 1, 0]), elems: chain(4, { w }), restraints: anchor(0) }), { weight: true });
  near(R.disp[4][1], -w * L * L / (2 * E * s.A), 1e-4, "accorciamento");
  assert.ok(Math.abs(R.disp[4][0]) < 1e-9);
});
ok("trave incastrata: momento agli estremi e in mezzeria, freccia", () => {
  const R = solveCase(prepare({ nodes: line(L, 8), elems: chain(8, { w }), restraints: [...anchor(0), ...anchor(8)] }), { weight: true });
  near(Math.abs(R.reactions.get(0)[5]), w * L * L / 12, 1e-3, "estremo");
  near(R.disp[4][1], -(w * L ** 4 / (384 * E * s.I) + shearDefl(w, L, 1 / 8)), 1e-3, "freccia");
  near(Math.abs(R.forces[4][5]), w * L * L / 24, 1e-3, "mezzeria");
});
ok("trave appoggiata con vincoli Y: reazioni e freccia", () => {
  const R = solveCase(prepare({ nodes: line(L, 8), elems: chain(8, { w }), restraints: [...anchor(0).filter(r => r.dof === "t" || r.d[0]), { node: 8, dof: "t", d: T3[1], k: RIGID_T }, { node: 8, dof: "t", d: T3[2], k: RIGID_T }] }), { weight: true });
  near(R.reactions.get(8)[1], w * L / 2, 1e-4, "reazione");
  near(R.disp[4][1], -(5 * w * L ** 4 / (384 * E * s.I) + shearDefl(w, L, 1 / 8)), 1e-3, "freccia");
});
ok("tratto dritto tra ancoraggi: forza termica EA alfa dT, nessuno spostamento", () => {
  const eps = 12e-6 * 230;
  const R = solveCase(prepare({ nodes: line(L, 4), elems: chain(4, { eps }), restraints: [...anchor(0), ...anchor(4)] }), { thermal: true });
  near(Math.abs(R.reactions.get(0)[0]), E * s.A * eps, 1e-4, "forza");
  assert.ok(Math.abs(R.disp[2][0]) < 1e-3);
});
ok("estremo libero: allungamento alfa dT L", () => {
  const eps = 12e-6 * 230;
  const R = solveCase(prepare({ nodes: line(L, 4), elems: chain(4, { eps }), restraints: anchor(0) }), { thermal: true });
  near(R.disp[4][0], eps * L, 1e-6, "allungamento");
});
ok("telaio a L tra due ancoraggi: forze termiche contro il metodo delle forze", () => {
  const a = 4000, b = 3000, eps = 12e-6 * 230, EI = E * s.I, EA = E * s.A;
  const nodes = [...Array.from({ length: 11 }, (_, i) => ({ id: i, p: [a * i / 10, 0, 0] })), ...Array.from({ length: 10 }, (_, i) => ({ id: 11 + i, p: [a, 0, -b * (i + 1) / 10] }))];
  const elems = nodes.slice(1).map((_, i) => el(i, i + 1, { eps, Asy: 0, Asz: 0 }));
  const S = prepare({ nodes, elems, restraints: [...anchor(0), ...anchor(20)] }, { shear: false });
  const R = solveCase(S, { thermal: true });
  // energia con il telaio aperto in B: su BC m = s Fx + M, su CA m = t Fz + b Fx + M (assiale Fz su BC, Fx su CA)
  const fxx = (b ** 3 / 3 + b * b * a) / EI + a / EA, fxz = b * a * a / 2 / EI, fxm = (b * b / 2 + b * a) / EI;
  const fzz = a ** 3 / 3 / EI + b / EA, fzm = a * a / 2 / EI, fmm = (a + b) / EI;
  const sol = solve3([[fxx, fxz, fxm], [fxz, fzz, fzm], [fxm, fzm, fmm]], [-eps * a, eps * b, 0]);
  const RB = R.reactions.get(20);
  near(RB[0], sol[0], 2e-3, "Fx");
  near(RB[2], sol[1], 2e-3, "Fz");
  near(Math.abs(RB[4]), Math.abs(sol[2]), 2e-3, "My");
});
function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    for (let k = 0; k < 3; k++) if (k !== i) { const c = M[k][i] / M[i][i]; for (let j = i; j < 4; j++) M[k][j] -= c * M[i][j]; }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
ok("fattori della curva: 8\" STD raggio lungo (valori noti)", () => {
  const f = bendFactors(8.625, 0.322, 12);
  near(f.h, 0.2242, 1e-3, "h"); near(f.k, 7.36, 2e-3, "k"); near(f.ii, 2.44, 3e-3, "ii"); near(f.io, 2.03, 5e-3, "io");
});
ok("curva a 90 gradi a mensola: freccia con il fattore k (forma chiusa di Castigliano)", () => {
  const R = 330, k = 7, F = 1000, E2 = E;
  const t = `#$ UNIT\nSI\n#$ MATER\n1 ${E2} 0.3 0\n#$ GEOM\n1 2 ${R} 0 0 219.1 8.18\n2 3 0 ${R} 0 219.1 8.18\n#$ BEND\n2 LONG\n#$ SUPP\n1 ANCH\n#$ END\n`;
  const P = parseCii(t), m = buildModel(P, { bendR: R / 219.1 });
  // la corda piu' corta dell'arco e' gia' compensata: fattore imposto per il confronto
  m.elems.filter(e => e.kind === "bend").forEach(e => { e.k = k * (Math.PI / 2 * R / 6) / (2 * R * Math.sin(Math.PI / 24)); e.Asy = e.Asz = 0; e.A = 1e9; e.J = 1e12; });
  const tip = m.nodes.findIndex(x => x.id === "3");
  m.point = [{ node: tip, f: [0, -F, 0, 0, 0, 0] }];
  const r = solveCase(prepare(m, { shear: false }), { weight: true });
  // forza parallela alla tangente di uscita: M = F R (1 - sin phi), freccia = F R^3 (3 pi/4 - 2) k / EI
  near(r.disp[tip][1], -F * R ** 3 * (3 * Math.PI / 4 - 2) * k / (E2 * s.I), 0.01, "freccia");
});
ok("vincolo monodirezionale: il tubo si stacca o appoggia", () => {
  const nodes = line(L, 4);
  const up = { node: 4, dof: "t", d: T3[1], k: RIGID_T, oneWay: true };
  const R = solveCase(prepare({ nodes, elems: chain(4, { w }), restraints: [...anchor(0), up] }), { weight: true });
  assert.ok(R.active.at(-1) === true && R.reactions.get(4)[1] > 0, "appoggiato sotto il peso");
  const R2 = solveCase(prepare({ nodes, elems: chain(4, { w }), restraints: [...anchor(0), { ...up, d: [0, -1, 0] }] }), { weight: true });
  assert.equal(R2.active.at(-1), false, "con il vincolo opposto si stacca");
  near(R2.disp[4][1], -(w * L ** 4 / (8 * E * s.I) + shearDefl(w, L, 1 / 2)), 1e-3, "torna mensola");
});
ok("linea senza vincoli: errore chiaro", () => {
  assert.throws(() => solveCase(prepare({ nodes: line(L, 2), elems: chain(2, { w }), restraints: [] }), { weight: true }), /unstable/);
});

const FULL = `#$ VERS
12.00
#$ UNIT
SI
#$ MATER
1    210000.0   0.3   7.85E-6
#$ GEOM
10   20   2000.0   0.0      0.0      219.1   8.18   0.0   250.0   25.0
20   30   3000.0   0.0      0.0      219.1   8.18   0.0   250.0   25.0
30   40   0.0      0.0      -1500.0  219.1   8.18   0.0   250.0   25.0
40   50   0.0      2500.0   0.0      168.3   7.11   0.0   250.0   25.0
#$ BEND
20   LONG
#$ VALV
25   FLG   450.0   350.0
#$ REDU
30   40   219.1   168.3
#$ SUPP
10   ANCH
30   GUID
50   ANCH
#$ END
`;
const FP = parseCii(FULL), FM = buildModel(FP, { Sc: 137.9, Sh: 130 }), FA = analyze(FM);
ok("modello completo: le reazioni verticali fanno il peso totale", () => {
  const wTot = FM.elems.reduce((t, e) => { const a = FM.nodes[e.i].p, b = FM.nodes[e.j].p; return t + e.w * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }, 0) + 350 * 9.80665;
  let Ry = 0; for (const r of FA.cases.SUS.reactions.values()) Ry += r[1];
  near(Ry, wTot, 1e-6, "somma");
});
ok("modello completo: dilatazione in equilibrio, reazioni opposte", () => {
  const sum = [0, 0, 0]; for (const r of FA.cases.EXP.reactions.values()) for (let i = 0; i < 3; i++) sum[i] += r[i];
  for (const v of sum) assert.ok(Math.abs(v) < 1e-3, "somma " + v);
});
ok("modello completo: valvola divisa nel tratto, curva dritta ignorata, ammissibili calcolati", () => {
  assert.ok(FM.nodes.some(x => x.id === "25"));
  assert.ok(FM.elems.some(e => e.kind === "rigid"));
  assert.ok(FM.warnings.some(x => x[0] === "curva_ignorata"));
  near(FA.code.SA, 1.25 * 137.9 + 0.25 * 130, 1e-9, "SA");
  assert.ok(FA.code.maxSL.SL > 0 && FA.code.maxSE.SE > 0);
});
ok("unita' US: pressione e temperatura convertite, densita' metrica segnalata", () => {
  const P = parseCii("#$ UNIT\nUS\n#$ MATER\n1 29.5E6 0.3 7.85E-3\n#$ GEOM\n10 20 10 0 0 8.625 0.322 0 650 150\n20 30 0 0 -15 8.625 0.322 0 650 150\n#$ SUPP\n20 ANCH\n30 Y\n#$ END\n");
  const m = buildModel(P);
  near(m.elems[0].P, 150 * 0.00689476, 1e-6, "psi");
  near(m.elems[0].eps, 12e-6 * ((650 - 32) / 1.8 - 20), 1e-6, "gradi");
  assert.ok(m.warnings.some(x => x[0] === "densita_kgcm3"));
  near(m.elems[0].E, 29.5e6 * 0.00689476, 1e-6, "E");
});
for (const f of process.argv.slice(2)) {
  const m = buildModel(parseCii(fs.readFileSync(f, "utf8"))), a = analyze(m);
  console.log(`\n${f}: ${m.nodes.length} nodi, ${m.elems.length} elementi\n  SL max ${a.code.maxSL.SL.toFixed(1)} MPa su ${a.code.maxSL.source}, SE max ${a.code.maxSE.SE.toFixed(1)} MPa su ${a.code.maxSE.source}`);
  for (const [k, r] of a.cases.EXP.reactions) console.log(`  EXP nodo ${m.nodes[k].id}: ${[...r].slice(0, 3).map(v => (v / 1000).toFixed(1)).join(" ; ")} kN`);
}
console.log(`\n${n} prove riuscite`);
