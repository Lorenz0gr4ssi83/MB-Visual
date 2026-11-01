(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const H = window.__HOME + String.raw`\.mbvisual`;
  const out = [];
  for (const [f, is3d] of [[H + String.raw`\ipt-campioni\gpr20_vna_holder\assemblies\vna_holder.iam`, false], [H + String.raw`\dwg3d-campioni\acadsharp\sample_AC1032.dwg`, true], [H + String.raw`\dwg3d-campioni\acadsharp\sample_AC1015.dwg`, true]]) {
    if (!(await fetch("/api/stat?path=" + encodeURIComponent(f)).then(r => r.json()).catch(() => ({}))).ok) { out.push({ file: f, saltato: "campione assente" }); continue; }
    const r = { file: f.split("\\").pop() };
    const t0 = performance.now();
    try {
      await MB.openFile(f);
      if (is3d) { for (let i = 0; i < 60 && !MB.active.api?.show3d; i++) await sleep(500); if (!MB.active.api.view3d) await MB.active.api.show3d(); }
      let btn = null;
      for (let i = 0; i < 400 && !btn; i++) { await sleep(500); btn = [...MB.active.view.querySelectorAll(".tb button")].find(b => b.textContent.includes("Modifica modello") && b.offsetParent); }
      if (!btn) { r.err = "pulsante non trovato"; out.push(r); continue; }
      const n0 = MB.tabs.length;
      btn.click();
      for (let i = 0; i < 600 && !(MB.tabs.length > n0 && MB.active.api?._md?.res); i++) await sleep(500);
      const a = MB.active.api._md;
      r.sec = Math.round((performance.now() - t0) / 100) / 10;
      const bodies = a.res.bodies.map(b => ({ id: b.id, kind: b.kind, vol: a.bodyData(b.id).props.vol }));
      r.n = bodies.length; r.solidi = bodies.filter(b => b.kind === "solid").length; r.mesh = bodies.filter(b => b.kind === "mesh").length;
      r.vol = Math.round(bodies.reduce((s, b) => s + b.vol, 0));
      r.nomi = a.bodyList().slice(0, 4).map(b => b.name);
    } catch (e) { r.err = e.message; }
    out.push(r);
  }
  return out;
})()
