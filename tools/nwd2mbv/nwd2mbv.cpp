// nwd2mbv - converte un file Navisworks (NWD/NWC) nel formato di scambio di MB Desk, senza Navisworks installato.
// Usa la libreria open source nwd-reader (https://github.com/1817716374/nwd-reader).
//
// Uso:  nwd2mbv INPUT.nwd OUTPUT_PREFIX
// Scrive OUTPUT_PREFIX.json (gerarchia, proprieta', elenco delle mesh) e OUTPUT_PREFIX.bin
// (coordinate float32 in metri, coordinate di mondo, e indici uint32 locali a ogni mesh).
#include <nwd/reader.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <numbers>
#include <cstdio>
#include <fstream>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

std::string esc(std::string_view s) {
  std::string o;
  o.reserve(s.size() + 2);
  for (unsigned char c : s) {
    switch (c) {
    case '"': o += "\\\""; break;
    case '\\': o += "\\\\"; break;
    case '\n': o += "\\n"; break;
    case '\r': o += "\\r"; break;
    case '\t': o += "\\t"; break;
    default:
      if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
      else o += static_cast<char>(c);
    }
  }
  return o;
}

std::string num(double v) {
  if (!std::isfinite(v)) return "null";
  char b[32];
  std::snprintf(b, sizeof b, "%.10g", v);
  return b;
}

struct Writer {
  std::ofstream bin;
  uint64_t floats = 0, ints = 0; // offsets in elements
  std::vector<float> fbuf;
  std::vector<uint32_t> ibuf;
};

// stringa della tabella di un grafo; vuota se il riferimento e' fuori tabella (alcuni file la hanno)
std::string str(const nwd::ObjectGraph &graph, nwd::Id id) {
  if (id == nwd::none) return "";
  try { return std::string(nwd::resolve_string(graph, id)); } catch (...) { return ""; }
}

// valore di una proprieta' in testo (stringhe, numeri, interi)
std::string value_text(const nwd::Model &model, const nwd::ObjectGraph &graph, const nwd::Value &v) {
  if (v.string != nwd::none) return str(graph, v.string);
  switch (v.tag) {
  case 1: case 6: case 7: case 10: case 11: return num(v.number[0]);
  default: break;
  }
  if (v.reference.object != nwd::none) {
    try {
      const auto &o = nwd::resolve_object(model, v.reference);
      return str(model.graphs.at(v.reference.graph), o.name);
    } catch (...) { return ""; }
  }
  return std::to_string(v.integer);
}

// colore di un materiale Autodesk (asset Protein): generic_diffuse o altro parametro colore, primi tre valori 0..1
bool asset_color(const nwd::Asset &asset, float *rgb, float &alpha) {
  try {
    auto d = nwd::describe_asset(asset);
    const nwd::AssetParameter *best = nullptr;
    int bestScore = 0;
    for (const auto &node : d.nodes)
      for (const auto &p : node.parameters) {
        std::string n = p.name;
        for (auto &c : n) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        int score = n == "generic_diffuse" ? 5 : n.find("diffuse") != std::string::npos ? 4 : n.find("tint_color") != std::string::npos ? 3 : n.find("color") != std::string::npos ? 2 : 0;
        if (score > bestScore && p.values_json.find('[') != std::string::npos) { best = &p; bestScore = score; }
      }
    if (!best) return false;
    // formato: [{"a":1,"b":0.3,"g":0.3,"r":0.3}] (chiavi in ordine alfabetico) oppure [0.3,0.3,0.3,1]
    const std::string &js = best->values_json;
    auto key = [&](const char *k, double &out) {
      auto p = js.find(std::string("\"") + k + "\":");
      if (p == std::string::npos) return false;
      out = std::strtod(js.c_str() + p + 4, nullptr);
      return true;
    };
    double v[4] = {0, 0, 0, 1};
    if (!(key("r", v[0]) && key("g", v[1]) && key("b", v[2]))) {
      int k = 0;
      const char *s = js.c_str();
      while (*s && k < 4) {
        if ((*s >= '0' && *s <= '9') || *s == '-' || *s == '.') { char *e; v[k++] = std::strtod(s, &e); s = e; } else ++s;
      }
      if (k < 3) return false;
    }
    bool bitmap = false;
    for (const auto &node : d.nodes) if (node.definition.find("Bitmap") != std::string::npos) bitmap = true;
    if (bitmap && v[0] < 0.02 && v[1] < 0.02 && v[2] < 0.02) return false; // colore dato da una texture: grigio neutro
    double mx = std::max({v[0], v[1], v[2]});
    double sc = mx > 1.0 ? 1.0 / 255.0 : 1.0; // alcuni materiali salvano 0..255
    for (int i = 0; i < 3; ++i) rgb[i] = static_cast<float>(v[i] * sc);
    (void)alpha;
    return true;
  } catch (...) { return false; }
}

