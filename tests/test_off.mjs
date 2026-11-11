// Lettore OFF (ui/js/offparse.js). Uso: node tests/test_off.mjs [file.off...]
import fs from "node:fs";
import { parseOff, isOff } from "../ui/js/offparse.js";
let ok = 0, bad = 0;
const check = (c, m) => { if (c) ok++; else { bad++; console.log("NO", m); } };
const cube = `OFF\n# cubo\n8 6 12\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n0 0 1\n1 0 1\n1 1 1\n0 1 1\n4 0 1 2 3\n4 4 5 6 7\n4 0 1 5 4\n4 2 3 7 6\n4 1 2 6 5\n4 0 3 7 4 255 0 0\n`;
let P = parseOff(cube);
check(isOff(cube), "riconosciuto");
check(P.nv === 8 && P.nf === 6 && P.tri.length === 36, "cubo: 8 vertici, 6 facce, 12 triangoli");
check(P.faceColors && P.faceColors[10][0] === 1 && P.faceColors[0] === null, "colore della sesta faccia (0-255)");
P = parseOff("COFF 3 1 0\n0 0 0 1 0 0 1\n1 0 0 0 1 0 1\n0 1 0 0 0 1 1\n3 0 1 2\n");
check(P.vcol && P.vcol[4] === 1 && P.tri.length === 3, "COFF con conteggi sulla prima riga, colori per vertice 0-1");
P = parseOff("NOFF\n3 1 0\n0 0 0 0 0 1\n1 0 0 0 0 1\n0 1 0 0 0 1\n3 0 1 2\n");
check(P.pos[3] === 1 && P.pos[7] === 1, "NOFF: le normali non spostano le coordinate");
for (const [txt, err] of [["4OFF\n1 0 0\n0 0 0 0\n", "off-dimensione"], ["OFF BINARY\n", "off-binario"], ["ciao\n", "off-intestazione"], ["OFF\n5 0 0\n0 0 0\n", "off-conteggi"]]) {
  let e = ""; try { parseOff(txt); } catch (x) { e = x.message; }
  check(e === err, "errore " + err);
}
for (const f of process.argv.slice(2)) {
  const P2 = parseOff(fs.readFileSync(f, "utf8"));
  console.log(f, P2.nv, "vertici", P2.nf, "facce");
  check(P2.nv > 0 && P2.tri.length > 0, f);
}
console.log(`${ok} prove riuscite, ${bad} fallite`);
process.exit(bad ? 1 : 0);
