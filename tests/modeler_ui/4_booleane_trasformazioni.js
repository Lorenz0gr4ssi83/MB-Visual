(async () => {
  const { A, click, idle, bodies, feats, sleep } = T;
  const a = A();
  const out = {};
  const okBtn = async () => { await sleep(350); await idle(); [...document.querySelectorAll(".md-right .btn.primary")][0].click(); await sleep(200); await idle(); };
  const setField = (i, v) => { const f = [...document.querySelectorAll(".md-right input.field")][i]; f.value = v; f.dispatchEvent(new Event("change")); };
  const setSel = (i, v) => { const f = [...document.querySelectorAll(".md-right select.field")][i]; f.value = v; f.dispatchEvent(new Event("change")); };
  const B = id => a.bodyData(id)?.props;
  // 1) parallelepipedo nuovo corpo a destra del pezzo: 40x40x40 in (200,0,0)
  a.startOp("primitive", { shape: "box", op: "new" }); await sleep(100);
  a.tool.v.p = [200, 0, 0]; a.tool.v.dx = 40; a.tool.v.dy = 40; a.tool.v.dz = 40; a.tool.render(); a.tool.schedule();
  await okBtn();
  const boxId = a.res.bodies.at(-1).id;
  out.box = { feats: feats().slice(-1), vol: B(boxId).vol, atteso: 64000 };
  // 2) guscio del cubo togliendo la faccia superiore, spessore 2
  a.view.fit([0.6, -0.8, 0.55]); await sleep(300);
  a.startOp("shell"); await sleep(100);
  await click([220, 20, 40]);
  setField(0, "2"); await okBtn();
  out.shell = { feats: feats().slice(-1), vol: B(boxId).vol, atteso: 64000 - 36 * 36 * 38 };
  // 3) cilindro r=5 h=100 in (220,20,-10) poi booleana sottrazione dal cubo (fondo forato)
  a.startOp("primitive", { shape: "cyl", op: "new" }); await sleep(100);
  a.tool.v.p = [220, 20, -10]; a.tool.v.r = 5; a.tool.v.h = 100; a.tool.render(); a.tool.schedule();
  await okBtn();
  const cylId = a.res.bodies.at(-1).id;
  out.cyl = { feats: feats().slice(-1), vol: B(cylId).vol, atteso: Math.PI * 25 * 100 };
  a.view.selection = [{ kind: "body", body: boxId }, { kind: "body", body: cylId }];
  a.startOp("boolean", { op: "cut" }); await sleep(100);
  await okBtn();
  out.cut = { feats: feats().slice(-1), bodies: a.res.bodies.map(b => b.id), vol: B(boxId).vol, atteso: 64000 - 36 * 36 * 38 - Math.PI * 25 * 2 };
  // 4) sposta con copia il cubo di 0,60,0 e specchia la copia rispetto a XZ passante per y=-30 (nessun effetto sul volume)
  a.view.selection = [{ kind: "body", body: boxId }];
  a.startOp("transform", { k: "move", copy: true }); await sleep(100);
  a.tool.v.v = [0, 60, 0]; a.tool.render(); a.tool.schedule(); await okBtn();
  const copyId = a.res.bodies.at(-1).id;
  out.copy = { feats: feats().slice(-1), id: copyId, bbox: a.bodyData(copyId).bbox.map(x => Math.round(x)) };
  // 5) rotazione 90 gradi attorno a Z della copia, centro nel suo centro
  a.view.selection = [{ kind: "body", body: copyId }];
  a.startOp("transform", { k: "rotate" }); await sleep(100);
  a.tool.v.ax = "Z"; a.tool.v.c = [220, 80, 20]; a.tool.v.ang = 90; a.tool.render(); a.tool.schedule(); await okBtn();
  out.rotate = { feats: feats().slice(-1), bbox: a.bodyData(copyId).bbox.map(x => Math.round(x)) };
  // 6) scala 0,5 della copia
  a.view.selection = [{ kind: "body", body: copyId }];
  a.startOp("transform", { k: "scale" }); await sleep(100);
  a.tool.v.f = 0.5; a.tool.v.c = [220, 80, 0]; a.tool.render(); a.tool.schedule(); await okBtn();
  out.scale = { feats: feats().slice(-1), vol: B(copyId).vol, atteso: (64000 - 36 * 36 * 38 - Math.PI * 25 * 2) / 8 };
  // 7) serie lineare della copia: 3 lungo X passo 30
  a.view.selection = [{ kind: "body", body: copyId }];
  a.startOp("pattern"); await sleep(100);
  a.tool.v.kind = "linear"; a.tool.v.dir = "X"; a.tool.v.n = 3; a.tool.v.s = 30; a.tool.render(); a.tool.schedule(); await okBtn();
  out.pattern = { feats: feats().slice(-1), n: a.res.bodies.length };
  // 8) elimina faccia: il foro piccolo Ø8 della piastra
  const plate = a.res.bodies[0].id;
  const pb = a.bodyData(plate);
  const hf = pb.faces.findIndex(f => f.t === "cyl" && Math.abs(f.r - 4) < 1e-6);
  const v8 = B(plate).vol;
  a.view.selection = [{ kind: "face", body: plate, index: hf, info: pb.faces[hf] }];
  a.startOp("delface"); await sleep(100); await okBtn();
  out.delface = { feats: feats().slice(-1), dv: v8 - B(plate).vol, atteso: -Math.PI * 16 * 30 };
  // 9) misura tra la faccia superiore della piastra e il fondo del cubo (distanze minime con il motore)
  const m = await (await import("/js/modeler/mkernel.js")).measure(a.sid, (await import("/js/modeler/mdoc.js")).compile(a.doc).cdoc,
    { k: "p", c: [0, 0, 0] }, { k: "p", c: [3, 4, 0] });
  out.measure = m;
  // 10) dividi il cubo con il piano XY a z=20
  a.view.selection = [{ kind: "body", body: boxId }];
  a.startOp("split"); await sleep(100);
  a.tool.v.pl = "Z"; a.tool.v.o = [0, 0, 20]; a.tool.render(); a.tool.schedule(); await okBtn();
  out.split = { feats: feats().slice(-1), n: a.res.bodies.length };
  out.bodies = bodies();
  return out;
})()
