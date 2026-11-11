// Lettura delle tubazioni .cii (ui/js/ciiparse.js). Uso: node tests/test_cii.mjs
import assert from "node:assert/strict";
import { parseCii, supportKind } from "../ui/js/ciiparse.js";

const SAMPLE = `#$ VERS
12.00
#$ UNIT
US
#$ GEOM
10   20   10.0   0.0    0.0    8.625  0.322  0.0   650.0  150.0
20   30   0.0    0.0   -15.0   8.625  0.322  0.0   650.0  150.0
#$ MATER
1    29.5E6   0.3   7.85E-3
#$ SUPP
20   ANCH
30   Y
#$ END
`;
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok  " + name); };

const P = parseCii(SAMPLE);
ok("sezioni", () => { assert.equal(P.version, "12.00"); assert.equal(P.unit, "US"); assert.equal(P.elements.length, 2); assert.equal(P.materials.length, 1); assert.equal(P.supports.length, 2); });
ok("colonne di un tratto", () => { const e = P.elements[1]; assert.deepEqual(e.d, [0, 0, -15]); assert.equal(e.len, 15); assert.equal(e.od, 8.625); assert.equal(e.wt, 0.322); assert.equal(e.extra, 0); assert.equal(e.temp, 650); assert.equal(e.press, 150); });
ok("posizione dei nodi", () => { assert.deepEqual(P.nodes.get("10"), [0, 0, 0]); assert.deepEqual(P.nodes.get("20"), [10, 0, 0]); assert.deepEqual(P.nodes.get("30"), [10, 0, -15]); assert.equal(P.pieces, 1); assert.equal(P.mismatches, 0); });
ok("tratti corti rispetto al diametro: piedi", () => { assert.equal(P.lengthUnit, "ft"); assert.equal(P.lenK, 304.8); assert.equal(P.odK, 25.4); });
ok("tratti lunghi: pollici", () => { const Q = parseCii("#$ UNIT\nUS\n#$ GEOM\n1 2 120 0 0 8.625 0.322\n"); assert.equal(Q.lengthUnit, "in"); assert.equal(Q.lenK, 25.4); });
ok("unita' metriche", () => { const Q = parseCii("#$ UNIT\nSI\n#$ GEOM\n1 2 3000 0 0 219.1 8.18\n"); assert.equal(Q.lengthUnit, "mm"); assert.equal(Q.lenK, 1); assert.equal(Q.odK, 1); assert.equal(Q.elements[0].temp, null); });
ok("nodo raggiunto al contrario", () => { const Q = parseCii("#$ GEOM\n2 1 5 0 0 1 0.1\n2 3 0 5 0 1 0.1\n"); assert.deepEqual(Q.nodes.get("1"), [5, 0, 0]); assert.deepEqual(Q.nodes.get("3"), [0, 5, 0]); });
ok("pezzi separati e anello che non si chiude", () => { const Q = parseCii("#$ GEOM\n1 2 1 0 0 1 0.1\n3 4 1 0 0 1 0.1\n"); assert.equal(Q.pieces, 2); const R = parseCii("#$ GEOM\n1 2 1 0 0 1 0.1\n2 3 0 1 0 1 0.1\n3 1 0 0 1 1 0.1\n"); assert.equal(R.mismatches, 1); });
ok("righe non valide scartate, virgola decimale", () => { const Q = parseCii("#$ GEOM\nabc\n1 2 1,5 0 0 1 0.1\n"); assert.equal(Q.elements.length, 1); assert.equal(Q.elements[0].len, 1.5); });
ok("file senza GEOM: nessun tratto (si apre come testo)", () => { assert.equal(parseCii("#$ VERSION\n5.0\n#$ ELEMENTS\n1 2 3\n").elements.length, 0); assert.equal(parseCii("").elements.length, 0); });
ok("tipi di vincolo", () => { assert.equal(supportKind("ANCH").kind, "anchor"); assert.deepEqual(supportKind("Y"), { kind: "axis", axis: 1 }); assert.deepEqual(supportKind("+Z"), { kind: "axis", axis: 2 }); assert.equal(supportKind("GUID").kind, "guide"); assert.equal(supportKind("ALTRO").kind, "other"); });
const FULL = parseCii(`#$ UNIT
SI
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
#$ NUOVA
1 2
#$ END
`);
ok("riduzione: il tratto cambia diametro", () => { const e = FULL.elements[2]; assert.equal(e.reducer, true); assert.equal(e.od1, 219.1); assert.equal(e.od2, 168.3); assert.equal(FULL.odOf("40"), 168.3); assert.equal(FULL.odOf("30"), 219.1); });
ok("valvola su un nodo assente: posizione dal numero", () => { const v = FULL.valves[0]; assert.equal(v.deduced, true); assert.deepEqual(v.pos, [3500, 0, 0]); assert.deepEqual(v.axis, [1, 0, 0]); assert.equal(v.len, 450); assert.equal(v.other, "350.0"); });
ok("curva dove la linea non cambia direzione", () => { assert.equal(FULL.bends[0].angle, 0); });
ok("sezioni sconosciute elencate", () => assert.deepEqual(FULL.ignored, ["NUOVA"]));
console.log(`\n${n} prove riuscite`);
