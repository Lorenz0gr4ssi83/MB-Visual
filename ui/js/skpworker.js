// Lettura dei file SketchUp (.skp) in un Worker, senza SketchUp: libreria OpenSKP (MIT, ui/vendor/openskp).
// Restituisce la scena a istanze (geometria di ogni definizione una volta sola + matrici dei gruppi/componenti),
// gli spigoli visibili di ogni definizione, materiali e texture, tag (layer) e scene, gia' in metri con Y verso l'alto.
import { _parseToRaw, _buildInstancedSceneFromParsed, buildModelFromParsed } from "../vendor/openskp/dist/index.mjs"; // relativo: vale anche nella web app (sottocartella)

const IN = 0.0254; // pollici -> metri
const toY = (x, y, z) => [x * IN, z * IN, -y * IN]; // SketchUp (Z in alto) -> scena (Y in alto)


self.onmessage = ev => {
  const { buffer } = ev.data;
  const post = (m, t) => self.postMessage(m, t || []);
  try {
    let last = 0;
    const onProgress = p => {
      const now = Date.now();
      if (now - last < 150) return;
      last = now;
      post({ progress: p.total ? Math.min(1, p.current / p.total) : 0, stage: p.stage });
    };
    const raw = _parseToRaw(buffer, { onProgress });
    post({ progress: 0.7, stage: "legacy_defs" });
    const model = buildModelFromParsed(raw);
    post({ progress: 0.8, stage: "build_scene" });
    // facce senza materiale: OpenSKP usa il colore del tag, SketchUp il materiale predefinito (quasi bianco)
    for (const k of raw.layerColors.keys()) raw.layerColors.set(k, [236, 236, 230]);
    const sc =_buildInstancedSceneFromParsed(raw, { onProgress });
    const transfer = new Set(); // un buffer si trasferisce una volta sola (piu' viste possono condividerlo)

    // definizioni: per id e per nome (i nodi senza facce portano solo il nome della definizione)
    const defById = new Map([["ROOT", model.root]]);
    for (const [id, d] of model.definitions) defById.set(id, d);
    const idByName = new Map();
    for (const [id, d] of defById) if (!idByName.has(d.name)) idByName.set(d.name, id);
    const resDef = new Map(sc.meshResources.map(r => [r.id, r.definitionId]));

    // spigoli visibili (non nascosti, non morbidi/levigati), nello spazio locale della definizione
    const edges = {};
    const edgesOf = id => {
      if (id === undefined || id in edges) return;
      const d = defById.get(id);
      if (!d || !d.edges.length) { edges[id] = null; return; }
      const vs = new Map();
      for (const v of d.vertices) vs.set(v.id, v);
      const out = new Float32Array(d.edges.length * 6);
      let n = 0;
      for (const e of d.edges) {
        if (e.hidden || e.soft || e.smooth) continue;
        const a = vs.get(e.v1Id), b = vs.get(e.v2Id);
        if (!a || !b) continue;
        out.set(toY(a.x, a.y, a.z), n); out.set(toY(b.x, b.y, b.z), n + 3);
        n += 6;
      }
      edges[id] = n ? out.slice(0, n) : null;
      if (edges[id]) transfer.add(edges[id].buffer);
    };

    // gerarchia dei gruppi e componenti (solo i campi che servono alla vista e alle proprieta')
    const strip = node => {
      const defId = node.meshResourceId ? resDef.get(node.meshResourceId) : idByName.get(node.definitionName);
      edgesOf(defId);
      return {
        name: node.name, generated: node.nameIsGenerated, def: node.definitionName, defId, layer: node.layer, matrix: node.matrix,
        pos: node.positionMm, guid: node.guid, props: node.properties, dicts: node.attributeDictionaries,
        mesh: node.meshResourceId || null, children: (node.children || []).map(strip),
      };
    };
    const root = strip(sc.sceneHierarchy);

    const resources = sc.meshResources.map(r => ({
      id: r.id, defId: r.definitionId,
      prims: r.primitives.map(p => {
        for (const a of [p.positions, p.normals, p.uvs, p.indices]) transfer.add(a.buffer);
        return { positions: p.positions, normals: p.normals, uvs: p.uvs, indices: p.indices, mat: p.materialIndex };
      }),
    }));
    // texture con il materiale SketchUp da cui vengono: colorizzata o no, colore medio, opacita' vera
    // (nella scena glTF la texture e' moltiplicata per il colore medio e l'opacita' include l'alfa del colore)
    const textures = sc.textures.map(t => {
      const m = model.materials.find(x => x.texture?.data && x.texture.data.length === t.data.length && x.texture.filename === t.filename)
        || model.materials.find(x => x.texture?.data && x.texture.data.length === t.data.length);
      return { data: t.data, mime: t.mimeType, name: t.filename, colorized: !!m?.colorized, color: m ? [m.color.r, m.color.g, m.color.b] : null, opacity: m ? m.transparency ?? 1 : 1 };
    });

    // nomi delle definizioni con le parti a facce (per la scheda: componente o gruppo)
    const defInfo = {};
    for (const [id, d] of defById) defInfo[id] = { name: d.name, guid: d.guid, faces: d.faces.length, image: d.isImage };

    const pages = model.pages.map(p => ({
      name: p.name, eye: p.eye && toY(...p.eye), target: p.target && toY(...p.target), up: p.up && toY(...p.up).map(v => v / IN),
      fov: p.fov, parallel: p.parallel, orthoHeight: (p.orthoHeight || 0) * IN, hiddenLayers: p.hiddenLayers || [],
    }));
    post({
      done: true, version: model.version, units: model.units, root, resources, edges, textures, defInfo,
      materials: sc.gltfMaterials, layers: model.layers.map(l => ({ name: l.name, color: l.color, hidden: !!(l.hidden || sc.layerHidden[l.name]) })),
      pages, materialsCount: model.materials.length,
    }, [...transfer]);
  } catch (e) {
    post({ error: e?.message || String(e), stage: e?.context?.stage });
  }
};
