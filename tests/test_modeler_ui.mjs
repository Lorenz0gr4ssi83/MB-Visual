// Collaudo del modellatore 3D nell'app vera: server con dati di prova (tests/format_server.py) + Edge senza finestra
// pilotato via DevTools. Gli scenari in tests/modeler_ui/ simulano un utente (clic sul canvas, tasti, finestre) e
// restituiscono i valori misurati; qui si confrontano con i valori attesi.
//   node tests/test_modeler_ui.mjs [cartella di uscita]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "mbmod-ui-")));
fs.mkdirSync(OUT, { recursive: true });
const PY = process.env.MBV_PYTHON || path.join(os.homedir(), ".mbvisual", "venv", "Scripts", "python.exe");
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCEN = path.join(ROOT, "tests", "modeler_ui");

function startServer() {
  const p = spawn(PY, [path.join(ROOT, "tests", "format_server.py"), path.join(OUT, "dati-app")], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  p.stderr.on("data", d => fs.appendFileSync(path.join(OUT, "server.log"), d));
  return new Promise((res, rej) => {
    let b = "";
    p.stdout.on("data", d => { b += d; const m = b.match(/http:\/\/\S+/); if (m) res({ proc: p, url: m[0] }); });
    p.on("exit", c => rej(new Error("server " + c)));
  });
}
async function startEdge() {
  // profilo in un percorso corto (con percorsi lunghi IndexedDB da' errori)
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "mbme-"));
  const p = spawn(EDGE, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${prof}`, "--window-size=1500,900", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  const pf = path.join(prof, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(pf); i++) await sleep(100);
  await sleep(300);
  return { proc: p, port: fs.readFileSync(pf, "utf8").split("\n")[0].trim() };
}
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.wait = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res; this.ws.onerror = rej;
      this.ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && this.wait.has(m.id)) { this.wait.get(m.id)(m); this.wait.delete(m.id); } };
    });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise(r => this.wait.set(id, r)); }
  async eval(src) {
    const r = await this.send("Runtime.evaluate", { expression: src, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  }
}

// confronto: oggetti con "atteso" e un valore misurato (dv, vol, zmin); lavorazioni con errori (feats con ":")
const results = [];
const ok = (name, cond, info = "") => { results.push([name, !!cond]); console.log((cond ? "ok   " : "FAIL ") + name + (info !== "" ? `  [${info}]` : "")); };
const EXPECTED_ERRORS = ["badExpr", "undo", "sospesa"]; // stati con errori voluti (parametro non valido, lavorazione sospesa)
function judge(scen, res) {
  const walk = (o, key) => {
    if (!o || typeof o !== "object") return;
    if ("expected" in o && Array.isArray(o.bodies) && o.bodies[0]) ok(`${scen} · volume`, Math.abs(o.bodies[0].vol - o.expected) <= 1e-3, `${o.bodies[0].vol} / ${o.expected}`);
    if ("atteso" in o) {
      const k = ["dv", "vol", "zmin", "centroX"].find(x => x in o);
      if (k && typeof o[k] === "number") {
        // spingi/tira sui file importati: area esatta della faccia piana (scarto solo per le facce vicine ritagliate)
        const tol = k === "zmin" ? 0.05 : o.faccia ? 0.002 * Math.abs(o.atteso) : Math.max(1e-4 * Math.abs(o.atteso), 1e-6);
        ok(`${scen} · ${key}`, Math.abs(o[k] - o.atteso) <= tol, `${o[k]} / ${o.atteso}`);
      }
    }
    if ("ymin" in o && "atteso_ymin" in o) ok(`${scen} · ${key}`, Math.abs(o.ymin - o.atteso_ymin) <= 1.5 /* ingombro di OpenCascade: margine di tolleranza sulle superfici curve */, `${o.ymin} / ${o.atteso_ymin}`);
    if (Array.isArray(o.feats) && !EXPECTED_ERRORS.includes(key)) ok(`${scen} · ${key}: lavorazioni senza errori`, !o.feats.some(f => String(f).includes(":")), o.feats.filter(f => String(f).includes(":")).join(" "));
    if ("modifica" in o) ok(`${scen} · ${o.file}: modifica`, o.modifica === "ok", o.modifica);
    if ("uguale" in o) ok(`${scen} · riapertura identica`, o.uguale && !o.errori, JSON.stringify(o));
    if (o.err) ok(`${scen} · ${o.file || key}`, false, o.err);
    if ("n" in o && "file" in o && !o.err && !o.saltato) ok(`${scen} · ${o.file}: importati ${o.n} corpi`, o.n > 0, `${o.sec} s`);
    for (const [k, v] of Object.entries(o)) if (v && typeof v === "object") walk(v, Array.isArray(o) ? key : k);
  };
  walk(res, scen);
  if (scen.startsWith("11_") && res) {
    ok(`${scen} · primo clic sull'asse = diramazione a T, sull'estremita' = prosecuzione`, res.aggancio === "tee" && res.parte === "tee" && res.parteFine === "end", JSON.stringify([res.aggancio, res.parte, res.parteFine]));
    ok(`${scen} · Tee ridotto e linea ereditata`, res.ramo?.tee === "tee_rid" && res.ramo?.linea === "100-A1-010" && res.ramo?.inizio === "tee", JSON.stringify(res.ramo));
    ok(`${scen} · riduzione eccentrica`, res.prosecuzione?.riduzione === "riduzione_ecc", JSON.stringify(res.prosecuzione));
    ok(`${scen} · distinta con Tee e riduzione`, (res.distinta || []).some(r => /Tee/.test(r[0])) && (res.distinta || []).some(r => /Riduzione|reducer/i.test(r[0])), JSON.stringify(res.distinta));
    ok(`${scen} · isometrico: una linea = un foglio`, res.iso?.fogli === 1, JSON.stringify(res.iso));
    ok(`${scen} · nessuna interferenza fasulla`, res.interferenze === 0, String(res.interferenze));
  }
  if (scen.startsWith("10_") && res) {
    const c = res.classe || {}, s = res.staffe || {}, d = res.distinta || [];
    ok(`${scen} · classe B1 e numero di linea`, c.spec === "B1" && c.linea === "080-B1-001" && c.t === c.attesoT && /316L/.test(c.mat), JSON.stringify(c));
    ok(`${scen} · staffe a pavimento: 4 sui due tratti, altezza fino al fondo del tubo`, s.quantita === 4 && (s.altezze || []).every(h => Math.abs(h - s.attesa) < 0.2), JSON.stringify(s));
    ok(`${scen} · distinta: tubo con classe e materiale, riga delle staffe`, d.some(r => /B1/.test(r[0]) && /316L/.test(r[1])) && d.some(r => r[2] === 4), JSON.stringify(d));
    ok(`${scen} · isometrico PDF`, res.iso?.fogli === 1 && res.iso_dati?.linea === "080-B1-001" && res.iso_dati?.supporti === 4, JSON.stringify(res.iso));
    ok(`${scen} · stencil P&ID aperto nello schema`, res.pid?.valvola && res.pid?.pompa, JSON.stringify(res.pid));
  }
  for (const f of ["step", "iges", "brep", "stl", "obj", "glb", "gltf"]) if (res && f in res) ok(`${scen} · salvataggio ${f}`, !String(res[f]).startsWith("ERRORE"), res[f]);
}

