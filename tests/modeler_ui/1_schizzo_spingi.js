(async () => {
  const { A, click, move, key, type, enter, sk, idle, bodies, feats, sleep } = T;
  const a = A();
  a.startSketchTool();
  await sleep(100);
  [...document.querySelectorAll(".md-planes button")][0].click(); // XY
  await sleep(1500);
  const out = { sketch: !!a.sketch };
  a.sketch.setTool("rect");
  await click(sk(0, 0)); await move(sk(80, 40)); await type("100;60"); await enter();
  out.afterRect = { ents: a.sketch.sk.ents.length, dof: a.sketch.analysis.dof, regions: a.sketch.regions.length };
  a.sketch.setTool("circle");
  await click(sk(50, 30)); await move(sk(60, 30)); await type("20"); await enter();
  out.afterCircle = { ents: a.sketch.sk.ents.length, regions: a.sketch.regions.map(r => +r.area.toFixed(2)), dof: a.sketch.analysis.dof };
  await a.finishSketch();
  await idle();
  out.tool = a.toolName;
  // spingi/tira sull'anello
  await click([10, 10, 0]); await move([10, 10, 20]); await type("30"); await enter();
  await idle();
  out.feats = feats(); out.bodies = bodies();
  out.expected = 100 * 60 * 30 - Math.PI * 100 * 30;
  return out;
})()