void transform(const std::array<double, 16> &m, double s, const float *p, float *out) {
  double x = p[0], y = p[1], z = p[2];
  out[0] = static_cast<float>((m[0] * x + m[4] * y + m[8] * z + m[12]) * s);
  out[1] = static_cast<float>((m[1] * x + m[5] * y + m[9] * z + m[13]) * s);
  out[2] = static_cast<float>((m[2] * x + m[6] * y + m[10] * z + m[14]) * s);
}

} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
#else
int main(int argc, char **argv) {
#endif
  if (argc != 3) {
    std::cerr << "nwd2mbv INPUT.nwd OUTPUT_PREFIX\n";
    return 2;
  }
  std::filesystem::path input(argv[1]), prefix(argv[2]);
  try {
    Writer w;
    w.bin.open(std::filesystem::path(prefix).concat(".bin"), std::ios::binary);
    std::ostringstream nodes, props, meshes;
    nodes << "[";
    props << "{";
    meshes << "[";
    bool firstNode = true, firstProp = true, firstMesh = true;
    uint64_t nodeBase = 0, triangles = 0, skipped = 0;

    auto flushFloats = [&] {
      w.bin.write(reinterpret_cast<const char *>(w.fbuf.data()), static_cast<std::streamsize>(w.fbuf.size() * 4));
      w.floats += w.fbuf.size();
      w.fbuf.clear();
    };
    // mesh: posizioni (gia' trasformate) + indici locali; nel file prima le posizioni, poi gli indici
    auto emit = [&](uint64_t node, const char *kind, const std::vector<float> &pos, const std::vector<uint32_t> &idx,
                    const float *rgb, float alpha) {
      if (pos.empty()) return;
      uint64_t po = w.floats + w.ints;
      w.fbuf = pos;
      flushFloats();
      uint64_t io = w.floats + w.ints;
      w.bin.write(reinterpret_cast<const char *>(idx.data()), static_cast<std::streamsize>(idx.size() * 4));
      w.ints += idx.size();
      meshes << (firstMesh ? "" : ",") << "{\"n\":" << node << ",\"k\":\"" << kind << "\",\"p\":[" << po * 4 << ","
             << pos.size() / 3 << "],\"i\":[" << io * 4 << "," << idx.size() << "],\"c\":[" << num(rgb[0]) << ","
             << num(rgb[1]) << "," << num(rgb[2]) << "],\"a\":" << num(alpha) << "}";
      firstMesh = false;
    };

    // esporta un modello: gerarchia, proprieta' e geometria; rootParent = nodo che lo contiene (-1 = nessuno)
    size_t modelCount = 0;
    auto exportModel = [&](const nwd::Model &model, long long rootParent, double s,
                           const std::function<std::array<double, 16>(const nwd::Instance &, size_t)> &matrixOf) {
      ++modelCount;
      // gerarchia: un nodo per ogni percorso del modello
      for (size_t p = 0; p < model.paths.size(); ++p) {
        std::string name, cls;
        try {
          auto ref = nwd::path_reference(model, static_cast<nwd::Id>(p));
          const auto &graph = model.graphs.at(ref.graph);
          const auto &obj = nwd::resolve_object(model, ref);
          name = str(graph, obj.name);
          cls = str(graph, obj.class_name);
          // proprieta' collegate al nodo, per categoria
          std::ostringstream one;
          bool any = false;
          for (const auto &aref : obj.attributes) {
            try {
              const auto &attr = nwd::resolve_object(model, aref);
              const auto &ag = model.graphs.at(aref.graph);
              std::string aname = str(ag, attr.name), acls = str(ag, attr.class_name);
              std::string cat = aname.empty() || !attr.properties.empty() ? (acls.empty() ? aname : acls) : acls;
              if (attr.properties.empty()) {
                // attributo senza elenco di proprieta' (materiale, colore, layer...): si mostra il suo nome
                if (!aname.empty()) {
                  std::string label = attr.type == 200 ? "Materiale" : attr.type == 31 ? "Colore" : (acls.empty() ? "Attributo" : acls);
                  one << (any ? "," : "") << "[\"" << esc(label) << "\",\"Nome\",\"" << esc(aname) << "\"]";
                  any = true;
                }
                continue;
              }
              for (const auto &pr : attr.properties) {
                std::string pn = str(ag, pr.name);
                std::string pv = value_text(model, ag, pr.value);
                one << (any ? "," : "") << "[\"" << esc(cat.empty() ? aname : cat) << "\",\"" << esc(pn) << "\",\"" << esc(pv) << "\"]";
                any = true;
              }
            } catch (...) {
            }
          }
          if (any) {
            props << (firstProp ? "" : ",") << "\"" << nodeBase + p << "\":[" << one.str() << "]";
            firstProp = false;
          }
        } catch (...) {
        }
        auto parent = model.paths[p].parent;
        long long par = parent == nwd::none ? rootParent : static_cast<long long>(nodeBase + parent);
        nodes << (firstNode ? "" : ",") << "[" << par << ",\"" << esc(name) << "\",\"" << esc(cls) << "\"]";
        firstNode = false;
      }
      std::unordered_map<nwd::Id, std::array<float, 4>> assetColors;
      // geometria: un'istanza = una geometria condivisa + trasformazione + aspetto
      for (size_t ii = 0; ii < model.instances.size(); ++ii) {
        const auto &inst = model.instances[ii];
        try {
          if (inst.geometry_reference == nwd::none) continue;
          const auto &gref = model.geometry_references.at(inst.geometry_reference);
          if (gref.geometry == nwd::none) continue;
          const auto &g = model.geometries.at(gref.geometry);
          if (g.external) { ++skipped; continue; }
          auto m = matrixOf(inst, ii);
          float rgb[3] = {0.72f, 0.74f, 0.76f}, alpha = 1.f;
          if (inst.appearance != nwd::none && inst.appearance < model.appearances.size()) {
            auto asset = model.appearances[inst.appearance].asset;
            auto mat = model.appearances[inst.appearance].material;
            if (mat != nwd::none && mat < model.materials.size()) {
              auto d = model.materials[mat].diffuse();
              rgb[0] = d[0]; rgb[1] = d[1]; rgb[2] = d[2];
              alpha = 1.f - model.materials[mat].transparency();
            }
            // il colore vero dei materiali Autodesk (es. RAL) sta nell'asset: ha la precedenza sul materiale di base
            if (asset != nwd::none && asset < model.assets.size()) {
              auto it = assetColors.find(asset);
              if (it == assetColors.end()) {
                std::array<float, 4> c{-1, 0, 0, 1};
                float a = 1;
                if (asset_color(model.assets[asset], c.data(), a)) c[3] = a; else c[0] = -1;
                it = assetColors.emplace(asset, c).first;
              }
              if (it->second[0] >= 0) { rgb[0] = it->second[0]; rgb[1] = it->second[1]; rgb[2] = it->second[2]; }
            }
          }
          uint64_t node = nodeBase + (inst.path == nwd::none ? 0 : inst.path);
          std::vector<float> pos;
          std::vector<uint32_t> idx;
          float t[3];
          if (g.type == 94) { // strisce di triangoli
            auto tri = nwd::triangle_indices(g);
            std::unordered_map<uint32_t, uint32_t> remap;
            remap.reserve(tri.size());
            for (auto slot : tri) {
              auto it = remap.find(slot);
              if (it == remap.end()) {
                uint32_t ci = g.coordinate_indices.empty() ? slot : g.coordinate_indices[slot];
                transform(m, s, &g.coordinates[ci * 3], t);
                pos.insert(pos.end(), t, t + 3);
                it = remap.emplace(slot, static_cast<uint32_t>(pos.size() / 3 - 1)).first;
              }
              idx.push_back(it->second);
            }
            triangles += idx.size() / 3;
            emit(node, "t", pos, idx, rgb, alpha);
          } else if (g.type == 104 || g.type == 105) { // cerchio / cilindro parametrico
            const auto &q = g.parameters;
            const int N = 32;
            if (g.type == 104) {
              double r = q[12] != 0 ? q[12] : q[9];
              for (int k = 0; k < N; ++k) {
                double a = 2 * std::numbers::pi * k / N;
                float pt[3] = {static_cast<float>(q[0] + r * (std::cos(a) * q[3] + std::sin(a) * q[6])),
                               static_cast<float>(q[1] + r * (std::cos(a) * q[4] + std::sin(a) * q[7])),
                               static_cast<float>(q[2] + r * (std::cos(a) * q[5] + std::sin(a) * q[8]))};
                transform(m, s, pt, t);
                pos.insert(pos.end(), t, t + 3);
                idx.push_back(k);
                idx.push_back((k + 1) % N);
              }
              emit(node, "l", pos, idx, rgb, alpha);
            } else {
              double r = q[12];
              double ax[3] = {q[6], q[7], q[8]}, bx[3] = {q[9], q[10], q[11]};
              auto norm = [](double *v) { double l = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); if (l > 0) for (int i = 0; i < 3; ++i) v[i] /= l; };
              norm(ax); norm(bx);
              for (int end = 0; end < 2; ++end)
                for (int k = 0; k < N; ++k) {
                  double a = 2 * std::numbers::pi * k / N, c = std::cos(a) * r, sn = std::sin(a) * r;
                  float pt[3] = {static_cast<float>(q[end * 3 + 0] + c * ax[0] + sn * bx[0]),
                                 static_cast<float>(q[end * 3 + 1] + c * ax[1] + sn * bx[1]),
                                 static_cast<float>(q[end * 3 + 2] + c * ax[2] + sn * bx[2])};
                  transform(m, s, pt, t);
                  pos.insert(pos.end(), t, t + 3);
                }
              for (int k = 0; k < N; ++k) {
                uint32_t a = k, b = (k + 1) % N, c = N + k, d = N + (k + 1) % N;
                idx.insert(idx.end(), {a, b, d, a, d, c});
              }
              triangles += idx.size() / 3;
              emit(node, "t", pos, idx, rgb, alpha);
            }
          } else if (g.type == 103) {
            ++skipped; // testo: non disegnato
          } else if (!g.coordinates.empty()) { // polilinee e punti
            auto coord = [&](uint32_t slot) { return g.coordinate_indices.empty() ? slot : g.coordinate_indices[slot]; };
            if (!g.strip_lengths.empty() && !g.strip_indices.empty()) {
              size_t p = 0;
              for (auto n : g.strip_lengths) {
                for (uint32_t j = 0; j < n && p + j < g.strip_indices.size(); ++j) {
                  transform(m, s, &g.coordinates[coord(g.strip_indices[p + j]) * 3], t);
                  pos.insert(pos.end(), t, t + 3);
                  if (j) { idx.push_back(static_cast<uint32_t>(pos.size() / 3 - 2)); idx.push_back(static_cast<uint32_t>(pos.size() / 3 - 1)); }
                }
                p += n;
              }
              emit(node, "l", pos, idx, rgb, alpha);
            } else {
              size_t n = g.coordinate_indices.empty() ? g.coordinates.size() / 3 : g.coordinate_indices.size();
              for (size_t k = 0; k < n; ++k) {
                transform(m, s, &g.coordinates[coord(static_cast<uint32_t>(k)) * 3], t);
                pos.insert(pos.end(), t, t + 3);
                idx.push_back(static_cast<uint32_t>(k));
              }
              emit(node, "p", pos, idx, rgb, alpha);
            }
          }
        } catch (const std::exception &) {
          ++skipped;
        }
      }
      nodeBase += model.paths.size();
    };

    std::string ext = input.extension().string();
    for (auto &c : ext) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (ext == ".nwf") {
      // progetto federato: i file collegati (NWD/NWC/...) si leggono e si posizionano come in Navisworks
      nwd::ProjectOptions po;
      po.reader.threads = 4;
      po.search_paths.push_back(input.parent_path());
      auto project = nwd::load_project(input, po);
      // riferimenti mancanti (es. modelli Inventor o Revit su un altro disco): come Navisworks, si usa la versione
      // pubblicata con lo stesso nome (.nwc / .nwd) nella cartella del progetto
      bool remapped = false;
      for (const auto &pn : project.nodes) {
        if (pn.model != nwd::none || pn.requested_path.empty()) continue;
        std::string req = pn.requested_path;
        auto cut = req.find_last_of("\\/");
        std::string file = cut == std::string::npos ? req : req.substr(cut + 1);
        std::string stem = file.substr(0, file.find_last_of('.'));
        for (const char *e : {".nwc", ".nwd", ".nwf", ".NWC", ".NWD", ".NWF"}) {
          auto cand = input.parent_path() / (stem + e);
          if (std::filesystem::exists(cand) && cand != input) {
            po.remaps.emplace_back(req, cand);
            po.remaps.emplace_back(file, cand);
            remapped = true;
            break;
          }
        }
      }
      if (remapped) project = nwd::load_project(input, po);
      std::vector<long long> pnode(project.nodes.size(), -1);
      for (nwd::Id id = 0; id < project.nodes.size(); ++id) {
        const auto &pn = project.nodes[id];
        pnode[id] = static_cast<long long>(nodeBase++);
        long long par = pn.parent == nwd::none ? -1 : pnode[pn.parent];
        std::string nm = pn.name.empty() ? std::filesystem::path(pn.requested_path).filename().string() : pn.name;
        nodes << (firstNode ? "" : ",") << "[" << par << ",\"" << esc(nm) << "\",\"" << (pn.model == nwd::none ? "Progetto" : "File collegato") << "\"]";
        firstNode = false;
        if (pn.model == nwd::none && !pn.status.empty() && pn.status != "loaded")
          std::cerr << "riferimento non caricato: " << pn.requested_path << " (" << pn.status << ")\n";
      }
      for (nwd::Id id = 0; id < project.nodes.size(); ++id) {
        const auto &pn = project.nodes[id];
        if (pn.model == nwd::none || pn.source == nwd::none) continue;
        const auto &model = project.sources[pn.source].scene->models[pn.model];
        exportModel(model, pnode[id], 1.0, [&](const nwd::Instance &, size_t ii) { return nwd::project_world_matrix(project, id, static_cast<nwd::Id>(ii)); });
      }
      for (const auto &wn : project.warnings) std::cerr << "avviso: " << wn << "\n";
    } else {
      nwd::Options options;
      options.threads = 4;
      nwd::Document document(input, options);
      auto scene = document.read_scene();
      for (const auto &model : scene.models) {
        const double s = model.meters_per_unit > 0 ? model.meters_per_unit : 1.0;
        exportModel(model, -1, s, [&](const nwd::Instance &inst, size_t) { return nwd::world_matrix(model, inst); });
      }
    }
    nodes << "]";
    props << "}";
    meshes << "]";
    w.bin.close();
    std::ofstream js(std::filesystem::path(prefix).concat(".json"), std::ios::binary);
    js << "{\"version\":1,\"models\":" << modelCount << ",\"triangles\":" << triangles << ",\"skipped\":" << skipped
       << ",\"nodes\":" << nodes.str() << ",\"props\":" << props.str() << ",\"meshes\":" << meshes.str() << "}";
    std::cout << "ok " << modelCount << " modelli, " << nodeBase << " nodi, " << triangles << " triangoli, "
              << skipped << " elementi saltati\n";
    return 0;
  } catch (const std::exception &e) {
    std::cerr << "errore: " << e.what() << '\n';
    return 1;
  }
}
