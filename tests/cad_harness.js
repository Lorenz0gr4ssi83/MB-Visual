// Strumenti per collaudare l'editor CAD dalla console del browser (python app.py --browser --no-open).
// Uso: incollare nella console, poi await H.open("C:\\...\\disegno.dwg"); H.edit(); H.click(x, y); await H.cmd("L"); ...
// Le coordinate sono quelle del disegno; gli elementi dell'interfaccia sono quelli della linguetta visibile.
window.H = (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const vis = sel => [...document.querySelectorAll(sel)].find(x => x.offsetParent);
  const cad = () => [...document.querySelectorAll("*")].filter(e => e.__cad && e.offsetParent).pop()?.__cad;
  const H = {
    sleep, cad, vis,
    async open(path) { await window.MB.openPaths([path]); for (let i = 0; i < 60 && !cad(); i++) await sleep(250); await sleep(400); return cad(); },
    edit() { const b = [...document.querySelectorAll("button")].find(b => b.offsetParent && /Modifica disegno/.test(b.textContent)); if (!b.classList.contains("on")) b.click(); },
    toScreen(x, y) { const c = cad(), v = c.view, cv = c.canvas(), r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; return [r.left + (x * v.s + v.tx) / d, r.top + (v.ty - y * v.s) / d]; },
    ev(type, x, y, o = {}) { const [cx, cy] = H.toScreen(x, y); cad().canvas().dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, pointerId: 1, ...o })); },
    move(x, y, o = {}) { H.ev("pointermove", x, y, { buttons: 0, ...o }); },
    click(x, y, o = {}) { H.move(x, y, o); H.ev("pointerdown", x, y, o); H.ev("pointerup", x, y, o); },
    drag(x0, y0, x1, y1, o = {}) { H.ev("pointerdown", x0, y0, o); H.ev("pointermove", (x0 + x1) / 2, (y0 + y1) / 2, o); H.ev("pointermove", x1, y1, o); H.ev("pointerup", x1, y1, o); },
    key(k, o = {}) { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...o })); },
    async cmd(s) { for (const ch of s) H.key(ch); H.key("Enter"); await sleep(30); },
    async type(s) { const i = vis(".cad-input"); i.value = s; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(30); },
    prompt: () => vis(".cad-prompt")?.textContent,
    sel() { return vis(".cad-props")?.innerText.split("\n")[0]; },
    db: () => cad().db,
    last: (n = 1) => cad().db.entities.slice(-n),
  };
  return H;
})();
