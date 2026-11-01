(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const H = window.__HOME + String.raw`\.mbvisual`;
  const files = [
    H + String.raw`\step-prove\piccolo.stp`,
    H + String.raw`\ipt-campioni\gpr20_cartesian_arm\assemblies\misc\2inx100cm_pipe.ipt`,
    H + String.raw`\solidcad-campioni\AmboVent-1690-108__AmboVent\1690-20-8311.SLDPRT`,
    H + String.raw`\solidcad-campioni\ansys__example-data\gingerbread.x_t`,
    window.__ROOT + String.raw`\tests\samples\cubo.stl`,
    window.__ROOT + String.raw`\tests\samples\cubo.obj`,
  ];
  const out = [];
  for (const f of files) {
    if (!(await fetch("/api/stat?path=" + encodeURIComponent(f)).then(r => r.json()).catch(() => ({}))).ok) { out.push({ file: f, saltato: "campione assente" }); continue; }
    const r = { file: f.split("\\").pop() };
    const t0 = performance.now();
    try {
      await MB.openFile(f);
      let btn = null;
      for (let i = 0; i < 240 && !btn; i++) { await sleep(500); btn = [...MB.active.view.querySelectorAll(".tb button")].find(b => b.textContent.includes("Modifica modello")); }
      if (!btn) { r.err = "pulsante non trovato, viewer " + MB.active.viewer; out.push(r); continue; }
      r.viewer = MB.active.viewer;
      const n0 = MB.tabs.length;
      btn.click();
      for (let i = 0; i < 400 && !(MB.tabs.length > n0 && MB.active.api?._md?.res); i++) await sleep(500);
      const a = MB.active.api._md;
      r.tab = MB.active.name;
      r.sec = Math.round((performance.now() - t0) / 100) / 10;
      const bodies = a.res.bodies.map(b => ({ id: b.id, kind: b.kind, vol: a.bodyData(b.id).props.vol }));
      r.n = bodies.length; r.kinds = [...new Set(bodies.map(b => b.kind))]; r.vol = Math.round(bodies.reduce((s, b) => s + b.vol, 0) * 1000) / 1000;
      // modifica: spingi/tira di 2 mm sulla faccia piana piu' grande del primo corpo solido (mesh: spostamento)
      const b0 = bodies.find(b => b.kind === "solid") || bodies[0], d = a.bodyData(b0.id);
      const { makeRef } = await import("/js/modeler/mdoc.js");
      if (b0.kind === "solid") {
        const fi = d.faces.map((f, i) => [f, i]).filter(([f]) => f.t === "plane").sort((x, y) => y[0].a - x[0].a)[0][1];
        r.faccia = Math.round(d.faces[fi].a * 1000) / 1000;
        a.commitFeature({ type: "pushpull", face: makeRef(b0.id, "f", d.faces[fi]), d: 2 });
      } else a.commitFeature({ type: "transform", bodies: [b0.id], tf: { k: "move", v: [10, 0, 0] } });
      for (let i = 0; i < 100 && a.loop; i++) await sleep(200);
      const last = a.res.features.at(-1);
      r.modifica = last.ok ? "ok" : last.err + " " + (last.args || []).join(" ");
      r.vol2 = Math.round(a.res.bodies.reduce((s, b) => s + a.bodyData(b.id).props.vol, 0) * 1000) / 1000;
      r.dv = Math.round((r.vol2 - r.vol) * 1000) / 1000; r.atteso = r.faccia ? Math.round(r.faccia * 2 * 1000) / 1000 : 0;
    } catch (e) { r.err = e.message; }
    out.push(r);
  }
  return out;
})()
