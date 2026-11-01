// salva il modello in .mbmod e in tutti i formati, poi riapre il .mbmod e confronta i corpi
(async () => {
  const { A, bodies, sleep } = T;
  const a = A();
  const dir = window.__OUT;
  const out = {};
  const before = bodies();
  await a.save(dir + "\\pezzo.mbmod");
  for (const f of ["step", "iges", "brep", "stl", "obj", "glb", "gltf"]) {
    const t0 = performance.now();
    try { await a.save(dir + "\\pezzo." + f); out[f] = Math.round(performance.now() - t0) + " ms"; } catch (e) { out[f] = "ERRORE " + e.message; }
  }
  await MB.openFile(dir + "\\pezzo.mbmod");
  for (let i = 0; i < 60 && !(MB.active.api?._md?.res); i++) await sleep(500);
  const b = MB.active.api._md;
  await sleep(500);
  const after = (b.res.bodies || []).map(x => ({ id: x.id, vol: +(b.bodyData(x.id).props.vol).toFixed(3) }));
  out.riapertura = { scheda: MB.active.name, errori: (b.res.features || []).filter(f => !f.ok).length, corpi: after.length,
    uguale: JSON.stringify(after) === JSON.stringify(before.map(x => ({ id: x.id, vol: x.vol }))) };
  return out;
})()
