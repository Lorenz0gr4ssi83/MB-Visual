// Lettore DXF ASCII: produce la stessa struttura del database DWG (entita', layer, blocchi), angoli in radianti.
const D2R = Math.PI / 180;

export function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (isNaN(code)) { i--; continue; }
    pairs.push([code, lines[i + 1]]);
  }
  const layers = [], blocks = [], entities = [];
  let i = 0;
  const next = () => pairs[i++];
  const peek = () => pairs[i];

  function readEntity(type) {
    const g = [];
    while (i < pairs.length && pairs[i][0] !== 0) g.push(next());
    return toEntity(type, g);
  }

  function readEntities(list, endMarker) {
    while (i < pairs.length) {
      const [c, v] = peek();
      if (c !== 0) { i++; continue; }
      const t = v.trim();
      if (t === endMarker || t === "ENDSEC") return;
      i++;
      if (t === "POLYLINE") {
        const e = readEntity("POLYLINE");
        e.vertices = [];
        while (i < pairs.length && peek()[0] === 0 && peek()[1].trim() === "VERTEX") {
          i++;
          const v = readEntity("VERTEX");
          e.vertices.push(v);
        }
        if (i < pairs.length && peek()[1].trim() === "SEQEND") { i++; readEntity("SEQEND"); }
        e.type = e.flag & 8 ? "POLYLINE3D" : "POLYLINE2D";
        list.push(e);
      } else if (t === "INSERT") {
        const e = readEntity("INSERT");
        e.attribs = [];
        if (e._attribsFollow) {
          while (i < pairs.length && peek()[0] === 0 && peek()[1].trim() === "ATTRIB") { i++; e.attribs.push(readEntity("ATTRIB")); }
          if (i < pairs.length && peek()[1].trim() === "SEQEND") { i++; readEntity("SEQEND"); }
        }
        list.push(e);
      } else {
        list.push(readEntity(t));
      }
    }
  }

  while (i < pairs.length) {
    const [c, v] = next();
    if (c !== 0 || v.trim() !== "SECTION") continue;
    const [, name] = next();
    const sec = name.trim();
    if (sec === "ENTITIES") {
      readEntities(entities, "ENDSEC");
    } else if (sec === "BLOCKS") {
      while (i < pairs.length) {
        const [bc, bv] = next();
        if (bc === 0 && bv.trim() === "ENDSEC") break;
        if (bc === 0 && bv.trim() === "BLOCK") {
          const g = [];
          while (i < pairs.length && pairs[i][0] !== 0) g.push(next());
          const b = { name: val(g, 2) || val(g, 3), basePoint: pt(g, 10), entities: [] };
          readEntities(b.entities, "ENDBLK");
          if (i < pairs.length && peek()[1].trim() === "ENDBLK") { i++; readEntity("ENDBLK"); }
          blocks.push(b);
        }
      }
    } else if (sec === "TABLES") {
      while (i < pairs.length) {
        const [tc, tv] = next();
        if (tc === 0 && tv.trim() === "ENDSEC") break;
        if (tc === 0 && tv.trim() === "LAYER") {
          const g = [];
          while (i < pairs.length && pairs[i][0] !== 0) g.push(next());
          const name = val(g, 2);
          if (name === undefined) continue;
          const ci = num(g, 62, 7);
          const flags = num(g, 70, 0);
          const tc420 = val(g, 420);
          layers.push({ name, colorIndex: Math.abs(ci), color: tc420 !== undefined ? parseInt(tc420, 10) : undefined, off: ci < 0, frozen: !!(flags & 1) });
        }
      }
    }
  }
  return { entities, tables: { LAYER: { entries: layers }, BLOCK_RECORD: { entries: blocks } } };
}

function val(g, code) { const p = g.find(x => x[0] === code); return p ? p[1].trim() : undefined; }
function num(g, code, def = 0) { const v = val(g, code); return v === undefined ? def : parseFloat(v); }
function pt(g, code) { return { x: num(g, code), y: num(g, code + 10), z: num(g, code + 20) }; }
function all(g, code) { return g.filter(x => x[0] === code).map(x => parseFloat(x[1])); }

