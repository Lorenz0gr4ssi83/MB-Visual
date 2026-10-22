// Solidi di prova per il collaudo delle interferenze (tests/test_clash.mjs): scatole e cilindri come triangoli chiusi
export function box(x0, y0, z0, x1, y1, z1) {
  const pos = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const idx = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { pos, idx };
}
// cilindro con asse da (ax, ay, az) lungo l'asse principale "x" | "y" | "z", raggio r, lunghezza len, n lati
export function cylinder(ax, ay, az, axis, r, len, n = 24) {
  const pts = [], idx = [];
  const put = (u, v, w) => { // u lungo l'asse
    if (axis === "x") pts.push(ax + u, ay + v, az + w);
    else if (axis === "y") pts.push(ax + v, ay + u, az + w);
    else pts.push(ax + v, ay + w, az + u);
  };
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; put(0, r * Math.cos(a), r * Math.sin(a)); put(len, r * Math.cos(a), r * Math.sin(a)); }
  const c0 = 2 * n, c1 = 2 * n + 1;
  put(0, 0, 0); put(len, 0, 0);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a0 = 2 * i, a1 = 2 * i + 1, b0 = 2 * j, b1 = 2 * j + 1;
    idx.push(a0, b0, b1, a0, b1, a1, c0, b0, a0, c1, a1, b1);
  }
  return { pos: new Float32Array(pts), idx: new Uint32Array(idx) };
}