const openModel = file => `(async () => {
  // finestra del consenso alle statistiche (dati di prova nuovi): si rifiuta appena compare
  for (let i = 0; i < 40; i++) { const b = [...document.querySelectorAll("button")].find(b => /No, grazie|No, thanks/.test(b.textContent)); if (b) { b.click(); break; } await new Promise(r => setTimeout(r, 250)); }
  await MB.openFile(${JSON.stringify(file)});
  for (let i = 0; i < 60 && !MB.active?.api?._md?.res; i++) await new Promise(r => setTimeout(r, 500));
})()`;

const srv = await startServer();
const edge = await startEdge();
try {
  const list = await (await fetch(`http://127.0.0.1:${edge.port}/json/list`)).json();
  const cdp = new Cdp(list.find(t => t.type === "page").webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.navigate", { url: srv.url.replace("127.0.0.1", "mbmod.localhost") });
  await sleep(4000);
  await cdp.eval(`window.__ROOT = ${JSON.stringify(ROOT.replace(/\//g, "\\"))}; window.__HOME = ${JSON.stringify(os.homedir())}; window.__OUT = ${JSON.stringify(OUT)}; 1`);
  const first = path.join(OUT, "prova.mbmod");
  fs.writeFileSync(first, ""); // modello nuovo (come "Crea nuovo": file vuoto)
  await cdp.eval(openModel(first));
  await cdp.eval(fs.readFileSync(path.join(SCEN, "helpers.js"), "utf8"));
  for (const f of fs.readdirSync(SCEN).filter(f => /^\d+_.*\.js$/.test(f)).sort((x, y) => parseInt(x) - parseInt(y)).filter(f => !process.env.MBV_SOLO || process.env.MBV_SOLO.split(",").includes(String(parseInt(f))))) {
    const name = f.replace(/\.js$/, "");
    const t0 = Date.now();
    try {
      if (name.startsWith("5_")) { const p = path.join(OUT, "rivoluzione.mbmod"); fs.writeFileSync(p, ""); await cdp.eval(openModel(p)); }
      if (name.startsWith("6_") || name.startsWith("7_")) await cdp.eval("1");
      if (name.startsWith("8_")) await cdp.eval(`(() => { const t = MB.tabs.find(t => t.name === "prova.mbmod"); if (t) MB.activate(t); return 1; })()`);
      const res = await cdp.eval(fs.readFileSync(path.join(SCEN, f), "utf8"));
      fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify(res, null, 1));
      console.log(`-- ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      judge(name, res);
    } catch (e) { ok(name, false, e.message.split("\n")[0]); }
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(shot.result.data, "base64"));
  }
} finally {
  srv.proc.kill();
  edge.proc.kill();
}
const bad = results.filter(r => !r[1]);
console.log(`\n${results.length - bad.length} riuscite, ${bad.length} fallite · risultati e schermate in ${OUT}`);
process.exit(bad.length ? 1 : 0);
