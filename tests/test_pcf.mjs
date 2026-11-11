// Prove del lettore PCF di ISOGEN (ui/js/pcfparse.js). Uso: node tests/test_pcf.mjs [file.pcf...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parsePcf, isPcf, outsideDiameter } = await import(pathToFileURL(path.join(ROOT, "ui/js/pcfparse.js")));
let ok = 0, ko = 0;
const check = (c, m) => { if (c) ok++; else { ko++; console.log("ERRORE:", m); } };

const mm = `﻿ISOGEN-FILES ISOCONFIG.FLS
UNITS-BORE MM
UNITS-CO-ORDS MM
PIPELINE-REFERENCE 100-CWS-001
    PIPING-SPEC CS150
PIPE
    END-POINT 0 0 0 100
    END-POINT 1000 0 0 100
    ITEM-CODE P100
ELBOW
    END-POINT 1000 0 0 100
    END-POINT 1152.4 0 152.4 100
    CENTRE-POINT 1152.4 0 0
    SKEY ELBW
OLET
    CENTRE-POINT 500 0 0
    BRANCH1-POINT 500 0 60 50
REDUCER-CONCENTRIC
    END-POINT 1152.4 0 152.4 100
    END-POINT 1152.4 0 300 80
SUPPORT
    CO-ORDS 500 0 0
    SKEY 01HG
MATERIALS
ITEM-CODE P100
    DESCRIPTION PIPE 4" STD
`;
check(isPcf(mm), "riconosciuto come PCF");
const P = parsePcf(mm);
check(P.header["PIPELINE-REFERENCE"] === "100-CWS-001", "riferimento della linea (anche con il BOM in testa)");
check(P.comps.map(c => c.type).join(",") === "PIPE,ELBOW,OLET,REDUCER-CONCENTRIC,SUPPORT", `componenti ${P.comps.map(c => c.type)} (materiali esclusi)`);
check(P.comps[0].od === 114.3 && P.comps[0].attrs["ITEM-CODE"] === "P100", "DN100 -> 114,3 mm e attributi");
check(P.comps[1].centre && P.comps[1].centre.p[0] === 1152.4, "punto centrale della curva");
check(P.comps[2].branch.od === 60.3, "derivazione DN50 -> 60,3 mm");
check(P.comps[3].ends[1].od === 88.9, "riduzione verso DN80");
check(P.comps[4].at && P.comps[4].od === 114.3, "supporto con il diametro del tubo vicino");

const inch = parsePcf(`ISOGEN-FILES x
UNITS-BORE INCH
UNITS-CO-ORDS INCH
PIPE
    END-POINT 0 0 0 6
    END-POINT 10 0 0 6
`);
check(inch.comps[0].ends[1].p[0] === 254 && inch.comps[0].od === 168.3, "pollici: coordinate in mm e 6\" -> 168,3 mm");
check(outsideDiameter(24, "INCH") === 609.6 && outsideDiameter(400, "MM") === 406.4, "oltre 12\" l'esterno e' il nominale");
check(!isPcf("STARTFONT 2.1\nFONT x\n"), "un testo qualsiasi non e' un PCF");

for (const f of process.argv.slice(2)) {
  const R = parsePcf(fs.readFileSync(f, "utf8"));
  console.log(path.basename(f), JSON.stringify(R.kinds));
  check(R.comps.length > 0, `${f}: componenti letti`);
}
console.log(ko ? `${ko} prove fallite su ${ok + ko}` : `${ok} prove riuscite`);
process.exit(ko ? 1 : 0);