function toEntity(type, g) {
  const e = { type, layer: val(g, 8) || "0", colorIndex: val(g, 62) !== undefined ? num(g, 62) : 256 };
  if (val(g, 5) !== undefined) e.handle = String(val(g, 5)).trim(); // identificativo: serve all'editor per modificare il file originale
  if (val(g, 420) !== undefined) { e.color = parseInt(val(g, 420), 10); e.colorIndex = undefined; }
  if (num(g, 67) === 1) e.isInPaperSpace = true;
  if (num(g, 60) === 1) e.isVisible = false;
  switch (type) {
    case "LINE": e.startPoint = pt(g, 10); e.endPoint = pt(g, 11); break;
    case "XLINE": case "RAY": e.firstPoint = pt(g, 10); e.unitDirection = pt(g, 11); break;
    case "POINT": e.position = pt(g, 10); break;
    case "CIRCLE": e.center = pt(g, 10); e.radius = num(g, 40); break;
    case "ARC": e.center = pt(g, 10); e.radius = num(g, 40); e.startAngle = num(g, 50) * D2R; e.endAngle = num(g, 51) * D2R; break;
    case "ELLIPSE": e.center = pt(g, 10); e.majorAxisEndPoint = pt(g, 11); e.axisRatio = num(g, 40, 1); e.startAngle = num(g, 41, 0); e.endAngle = num(g, 42, Math.PI * 2); break;
    case "LWPOLYLINE": {
      e.flag = num(g, 70);
      e.vertices = [];
      let cur = null;
      for (const [c, v] of g) {
        if (c === 10) { cur = { x: parseFloat(v), y: 0, bulge: 0 }; e.vertices.push(cur); }
        else if (c === 20 && cur) cur.y = parseFloat(v);
        else if (c === 42 && cur) cur.bulge = parseFloat(v);
      }
      break;
    }
    case "POLYLINE": e.flag = num(g, 70); break;
    case "VERTEX": e.point = pt(g, 10); e.x = e.point.x; e.y = e.point.y; e.z = e.point.z; e.bulge = num(g, 42); e.flag = num(g, 70); break;
    case "TEXT": case "ATTRIB": case "ATTDEF":
      e.text = val(g, 1) || ""; e.startPoint = pt(g, 10); e.endPoint = pt(g, 11); e.textHeight = num(g, 40, 1);
      e.rotation = num(g, 50) * D2R; e.halign = num(g, 72); e.valign = num(g, type === "TEXT" ? 73 : 74); e.xScale = num(g, 41, 1);
      if (type === "ATTDEF") e.type = "ATTDEF";
      if (num(g, 70) & 1) e.isVisible = false;
      break;
    case "MTEXT":
      e.text = g.filter(x => x[0] === 3).map(x => x[1]).join("") + (val(g, 1) || "");
      e.insertionPoint = pt(g, 10); e.textHeight = num(g, 40, 1); e.rectWidth = num(g, 41); e.attachmentPoint = num(g, 71, 1);
      e.rotation = num(g, 50) * D2R;
      if (val(g, 11) !== undefined) e.direction = pt(g, 11);
      break;
    case "INSERT":
      e.name = val(g, 2); e.insertionPoint = pt(g, 10); e.xScale = num(g, 41, 1); e.yScale = num(g, 42, 1);
      e.rotation = num(g, 50) * D2R; e.columnCount = num(g, 70, 1); e.rowCount = num(g, 71, 1);
      e.columnSpacing = num(g, 44); e.rowSpacing = num(g, 45); e._attribsFollow = num(g, 66) === 1;
      break;
    case "DIMENSION": e.name = val(g, 2); e.text = val(g, 1); e.textPoint = pt(g, 11); e.measurement = num(g, 42); break;
    case "SOLID": case "TRACE": case "3DFACE":
      e.corner1 = pt(g, 10); e.corner2 = pt(g, 11); e.corner3 = pt(g, 12); e.corner4 = pt(g, 13); break;
    case "SPLINE": {
      e.degree = num(g, 71, 3); e.flag = num(g, 70); e.knots = all(g, 40); e.weights = all(g, 41);
      const xs = all(g, 10), ys = all(g, 20), zs = all(g, 30);
      e.controlPoints = xs.map((x, k) => ({ x, y: ys[k] || 0, z: zs[k] || 0 }));
      const fx = all(g, 11), fy = all(g, 21);
      e.fitPoints = fx.map((x, k) => ({ x, y: fy[k] || 0, z: 0 }));
      break;
    }
    case "LEADER": { const xs = all(g, 10), ys = all(g, 20); e.vertices = xs.map((x, k) => ({ x, y: ys[k] || 0, z: 0 })); break; }
    case "HATCH": e.solidFill = num(g, 70); e.boundaryPaths = parseHatchPaths(g); break;
    default: break;
  }
  return e;
}

function parseHatchPaths(g) {
  // percorre i gruppi del contorno: 92 (tipo percorso), 72/73/93 e i lati
  const paths = [];
  let k = g.findIndex(x => x[0] === 91);
  if (k < 0) return paths;
  const n = parseInt(g[k][1], 10);
  k++;
  const at = c => (g[k] && g[k][0] === c ? parseFloat(g[k++][1]) : undefined);
  for (let p = 0; p < n && k < g.length; p++) {
    while (k < g.length && g[k][0] !== 92) k++;
    const flag = at(92);
    if (flag & 2) {
      const hasBulge = at(72), closed = at(73), nv = at(93);
      const verts = [];
      for (let v = 0; v < nv; v++) {
        const x = at(10), y = at(20);
        const b = hasBulge ? at(42) || 0 : 0;
        verts.push({ x, y, bulge: b });
      }
      paths.push({ boundaryPathTypeFlag: flag, vertices: verts, isClosed: !!closed });
    } else {
      const ne = at(93);
      const edges = [];
      for (let ed = 0; ed < ne && k < g.length; ed++) {
        const t = at(72);
        if (t === 1) edges.push({ type: 1, start: { x: at(10), y: at(20) }, end: { x: at(11), y: at(21) } });
        else if (t === 2) edges.push({ type: 2, center: { x: at(10), y: at(20) }, radius: at(40), startAngle: at(50) * D2R, endAngle: at(51) * D2R, isCCW: at(73) !== 0 });
        else if (t === 3) edges.push({ type: 3, center: { x: at(10), y: at(20) }, end: { x: at(11), y: at(21) }, lengthOfMinorAxis: at(40), startAngle: at(50) * D2R, endAngle: at(51) * D2R, isCCW: at(73) !== 0 });
        else if (t === 4) {
          const deg = at(94); at(73); at(74); const nk = at(95), nc = at(96);
          const knots = []; for (let q = 0; q < nk; q++) knots.push(at(40));
          const cps = []; for (let q = 0; q < nc; q++) { const x = at(10), y = at(20); const w = g[k] && g[k][0] === 42 ? at(42) : undefined; cps.push({ x, y, weight: w }); }
          edges.push({ type: 4, degree: deg, knots, controlPoints: cps });
          while (k < g.length && ![72, 92, 97].includes(g[k][0])) k++;
        } else break;
      }
      paths.push({ boundaryPathTypeFlag: flag, edges });
    }
    while (k < g.length && g[k][0] !== 92 && g[k][0] !== 75) k++;
  }
  return paths;
}
