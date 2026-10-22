// Collaudo della georeferenziazione dei disegni (ui/js/georef.js), senza browser.
// Uso: node tests/test_georef.mjs   (campioni: python tools/make_georef_samples.py)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as G from "../ui/js/georef.js";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, "samples", "georef");
let ok = 0, ko = 0;
const check = (name, cond, extra = "") => { if (cond) { ok++; console.log("  ok  " + name); } else { ko++; console.log("  NO  " + name + (extra ? "  -> " + extra : "")); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const nearT = (A, B, tol) => A.every((v, i) => near(v, B[i], tol * (i === 2 || i === 5 ? 1e6 : 1)));

// generatore pseudo-casuale ripetibile
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

console.log("Trasformazioni esatte");
{
  const T = G.placeAt(0.001, 31.5, 1200, -800, 686000, 4929000); // mm -> m, ruotata, in UTM
  const pts = [[0, 0], [52000, 1000], [30000, 41000], [-5000, 20000], [12000, 9000]].map(([x, y]) => { const [X, Y] = G.apply(T, x, y); return { x, y, X, Y }; });
  for (const m of ["rigida", "similarita", "affine"]) {
    const r = G.fit(m, pts, { scale0: 0.001 });
    check(`${m}: ricostruisce la trasformazione`, !r.error && nearT(r.T, T, 1e-9), JSON.stringify(r));
    check(`${m}: scarti nulli`, r.rms < 1e-6, String(r.rms));
  }
  check("scala 0,001 m per unita'", near(G.scaleOf(T), 0.001, 1e-15));
  check("rotazione 31,5 gradi", near(G.rotationOf(T), 31.5, 1e-9));
  const Ti = G.invert(T), [x, y] = G.apply(Ti, ...G.apply(T, 1234.5, -987.25));
  check("inversa", near(x, 1234.5, 1e-6) && near(y, -987.25, 1e-6));
  const A = [0.98, 0.07, 500000, -0.05, 1.03, 4800000]; // affine con scale diverse e taglio
  const pa = [[0, 0], [100, 0], [0, 100], [70, 40], [20, 90]].map(([x, y]) => { const [X, Y] = G.apply(A, x, y); return { x, y, X, Y }; });
  const ra = G.fit("affine", pa);
  check("affine generica ricostruita", !ra.error && nearT(ra.T, A, 1e-9), JSON.stringify(ra.T));
  const rs = G.fit("similarita", pa);
  check("similarita' su dati affini: scarti > 0", rs.rms > 0.5, String(rs.rms));
}

console.log("Punti minimi e casi degeneri");
{
  const p1 = [{ x: 10, y: 20, X: 1000, Y: 2000 }];
  const r1 = G.fit("rigida", p1, { scale0: 2, rot0: 90 });
  const [X, Y] = G.apply(r1.T, 10, 20), [X2, Y2] = G.apply(r1.T, 11, 20);
  check("rigida con un punto: passa per il punto", near(X, 1000, 1e-9) && near(Y, 2000, 1e-9));
  check("rigida con un punto: usa scala e rotazione date", near(X2 - X, 0, 1e-9) && near(Y2 - Y, 2, 1e-9));
  check("similarita' con un punto: pochi", G.fit("similarita", p1).error === "pochi");
  check("affine con due punti: pochi", G.fit("affine", [...p1, { x: 0, y: 0, X: 0, Y: 0 }]).error === "pochi");
  check("affine con punti allineati: errore", G.fit("affine", [0, 1, 2].map(i => ({ x: i, y: i, X: i, Y: 2 * i }))).error === "allineati");
  check("similarita' con punti coincidenti: errore", G.fit("similarita", [{ x: 1, y: 1, X: 0, Y: 0 }, { x: 1, y: 1, X: 5, Y: 5 }]).error === "coincidenti");
  const pts = [{ x: 0, y: 0, X: 0, Y: 0 }, { x: 10, y: 0, X: 10, Y: 0 }, { x: 0, y: 10, X: 0, Y: 10 }, { x: 10, y: 10, X: 14, Y: 13, off: true }];
  const r = G.fit("affine", pts);
  check("punto escluso: non entra nel calcolo", r.rms < 1e-9 && nearT(r.T, G.IDENTITY, 1e-12));
  check("punto escluso: scarto comunque calcolato", near(r.res[3].r, 5, 1e-9), JSON.stringify(r.res[3]));
}

console.log("Rumore: minimi quadrati");
{
  const T = G.placeAt(1, -12, 0, 0, 700000, 4900000);
  const pts = Array.from({ length: 40 }, () => { const x = rnd() * 500, y = rnd() * 300, [X, Y] = G.apply(T, x, y); return { x, y, X: X + gauss() * 0.05, Y: Y + gauss() * 0.05 }; });
  const r = G.fit("similarita", pts);
  check("RMS vicino al rumore (5 cm)", r.rms > 0.03 && r.rms < 0.08, String(r.rms));
  check("scala stimata entro 3e-4", near(G.scaleOf(r.T), 1, 3e-4), String(G.scaleOf(r.T)));
  check("rotazione stimata entro 0,01 gradi", near(G.rotationOf(r.T), -12, 0.01), String(G.rotationOf(r.T)));
  // un errore grossolano emerge nello scarto
  const bad = pts.map((p, i) => (i === 7 ? { ...p, X: p.X + 5 } : p));
  const rb = G.fit("similarita", bad);
  const worst = rb.res.reduce((b, v, i) => (v.r > rb.res[b].r ? i : b), 0);
  check("punto sbagliato = scarto maggiore", worst === 7, String(worst));
}

console.log("Coordinate gia' georeferenziate");
check("UTM 32 riconosciuto", G.guessFromExtent([686400, 4929290, 686500, 4929370]) === 7791);
check("UTM in millimetri con unita' mm", G.guessFromExtent([686400000, 4929290000, 686500000, 4929370000], 0.001) === 7791);
check("Gauss-Boaga Ovest", G.guessFromExtent([1686400, 4929290, 1686500, 4929370]) === 3003);
check("Gauss-Boaga Est", G.guessFromExtent([2310000, 4500000, 2320000, 4510000]) === 3004);
check("coordinate locali: nessun sistema", G.guessFromExtent([0, 0, 68000, 47000]) === null);

console.log("GEODATA e campioni");
{
  const J = JSON.parse(readFileSync(join(SAMPLES, "punti_controllo.json"), "utf8"));
  const text = readFileSync(join(SAMPLES, "lotto_geodata.dxf"), "latin1");
  const gd = G.geodataFromDxf(text);
  check("GEODATA letto dal DXF", gd && gd.type === 2 && near(gd.scale, 0.001, 1e-12) && near(gd.ref[0], J.origine[0], 1e-6), JSON.stringify(gd && { ...gd, def: gd.def.length }));
  check("sistema dalla definizione XML = EPSG 7791", G.epsgFromCsDef(gd.def) === 7791, String(G.epsgFromCsDef(gd.def)));
  check("WKT con AUTHORITY", G.epsgFromCsDef('PROJCS["RDN2008 / UTM zone 33N",GEOGCS["RDN2008"],AUTHORITY["EPSG","7792"]]') === 7792);
  const T = G.geodataTransform(gd);
  let worst = 0;
  for (const p of J.punti) { const [X, Y] = G.apply(T, ...p.locale_mm); worst = Math.max(worst, Math.hypot(X - p.utm[0], Y - p.utm[1])); }
  check("GEODATA porta i vertici del lotto sulle coordinate UTM (< 1 mm)", worst < 0.001, worst + " m");
  check("DXF senza GEODATA", G.geodataFromDxf(readFileSync(join(SAMPLES, "lotto_locale.dxf"), "latin1")) === null);
  const utmText = readFileSync(join(SAMPLES, "lotto_utm.dxf"), "latin1");
  check("lotto_utm.dxf: $INSUNITS = 6 (metri)", /\$INSUNITS\r?\n\s*70\r?\n\s*6\r?\n/.test(utmText));

  // disegno locale in mm: similarita' da due vertici, verifica sugli altri due
  const pts = J.punti.map(p => ({ x: p.locale_mm[0], y: p.locale_mm[1], X: p.utm[0], Y: p.utm[1] }));
  const r2 = G.fit("similarita", pts.slice(0, 2));
  const chk = G.residuals(r2.T, pts).res.slice(2).map(v => v.r);
  check("locale -> UTM con 2 punti: altri vertici entro 1 mm", Math.max(...chk) < 0.001, chk.join(", "));
  check("locale -> UTM: scala 0,001 e rotazione 25 gradi", near(G.scaleOf(r2.T), 0.001, 1e-12) && near(G.rotationOf(r2.T), 25, 1e-9), G.rotationOf(r2.T));
  // tavola PDF in scala 1:500: rigida con scala dichiarata e un solo punto + rotazione, poi con due punti
  const s500 = J.scala_pdf * G.PT_MM / 1000;
  const pp = J.punti.map(p => ({ x: p.pdf_pt[0], y: p.pdf_pt[1], X: p.utm[0], Y: p.utm[1] }));
  const rp = G.fit("rigida", pp.slice(0, 2), { scale0: s500 });
  const chkp = G.residuals(rp.T, pp).res.map(v => v.r);
  check("tavola PDF 1:500, 2 punti: vertici entro 1 cm", Math.max(...chkp) < 0.01, chkp.join(", "));
  const rp1 = G.fit("rigida", pp.slice(0, 1), { scale0: s500, rot0: 25 });
  const chk1 = G.residuals(rp1.T, pp).res.map(v => v.r);
  check("tavola PDF 1:500, 1 punto + rotazione 25: vertici entro 1 cm", Math.max(...chk1) < 0.01, chk1.join(", "));
  // quota nota: lato P1-P2 del lotto = distanza reale
  const d = Math.hypot(pp[1].X - pp[0].X, pp[1].Y - pp[0].Y), dp = Math.hypot(pp[1].x - pp[0].x, pp[1].y - pp[0].y);
  check("quota nota -> scala 1:500", near(d / dp * 1000 / G.PT_MM, 500, 1e-6), String(d / dp * 1000 / G.PT_MM));
}

console.log("File .mbgeo");
{
  const g = { crs: "EPSG:7791", method: "similarita", unit: 0.001, T: [0.0009063, -0.0004226, 686420.123456789, 0.0004226, 0.0009063, 4929310.987654321], points: [{ x: 1, y: 2, X: 3, Y: 4 }, { x: 5, y: 6, X: 7, Y: 8, off: true }], rms: 0.012 };
  const o = JSON.parse(JSON.stringify(G.toMbgeo("lotto.dxf", g)));
  const b = G.fromMbgeo(o);
  check("andata e ritorno", b && b.crs === g.crs && b.method === g.method && nearT(b.T, g.T, 1e-12) && b.points[1].off === true && !b.points[0].off);
  check("file non valido rifiutato", G.fromMbgeo({ transform: [1, 2] }) === null && G.fromMbgeo(null) === null);
}

console.log(`\n${ok} riuscite, ${ko} fallite`);
process.exit(ko ? 1 : 0);
