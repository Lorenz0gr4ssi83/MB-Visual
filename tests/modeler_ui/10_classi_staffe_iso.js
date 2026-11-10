// classi di tubazione e numero di linea, staffaggi dal pannello della tubazione, distinta per classe, isometrici PDF,
// simboli P&ID nell'editor di diagrammi
(async () => {
  const { A, click, move, type, enter, idle, sleep } = T;
  const out = {};
  const p = window.__OUT + "\\classi.mbmod";
  await fetch("/api/save?path=" + encodeURIComponent(p), { method: "POST", body: "" });
  await MB.openFile(p);
  for (let i = 0; i < 60 && !(MB.active?.name === "classi.mbmod" && MB.active?.api?._md?.res); i++) await sleep(500);
  const a = A();
  for (let i = 0; i < 20 && a.view.canvas.getBoundingClientRect().height < 200; i++) { window.dispatchEvent(new Event("resize")); await sleep(250); }
  a.view.fit([0.6, -0.8, 0.55], new (a.view.bbox().constructor)().setFromCenterAndSize(new (a.view.bbox().min.constructor)(1500, 500, 1000), new (a.view.bbox().min.constructor)(4000, 2000, 2000)));
  await sleep(300);
  const meta = id => a.res.bodies.find(b => b.id === id)?.meta;
  // ---- tubazione in inox 316L (classe B1), linea 080-B1-001, a quota 1500: 3000 lungo X, 1000 lungo Y
  a.startRoute({ kind: "pipe" }); await sleep(100);
  const rt = a.tool;
  const selects = [...a.right.querySelectorAll("select.field")];
  const cls = selects.find(s => [...s.options].some(o => o.value === "B1"));
  cls.value = "B1"; cls.dispatchEvent(new Event("change")); await sleep(50);
  rt.pickSize("DN80"); rt.elev = 1500; rt.render();
  const ln = [...a.right.querySelectorAll("input.field")].find(i => i.placeholder === "100-A1-001");
  ln.value = "080-B1-001"; ln.dispatchEvent(new Event("change"));
  for (let i = 0; i < 3; i++) { a.view.fit([0.6, -0.8, 0.55], new (a.view.bbox().constructor)().setFromCenterAndSize(new (a.view.bbox().min.constructor)(1500, 500, 1000), new (a.view.bbox().min.constructor)(4000, 2000, 2000))); a.view.draw?.(); await sleep(300); }
  await click([0, 0, 1500]);
  if (!rt.pts.length) { const r0 = a.view.canvas.getBoundingClientRect(); return { diag: true, tool: a.tool?.constructor?.name, stesso: a.tool === rt, xy: T.xy([0, 0, 1500]), rect: [r0.left, r0.top, r0.width, r0.height], cand: (() => { try { const q = T.xy([0, 0, 1500]); return rt.candidate(new PointerEvent("pointermove", { clientX: q[0], clientY: q[1] })); } catch (e) { return String(e); } })() }; }
  await move([1000, 0, 1500]); await type("3000"); await enter();
  await move([3000, 400, 1500]); await type("1000"); await enter();
  await T.key("Enter"); await idle();
  if (!a.res.bodies.length) return { errore: T.feats(), punti: rt.pts, attiva: MB.active?.name };
  const pipe = a.res.bodies.at(-1).id, m = meta(pipe);
  out.classe = { spec: m?.spec, linea: m?.linea, t: m?.t, od: m?.od, attesoT: 3.05, mat: m?.materiale };
  // ---- staffe a pavimento dal pannello (quota proposta sotto il tubo), poi quota 0
  a.view.selection = [{ kind: "body", body: pipe }]; a.selChanged(); await sleep(80);
  [...a.right.querySelectorAll(".md-quick .btn")].find(b => /pavimento|Floor/i.test(b.textContent)).click(); await sleep(100);
  a.tool.v.z = 0; a.tool.render(); a.tool.schedule?.(); await sleep(300); await idle();
  [...a.right.querySelectorAll(".btn.primary")][0].click(); await sleep(200); await idle();
  const sup = a.res.bodies.at(-1);
  out.staffe = { feats: T.feats(), quantita: sup.meta?.quantita, altezze: sup.meta?.altezze, attesa: Math.round((1500 - 44.45) * 10) / 10 };
  // ---- distinta: riga del tubo con classe e materiale, staffe con quantita' e lunghezza dei montanti
  const { bom, bomTable } = await import("/js/modeler/mplant.js");
  out.distinta = bomTable(bom(a)).rows;
  // ---- isometrici in PDF (senza finestra di scelta: si chiama il motore come fa il pulsante)
  const { isoData } = await import("/js/modeler/mbom.js");
  const data = isoData(a);
  out.iso_dati = { linee: data.linee.length, linea: data.linee[0]?.linea, supporti: data.linee[0]?.supporti.length };
  const { job } = await import("/js/modeler/mkernel.js");
  const ip = window.__OUT + "\\isometrici.pdf";
  const r = await job("iso", { path: ip, data, fmt: "pdf" });
  out.iso = r;
  // ---- P&ID: nuovo diagramma, simboli dello stencil aperto e trascinabili
  const vp = window.__OUT + "\\Schema P&ID.vsdx";
  const { blankVsdx } = await import("/js/vsdmodel.js");
  const bytes = await blankVsdx();
  await fetch("/api/save?path=" + encodeURIComponent(vp), { method: "POST", body: bytes });
  await MB.openFile(vp);
  for (let i = 0; i < 40 && !MB.active?.api?._vs; i++) await sleep(300);
  await sleep(500);
  const names = [...document.querySelectorAll(".vs-stname")].map(e => e.textContent);
  out.pid = { simboli: names.length, valvola: names.some(n => /saracinesca|Gate/i.test(n)), pompa: names.some(n => /Pompa|pump/i.test(n)) };
  return out;
})()
