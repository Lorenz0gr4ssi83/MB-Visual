// Prove del lettore dei lavori CAESAR II .C2 (ui/js/c2parse.js): archivio sintetico con la stessa struttura (voci con 32 byte
// di intestazione + zlib, nome dopo 4 byte) e un listato .NTXT a colonne fisse. Con un argomento legge anche un .C2 vero.
// Uso: node tests/test_c2.mjs [file.C2]
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { unpackC2, parseNtxt, parseC2 } = await import(pathToFileURL(path.join(ROOT, "ui/js/c2parse.js")));
let ok = 0, ko = 0;
const check = (cond, msg) => { if (cond) ok++; else { ko++; console.log("ERRORE:", msg); } };
const near = (a, b, tol = 0.05) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);

// riga del listato: etichetta di 4 caratteri, primo campo largo 15, gli altri 10, allineati a destra (vuoto = "")
const row = (tag, ...v) => tag.padEnd(4) + v.map((x, i) => String(x ?? "").padStart(i ? 10 : 15)).join("");
const ntxt = [
  "* listato di prova",
  row("VERS", "12.00000"),
  row("UN03", "KPa", "KPa"), row("UN05", "ON", "mm.", "N."), row("UN06", "mm.", "C"),
  row("ELMT", "10.0000", "20.0000", "", "", "-500.000", "273.0500", "6.3500"),
  row("EL03", "165.0000", "190.0000", "-10.000", "1200.0000"),
  row("REST", "20.0000", "2.0000"), row("RE01", "0.0000", "0.0000", "0.0000"),
  row("RE02", "20.0000", "1.0000"), row("RE03", "0.0000", "0.0000", "0.0000"),
  row("COOR", "1.0000"), row("CO01", "10.0000", "0.0000", "7956.0000", "0.0000"),
  row("ELMT", "20.0000", "30.0000", "", "", "-3000.000"),                 // diametro e spessore ripetuti
  row("REST", "30.0000", "17.0000", "", "", "0.3000"), row("RE01", "0", "0", "0"),
  row("ELMT", "30.0000", "40.0000", "", "", "-1000.000"),                 // curva a 90 gradi su 40, nodi 48 (inizio) e 49 (meta')
  row("BEND", "381.0000", "1.5000"), row("BN01", "49.0000", "MidPt", "48.0000", "0.0000"),
  row("ELMT", "40.0000", "50.0000", "2000.000"),                          // poi lungo +X
  row("RIGD", "70.0000"),
  row("ELMT", "50.0000", "60.0000", "500.000"),
  row("RED", "168.2750", "4.7800"),
  row("ELMT", "60.0000", "70.0000", "1000.000", "", "", "168.2750", "4.7800"),
  row("REST", "70.0000", "0.0000"), row("RE01", "0", "0", "0"),
  row("ELMT", "49.0000", "80.0000", "", "", "-2000.000"),                 // derivazione dal punto medio della curva
  row("ALLW", "150000.00"),
].join("\r\n");

const P = parseNtxt(ntxt);
check(P.elements.length === 7, `tratti ${P.elements.length}`);
check(P.elements[1].od === 273.05 && P.elements[1].wt === 6.35, "diametro e spessore ripetuti dal tratto precedente");
check(P.elements[0].temp === 165 && Math.abs(P.elements[0].press - 12) < 1e-9, "temperatura 1 e pressione 1 (kPa -> bar)");
check(P.elements[1].temp === 165, "temperatura ripetuta");
check(near(P.nodes.get("10"), [0, 7956, 0]), "coordinate globali del primo nodo");
check(near(P.nodes.get("40"), [0, 7956, -4500]), "vertice della curva");
check(P.supports.map(s => s.type).join(",") === "Y,X,+Y,ANC", `tipi di vincolo ${P.supports.map(s => s.type)}`);
check(P.supports[2].mu === 0.3, "attrito");
check(P.bends.length === 1 && Math.abs(P.bends[0].angle - 90) < 1e-9 && P.bends[0].radius === 381, "curva a 90 gradi, raggio 381");
check(near(P.nodes.get("48"), [0, 7956, -4119]), "nodo all'inizio della curva");
const r = 381, a = Math.PI / 4;
check(near(P.nodes.get("49"), [r * (1 - Math.cos(a)), 7956, -4119 - r * Math.sin(a)]), `nodo a meta' curva ${P.nodes.get("49")}`);
check(near(P.nodes.get("80"), [r * (1 - Math.cos(a)), 7956, -4119 - r * Math.sin(a) - 2000]), "derivazione agganciata alla curva");
check(P.pieces === 1, `pezzi ${P.pieces}`);
check(P.rigids.length === 1 && P.rigids[0].weight === 70 && P.rigids[0].from === "40", "elemento rigido con peso");
const red = P.elements.find(e => e.from === "50");
check(red.reducer && red.od1 === 273.05 && red.od2 === 168.275, "riduzione");
check(P.elements.find(e => e.from === "60").wt === 4.78, "spessore dopo la riduzione");
check(P.lengthUnit === "mm" && P.lenK === 1 && P.caesar, "unita' metriche");

// archivio: due voci, la seconda e' il listato
const entry = (name, data) => {
  const head = Buffer.alloc(264); head.writeUInt32LE(264, 0); head.write(name, 4, "latin1");
  const z = zlib.deflateSync(Buffer.concat([head, Buffer.from(data, "latin1")]));
  const h = Buffer.alloc(32); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(z.length, 4);
  return Buffer.concat([h, z]);
};
const arc = Buffer.concat([entry("PROVA._A", "\x00\x01binario"), entry("PROVA.NTXT", ntxt)]);
arc.writeUInt32LE(0x00028082, 0);
const ent = await unpackC2(new Uint8Array(arc));
check(ent.map(e => e.name).join(",") === "PROVA._A,PROVA.NTXT", `voci ${ent.map(e => e.name)}`);
check((await parseC2(new Uint8Array(arc))).elements.length === 7, "listato letto dall'archivio");
check((await parseC2(new Uint8Array(entry("PROVA._A", "x")))) === null, "archivio senza listato = null");
let threw = false;
try { await unpackC2(new Uint8Array(40)); } catch { threw = true; }
check(threw, "file non valido rifiutato");

const file = process.argv[2];
if (file) {
  const R = await parseC2(fs.readFileSync(file));
  console.log(`${path.basename(file)}: tratti ${R.elements.length}, nodi ${R.nodes.size}, pezzi ${R.pieces}, chiusure ${R.mismatches}, vincoli ${R.supports.length}` +
    ` (senza nodo ${R.supports.filter(s => !R.nodes.has(s.node)).length}), curve ${R.bends.length}, rigidi ${R.rigids.length}`);
  check(R.elements.length > 0 && R.mismatches === 0, "file vero: tratti letti e anelli chiusi");
}
console.log(ko ? `${ko} prove fallite su ${ok + ko}` : `${ok} prove riuscite`);
process.exit(ko ? 1 : 0);
