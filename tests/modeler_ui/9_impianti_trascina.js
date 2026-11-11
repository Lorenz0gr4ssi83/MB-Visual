// impianti e trascinamento diretto: tubazione disegnata con clic e lunghezze digitate (assi scelti dal mouse), canalina
// dalle linee di uno schizzo (resta collegata), maniglia di spostamento, anello di rotazione, nodo del percorso trascinato,
// misura cambiata dal pannello, distinta materiali
(async () => {
  const { A, click, move, type, enter, idle, sleep, xy, sk } = T;
  const out = {};
  // modello nuovo
  const p = window.__OUT + "\\impianti.mbmod";
  await fetch("/api/save?path=" + encodeURIComponent(p), { method: "POST", body: "" });
  await MB.openFile(p);
  for (let i = 0; i < 60 && !MB.active?.api?._md?.res; i++) await sleep(500);
  const a = A();
  a.view.fit([0.6, -0.8, 0.55], new (a.view.bbox().constructor)().setFromCenterAndSize(new (a.view.bbox().min.constructor)(500, 400, 300), new (a.view.bbox().min.constructor)(1600, 1200, 800)));
  await sleep(300);
  const meta = id => a.res.bodies.find(b => b.id === id)?.meta;
  const vol = id => a.bodyData(id)?.props?.vol;
  // ---- tubazione DN100: partenza (0,0,0), 1000 lungo X, 800 lungo Y, 600 lungo Z (valori digitati)
  a.startRoute({ kind: "pipe" }); await sleep(100);
  const rt = a.tool;
  rt.pickSize("DN100"); rt.r = 152.4; rt.render();
  await click([0, 0, 0]);
  // la direzione la sceglie il mouse: ci si muove verso +X, poi si digita 1000
  await move([400, 0, 0]); await type("1000"); await enter();
  await move([1000, 300, 0]); await type("800"); await enter();
  await move([1000, 800, 250]); await type("600"); await enter();
  out.puntiDisegnati = rt.pts.map(q => q.map(Math.round));
  await T.key("Enter"); await idle();
  const pipe = a.res.bodies.at(-1).id;
  const m = meta(pipe);
  const A0 = Math.PI * (57.15 ** 2 - (57.15 - 6.02) ** 2);
  out.tubo = { feats: T.feats(), lunghezza: m?.lunghezza, curve: m?.curve, dv: vol(pipe), atteso: A0 * m?.lunghezza };
  // ---- maniglia: trascina il tubo di +500 lungo Y (freccia verde), con il mouse vero sul canvas
  a.view.selection = [{ kind: "body", body: pipe }]; a.selChanged(); a.view.draw(); await sleep(100);
  const c = a.gizmo.center([pipe]);
  const H = a.gizmo.handles(c).find(h => h.k === "ax" && h.i === 1);
  const r = a.view.canvas.getBoundingClientRect();
  const s0 = [r.left + (H.a[0] + H.b[0] * 3) / 4, r.top + (H.a[1] + H.b[1] * 3) / 4];
  const ev = (t, x, y, b) => (t === "pointerdown" ? a.view.canvas : window).dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, button: 0, buttons: b, pointerId: 1, pointerType: "mouse" }));
  ev("pointerdown", s0[0], s0[1], 1); await sleep(30);
  const to = xy([c[0], c[1] + 500, c[2]]), from = xy(c);
  ev("pointermove", s0[0] + (to[0] - from[0]), s0[1] + (to[1] - from[1]), 1); await sleep(30);
  out.trascinamento = a.gizmo.drag?.vec?.map(x => Math.round(x));
  // la misura si rende esatta digitando: 500
  await T.key("5"); const inp = document.querySelector(".md-vinput"); inp.value = "500"; await enter(); await idle(); await sleep(200);
  const bbm = a.bodyData(pipe).bbox;
  out.sposta = { feats: T.feats(), ultima: a.doc.features.at(-1).type, ymin: Math.round(bbm[1] * 100) / 100, atteso_ymin: Math.round((500 - 57.15) * 100) / 100 };
  // un secondo trascinamento si somma nella stessa lavorazione
  a.view.selection = [{ kind: "body", body: pipe }]; a.selChanged(); await sleep(50);
  const c2 = a.gizmo.center([pipe]);
  const H2 = a.gizmo.handles(c2).find(h => h.k === "ax" && h.i === 0);
  const s1 = [r.left + (H2.a[0] + H2.b[0] * 3) / 4, r.top + (H2.a[1] + H2.b[1] * 3) / 4];
  ev("pointerdown", s1[0], s1[1], 1); await sleep(30);
  ev("pointermove", s1[0] + 5, s1[1] + 2, 1); await sleep(30);
  await T.key("2"); const inp2 = document.querySelector(".md-vinput"); inp2.value = "200"; await enter(); await idle(); await sleep(200);
  // tubazione disegnata a punti: la maniglia sposta i nodi stessi (restano modificabili), nessuna lavorazione in piu'
  const p0 = a.doc.features.find(q => q.id === pipe).pts[0];
  out.somma = { trasformazioni: a.doc.features.filter(f => f.type === "transform").length, dv: p0[0] + p0[1], atteso: 700 };
  // ---- nodo del percorso: annulla gli spostamenti, poi trascina l'ultimo nodo da z=600 a z=900 (passi automatici)
  a.undo(); await idle(); a.undo(); await idle();
  a.view.selection = [{ kind: "body", body: pipe }]; a.selChanged(); a.view.draw(); await sleep(100);
  const f = a.doc.features.find(q => q.id === pipe);
  const n3 = f.pts[3], q0 = xy(n3), q1 = xy([n3[0], n3[1], 900]);
  ev("pointerdown", q0[0], q0[1], 1); await sleep(30);
  ev("pointermove", q1[0], q1[1], 1); await sleep(30);
  ev("pointerup", q1[0], q1[1], 0); await idle(); await sleep(200);
  out.nodo = { nuovo: a.doc.features.find(q => q.id === pipe).pts[3], dv: meta(pipe)?.lunghezza, atteso: out.tubo.lunghezza + 300, feats: T.feats() };
  // ---- misura cambiata dal pannello: DN150
  a.view.selection = [{ kind: "body", body: pipe }]; a.selChanged(); await sleep(50);
  const sel = [...a.right.querySelectorAll("select.field")].find(q => [...q.options].some(o => o.value === "DN150"));
  sel.value = "DN150"; sel.dispatchEvent(new Event("change")); await idle(); await sleep(100);
  const m2 = meta(pipe);
  out.dn150 = { feats: T.feats(), od: m2?.od, dv: vol(pipe), atteso: Math.PI * (84.15 ** 2 - (84.15 - 7.11) ** 2) * m2?.lunghezza };
  // ---- canalina dalle linee di uno schizzo XY (spezzata 0,0 -> 1200,0 -> 1200,900) a quota 0
  a.view.selection = []; a.startSketchTool(); await sleep(100);
  [...a.right.querySelectorAll(".md-planes button")][0].click(); await sleep(1500);
  a.sketch.setTool("line");
  await click(sk(0, -400)); await move(sk(600, -400)); await type("1200"); await enter();
  await move(sk(1200, 0)); await type("900"); await enter();
  a.sketch.endChain();
  const skId = a.sketch.f.id;
  await a.finishSketch(); await idle();
  a.cancelTool(false);
  a.startRoute({ kind: "tray" }); await sleep(100);
  a.tool.pickSize("C300x60"); a.tool.r = 300;
  a.tool.fromSketch(skId); await idle();
  const tray = a.res.bodies.at(-1).id;
  const mt = meta(tray);
  out.canalina = { feats: T.feats(), dv: mt?.lunghezza, curve: mt?.curve, atteso: 1200 + 900 - 2 * 300 + Math.PI / 2 * 300 };
  // la quota dello schizzo cambia: la canalina segue
  const skf = a.doc.features.find(q => q.id === skId);
  const d = skf.sk.cons.find(q => q.t === "len" && q.v === 1200);
  if (d) { d.v = 1500; a.commit("quota"); await idle(); }
  out.canalinaSegue = { dv: meta(tray)?.lunghezza, atteso: 1500 + 900 - 2 * 300 + Math.PI / 2 * 300 };
  // ---- valvola sulla tubazione: dal pannello della tubazione selezionata, clic sul tratto lungo X
  a.view.fit([0.6, -0.8, 0.55]); await sleep(200);
  a.view.selection = [{ kind: "body", body: pipe }]; a.selChanged(); await sleep(50);
  [...a.right.querySelectorAll(".md-quick .btn")].find(b => /Valvola|Valve/.test(b.textContent)).click(); await sleep(50);
  const N = meta(pipe).nodi;
  await click([(N[0][0] + N[1][0]) / 2, N[0][1], N[0][2]]); await idle();
  const valve = a.res.bodies.at(-1).id, bbv = a.bodyData(valve)?.bbox || [0, 0, 0, 0, 0, 0];
  out.valvola = { feats: T.feats(), meta: a.res.bodies.at(-1).meta?.componente, centroX: Math.round((bbv[0] + bbv[3]) / 2), atteso: Math.round((N[0][0] + N[1][0]) / 2) };
  // ---- interferenze: un blocco attraversato dalla tubazione
  a.startOp("primitive", { shape: "box", op: "new" }); await sleep(100);
  a.tool.v.p = [700, N[0][1] - 200, N[0][2] - 200]; a.tool.v.dx = 50; a.tool.v.dy = 400; a.tool.v.dz = 400; a.tool.render(); a.tool.schedule();
  await sleep(400); await idle(); [...a.right.querySelectorAll(".btn.primary")][0].click(); await sleep(200); await idle();
  [...a.ctx.tb.querySelectorAll("[data-op=clash]")][0].click();
  for (let i = 0; i < 60 && !a.tool?.res; i++) await sleep(200);
  const cl = a.tool.res.clash;
  out.interferenze = { n: cl.length, coppia: cl.map(c => [a.bodyName(c.a), a.bodyName(c.b)]), dv: cl[0]?.vol, atteso: Math.PI * (84.15 ** 2 - (84.15 - 7.11) ** 2) * 50 };
  a.cancelTool();
  // ---- distinta materiali
  const { bom, bomTable } = await import("/js/modeler/mplant.js");
  const T2 = bomTable(bom(a));
  out.distinta = T2.rows;
  return out;
})()
