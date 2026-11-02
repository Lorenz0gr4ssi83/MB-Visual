window.T = (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const A = () => MB.active.api._md;
  const cv = () => A().view.canvas;
  const xy = p => { const v = A().view; v.camera.updateMatrixWorld(); const s = v.toScreen(p); const r = cv().getBoundingClientRect(); return [r.left + s[0], r.top + s[1]]; };
  const ev = (type, [x, y], o = {}) => cv().dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, button: o.button ?? 0, buttons: o.buttons ?? 0, pointerId: 1, pointerType: "mouse", ctrlKey: !!o.ctrl, shiftKey: !!o.shift }));
  const at = (p, o) => (Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && o?.screen ? p : xy(p));
  async function move(p, o = {}) { ev("pointermove", at(p, o), o); await sleep(30); }
  async function click(p, o = {}) {
    const c = at(p, o);
    ev("pointermove", c, o); await sleep(20);
    ev("pointerdown", c, { ...o, buttons: 1 }); await sleep(20);
    ev("pointerup", c, o); window.dispatchEvent(new PointerEvent("pointerup", { clientX: c[0], clientY: c[1], bubbles: true }));
    await sleep(40);
  }
  async function dbl(p, o = {}) { await click(p, o); await click(p, o); cv().dispatchEvent(new MouseEvent("dblclick", { clientX: at(p, o)[0], clientY: at(p, o)[1], bubbles: true })); await sleep(40); }
  async function key(k, o = {}) { const t = document.activeElement && document.activeElement !== document.body ? document.activeElement : window; t.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ctrlKey: !!o.ctrl, shiftKey: !!o.shift })); await sleep(30); }
  async function type(str) {
    for (const ch of str) {
      const inp = document.querySelector(".md-vinput");
      if (inp && document.activeElement === inp) { inp.value += ch; }
      else await key(ch);
    }
    await sleep(30);
  }
  async function enter() { const inp = document.activeElement; inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await sleep(60); }
  // punto nel piano dello schizzo attivo (coordinate u,v) -> mondo
  const sk = (u, v) => { const pl = A().sketch.pl; return pl.o.map((o, i) => o + pl.x[i] * u + pl.y[i] * v); };
  const idle = async () => { for (let i = 0; i < 200 && (A().loop || A().busy); i++) await sleep(100); await sleep(60); };
  const bodies = () => (A().res?.bodies || []).map(b => ({ id: b.id, vol: +(A().bodyData(b.id)?.props?.vol || 0).toFixed(3), area: +(A().bodyData(b.id)?.props?.area || 0).toFixed(3), bbox: A().bodyData(b.id)?.bbox?.map(x => +x.toFixed(3)), facce: A().bodyData(b.id)?.props?.facce }));
  const feats = () => (A().res?.features || []).map(f => f.ok ? f.id : f.id + ":" + f.err);
  return { A, xy, move, click, dbl, key, type, enter, sk, idle, bodies, feats, sleep };
})(); "ok"
