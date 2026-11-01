(async () => {
  const { A, idle, bodies, feats, sleep } = T;
  const a = A();
  const vol = () => a.res?.bodies?.[0] ? a.bodyData(a.res.bodies[0].id).props.vol : "nessun corpo " + JSON.stringify(feats());
  const out = {};
  const v0 = vol();
  // modifica dello schizzo 1 dall'albero: quota 100 -> 120 nel pannello delle quote
  a.editFeature("f1"); await sleep(1500); await idle();
  out.inSketch = !!a.sketch;
  const dimInputs = () => [...document.querySelectorAll(".md-dims input.field")];
  out.dims = dimInputs().map(i => i.value);
  const w = dimInputs()[0]; w.value = "120"; w.dispatchEvent(new Event("change")); await sleep(100);
  out.dof = a.sketch.analysis.dof;
  await a.finishSketch(); await idle();
  out.afterEdit = { feats: feats(), dv: vol() - v0, atteso: 20 * 60 * 30 };
  // parametro L e quota = L
  const v1 = vol();
  a.doc.params.push({ name: "L", expr: "140" });
  a.doc.features[0].sk.cons.find(c => c.t === "len" && c.v === 120).v = "L";
  a.commit("param"); await idle();
  out.afterParam = { feats: feats(), dv: vol() - v1, atteso: 20 * 60 * 30, vals: a.vals };
  // cambio del parametro dal pannello
  a.panel.open.params = true; a.panel.render();
  const pin = [...document.querySelectorAll(".md-params .md-prow input")][1];
  pin.value = "L0 + 10"; pin.dispatchEvent(new Event("change")); await idle();
  out.badExpr = { perr: a.perr, say: document.querySelector(".md-status").textContent };
  pin.value = "100 + 2*5"; pin.dispatchEvent(new Event("change")); await idle();
  out.afterParam2 = { feats: feats(), vol: vol(), atteso: v0 + 10 * 60 * 30 };
  // annulla tre volte: torna a 140
  a.undo(); await idle();
  out.undo = { vol: vol() };
  a.redo(); await idle();
  out.redo = { vol: vol() };
  return out;
})()
