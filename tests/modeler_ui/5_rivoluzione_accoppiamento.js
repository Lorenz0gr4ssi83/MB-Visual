(async () => {
  const { A, click, move, type, enter, sk, idle, feats, sleep } = T;
  const a = A();
  const out = {};
  const okBtn = async () => { await sleep(400); await idle(); [...document.querySelectorAll(".md-right .btn.primary")][0].click(); await sleep(200); await idle(); };
  const vol = id => a.bodyData(id)?.props?.vol;
  // schizzo su XZ: profilo rettangolare 10x40 a distanza 20 dall'asse Z (linea di costruzione), rivoluzione 360 -> tubo
  a.startSketchTool(); await sleep(100);
  [...document.querySelectorAll(".md-planes button")][1].click(); await sleep(1500);
  const ed = a.sketch;
  ed.setTool("rect"); await click(sk(20, 0)); await move(sk(25, 30)); await type("10;40"); await enter();
  // asse: linea verticale sull'origine, poi costruzione con X
  ed.setTool("line"); await click(sk(0, 0)); await move(sk(0, 10)); await type("50"); await enter(); ed.endChain();
  const axis = ed.sk.ents.at(-1);
  ed.sel.clear(); ed.sel.add("e:" + axis.id); ed.toggleConstruction();
  // vincolo dal pulsante: verticale sull'asse (gia' dedotto) e fisso sull'origine
  out.sketch = { ents: ed.sk.ents.length, regions: ed.regions.length, cons: ed.sk.cons.map(c => c.t).join(","), dof: ed.analysis.dof };
  await a.finishSketch(); await idle();
  a.cancelTool(false);
  const skId = a.doc.features.at(-1).id;
  const reg = a.regions[skId][0];
  a.view.selection = [{ kind: "region", sketch: skId, region: reg }];
  a.startOp("revolve"); await sleep(150);
  a.tool.v.axis = "e:" + axis.id; a.tool.v.op = "new"; a.tool.render(); a.tool.schedule();
  await okBtn();
  const tube = a.res.bodies.at(-1).id;
  out.revolve = { feats: feats().slice(-1), vol: vol(tube), atteso: Math.PI * (30 * 30 - 20 * 20) * 40 };
  // modifica dall'albero: angolo 180
  const rid = a.doc.features.at(-1).id;
  a.editFeature(rid); await sleep(1200); await idle();
  a.tool.v.ang = 180; a.tool.render(); a.tool.schedule(); await okBtn();
  out.revolveEdit = { feats: feats().slice(-1), vol: vol(tube), atteso: Math.PI * (30 * 30 - 20 * 20) * 40 / 2 };
  // simmetria con copia rispetto al piano YZ
  a.view.selection = [{ kind: "body", body: tube }];
  a.startOp("transform", { k: "mirror", copy: true }); await sleep(100);
  a.tool.v.n = "X"; a.tool.v.c = [0, 0, 0]; a.tool.render(); a.tool.schedule(); await okBtn();
  const mir = a.res.bodies.at(-1).id;
  out.mirror = { feats: feats().slice(-1), bb: a.bodyData(mir).bbox.map(Math.round) };
  // serie circolare di un cilindro piccolo attorno a Z: 6 copie
  a.startOp("primitive", { shape: "cyl", op: "new" }); await sleep(100);
  a.tool.v.p = [50, 0, 0]; a.tool.v.r = 3; a.tool.v.h = 5; a.tool.render(); a.tool.schedule(); await okBtn();
  const pin = a.res.bodies.at(-1).id;
  a.view.selection = [{ kind: "body", body: pin }];
  a.startOp("pattern"); await sleep(100);
  a.tool.v.kind = "circular"; a.tool.v.n = 6; a.tool.v.ang = 360; a.tool.v.ax = "Z"; a.tool.v.o = [0, 0, 0]; a.tool.v.fuse = false; a.tool.render(); a.tool.schedule(); await okBtn();
  const pins = a.res.bodies.filter(b => b.id.startsWith(a.doc.features.at(-1).id)).map(b => a.bodyData(b.id).props.com.map(x => Math.round(x)));
  out.circular = { feats: feats().slice(-1), copie: pins.length, centri: pins };
  // accoppiamento: base del cilindro sulla faccia superiore del tubo (facce a contatto)
  const pd = a.bodyData(pin), td = a.bodyData(tube);
  const fa = pd.faces.findIndex(f => f.t === "plane" && f.n[2] < -0.9), fb = td.faces.findIndex(f => f.t === "plane" && f.n[2] > 0.9);
  const { makeRef } = await import("/js/modeler/mdoc.js");
  a.commitFeature({ type: "mate", move: pin, a: makeRef(pin, "f", pd.faces[fa]), b: makeRef(tube, "f", td.faces[fb]), kind: "coinc", off: 0 }); await idle();
  out.mate = { feats: feats().slice(-1), zmin: Math.round(a.bodyData(pin).bbox[2] * 1000) / 1000, atteso: 40 };
  // sospendi la rivoluzione: il tubo sparisce e le lavorazioni che lo usano vanno in errore; riattiva
  a.toggleFeature(rid); await idle();
  out.sospesa = { corpi: a.res.bodies.length, errori: a.res.features.filter(f => !f.ok).map(f => f.err) };
  a.toggleFeature(rid); await idle();
  // ferma qui: dopo la rivoluzione
  const i = a.doc.features.findIndex(f => f.id === rid);
  a.setEnd(i + 1); await idle();
  out.fermaQui = { corpi: a.res.bodies.length, lav: a.res.features.length };
  a.setEnd(null); await idle();
  out.fine = { corpi: a.res.bodies.length, errori: a.res.features.filter(f => !f.ok).length };
  return out;
})()
