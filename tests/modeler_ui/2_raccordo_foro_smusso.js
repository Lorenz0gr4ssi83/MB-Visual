(async () => {
  const { A, click, move, key, type, enter, idle, bodies, feats, sleep } = T;
  const a = A();
  const out = {};
  const vol = () => a.bodyData(a.res.bodies[0].id).props.vol;
  a.view.fit([0.6, -0.8, 0.55]); await sleep(300);
  const v0 = vol();
  // raccordo: tre spigoli verticali visibili
  a.startOp("fillet"); await sleep(100);
  for (const p of [[0, 0, 15], [100, 0, 15], [100, 60, 15]]) await click(p);
  out.filletPicks = (a.tool.P.edges || []).length;
  const fld = [...document.querySelectorAll(".md-right input.field")][0]; fld.value = "5"; fld.dispatchEvent(new Event("change"));
  await sleep(400); await idle();
  [...document.querySelectorAll(".md-right .btn.primary")][0].click(); await sleep(200); await idle();
  out.afterFillet = { feats: feats(), dv: v0 - vol(), atteso: 3 * (1 - Math.PI / 4) * 25 * 30 };
  // foro passante diametro 8 sulla faccia superiore
  const v1 = vol();
  a.startOp("hole"); await sleep(100);
  await click([20, 15, 30]);
  const ins = [...document.querySelectorAll(".md-right input.field")];
  const dia = ins[0]; dia.value = "8"; dia.dispatchEvent(new Event("change"));
  await sleep(400); await idle();
  [...document.querySelectorAll(".md-right .btn.primary")][0].click(); await sleep(200); await idle();
  out.afterHole = { feats: feats(), dv: v1 - vol(), atteso: Math.PI * 16 * 30 };
  // schizzo sulla faccia superiore: cerchio d12, spingi/tira 15
  const v2 = vol();
  a.view.selection = []; a.startSketchTool(); await sleep(100);
  await click([75, 10, 30]); await sleep(1500);
  out.sketchPlane = a.sketch?.pl;
  a.sketch.setTool("circle");
  await click(T.sk(80, 45)); await move(T.sk(84, 45)); await type("12"); await enter();
  await a.finishSketch(); await idle();
  a.view.fit([0.6, -0.8, 0.55]); await sleep(300);
  out.toolAfterSketch = a.toolName;
  await click([80, 45, 30]); await move([80, 45, 40]); await type("15"); await enter(); await idle();
  out.afterBoss = { feats: feats(), dv: vol() - v2, atteso: Math.PI * 36 * 15 };
  // smusso sullo spigolo circolare in cima al cilindro
  const v3 = vol();
  a.startOp("chamfer"); await sleep(100);
  await click([86, 45, 45]);
  const f2 = [...document.querySelectorAll(".md-right input.field")][0]; f2.value = "1"; f2.dispatchEvent(new Event("change"));
  await sleep(400); await idle();
  out.chamferPicks = (a.tool.P.edges || []).length;
  [...document.querySelectorAll(".md-right .btn.primary")][0].click(); await sleep(200); await idle();
  out.afterChamfer = { feats: feats(), dv: v3 - vol(), atteso: 0.5 * 2 * Math.PI * (6 - 1 / 3) };
  out.bodies = bodies();
  return out;
})()
