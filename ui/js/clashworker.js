// Web Worker della verifica delle interferenze: riceve gli elementi (triangoli in coordinate della scena) a blocchi,
// esegue la verifica con ui/js/clashcore.js e manda l'avanzamento. Per interrompere, la pagina chiude il worker.
//   { cmd: "add", els: [{ id, pos, idx, model, inA, inB }] }   (piu' messaggi)
//   { cmd: "run", opts }  ->  { kind: "progress", p, pairs, found } ... { kind: "done", results, candidates, elements, ms }
import { prepare, runTest } from "./clashcore.js";

const els = [];
self.onmessage = ev => {
  const m = ev.data;
  try {
    if (m.cmd === "add") { for (const e of m.els) els.push(prepare(e)); return; }
    if (m.cmd === "run") {
      const t0 = performance.now();
      const r = runTest(els, m.opts, (p, pairs, found) => self.postMessage({ kind: "progress", p, pairs, found }));
      self.postMessage({ kind: "done", ...r, ms: performance.now() - t0 });
    }
  } catch (e) {
    self.postMessage({ kind: "error", message: String(e?.message || e) });
  }
};
