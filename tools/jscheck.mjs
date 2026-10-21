// Controllo veloce della sintassi dei moduli JS dell'interfaccia (un solo processo node per tutti i file).
//   node --experimental-vm-modules --no-warnings tools/jscheck.mjs ui/js/*.js ui/js/viewers/*.js
import { readFileSync } from "node:fs";
import vm from "node:vm";

let bad = 0;
for (const f of process.argv.slice(2)) {
  try {
    new vm.SourceTextModule(readFileSync(f, "utf8"), { identifier: f });
  } catch (e) {
    bad++;
    console.log(`${f}: ${e.message}`);
    const m = /:(\d+)/.exec(e.stack || "");
    if (m) console.log("   riga", m[1]);
  }
}
console.log(bad ? `${bad} file con errori` : "sintassi ok");
process.exit(bad ? 1 : 0);
