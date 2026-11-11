// diramazioni e riduzioni disegnate con i clic: tubazione principale DN100, diramazione con il primo clic sul suo asse (Tee
// ridotto), prosecuzione dalla sua estremita' con un DN minore (riduzione eccentrica), distinta e isometrico su un solo foglio
(async () => {
  const { A, click, move, type, enter, idle, sleep } = T;
  const out = {};
  const p = window.__OUT + "\\rami.mbmod";
  await fetch("/api/save?path=" + encodeURIComponent(p), { method: "POST", body: "" });
  await MB.openFile(p);
  for (let i = 0; i < 60 && !(MB.active?.name === "rami.mbmod" && MB.active?.api?._md?.res); i++) await sleep(500);
  const a = A();
  for (let i = 0; i < 20 && a.view.canvas.getBoundingClientRect().height < 200; i++) { window.dispatchEvent(new Event("resize")); await sleep(250); }
  const fit = async () => { for (let i = 0; i < 3; i++) { a.view.fit([0.6, -0.8, 0.55], new (a.view.bbox().constructor)().setFromCenterAndSize(new (a.view.bbox().min.constructor)(3000, 800, 500), new (a.view.bbox().min.constructor)(7000, 3000, 1500))); a.view.draw?.(); await sleep(250); } };
  await fit();
  const meta = id => a.res.bodies.find(b => b.id === id)?.meta;
  // ---- principale DN100, linea 100-A1-010: 4000 lungo X a quota 0
  a.startRoute({ kind: "pipe" }); await sleep(100);
  let rt = a.tool;
  rt.pickSize("DN100"); rt.linea = "100-A1-010"; rt.render();
  await click([0, 0, 0]);
  await move([1500, 0, 0]); await type("4000"); await enter();
  await T.key("Enter"); await idle();
  if (!a.res.bodies.length) return { errore: T.feats(), f: a.doc.features.at(-1) };
  const main = a.res.bodies.at(-1).id;
  out.principale = { feats: T.feats(), dv: meta(main)?.lunghezza, atteso: 4000 };
  // ---- diramazione: primo clic sull'asse a x=2000, poi 1200 lungo Y (DN50)
  await fit();
  a.startRoute({ kind: "pipe" }); await sleep(100);
  rt = a.tool;
  rt.pickSize("DN50"); rt.sizeTouched = true; rt.render();
  await move([2000, 0, 0]);
  out.aggancio = rt.cur?.kind;
  await click([2000, 0, 0]);
  out.parte = rt.attach?.mode;
  await move([2000, 600, 0]); await type("1200"); await enter();
  await T.key("Enter"); await idle();
  const br = a.doc.features.at(-1).id;
  const mb = meta(br), tee = a.res.bodies.find(b => b.id === br + ":rac");
  out.ramo = { feats: T.feats(), linea: mb?.linea, inizio: mb?.inizio?.modo, tee: tee?.meta?.componente, dv: mb?.dritti?.[0], atteso: 1200 - 94 };
  // ---- prosecuzione dall'estremita' (x=4000) con DN50: riduzione eccentrica
  await fit();
  a.startRoute({ kind: "pipe" }); await sleep(100);
  rt = a.tool;
  await move([4000, 0, 0]); await click([4000, 0, 0]);
  out.parteFine = rt.attach?.mode;
  rt.pickSize("DN50"); rt.sizeTouched = true; rt.ecc = true; rt.render();
  await move([5000, 0, 0]); await type("1500"); await enter();
  await T.key("Enter"); await idle();
  const cont = a.doc.features.at(-1).id;
  const red = a.res.bodies.find(b => b.id === cont + ":rac");
  out.prosecuzione = { feats: T.feats(), riduzione: red?.meta?.componente, dv: meta(cont)?.dritti?.[0], atteso: 1500 - 102 };
  // ---- distinta e isometrico (una linea = un foglio)
  const { bom, bomTable } = await import("/js/modeler/mplant.js");
  out.distinta = bomTable(bom(a)).rows;
  const { isoData } = await import("/js/modeler/mbom.js");
  const data = isoData(a);
  const { job } = await import("/js/modeler/mkernel.js");
  out.iso = await job("iso", { path: window.__OUT + "\\isometrico_rami.pdf", data, fmt: "pdf" });
  out.interferenze = (await (await import("/js/modeler/mkernel.js")).clash(a.sid, (await import("/js/modeler/mdoc.js")).compile(a.doc).cdoc, 1)).clash.length;
  return out;
})()
