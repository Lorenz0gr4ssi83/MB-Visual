// stepsplit: divide un file STEP (ISO 10303-21) in N file parziali da leggere in parallelo con OpenCascade.
// Ogni file parziale contiene TUTTA la struttura (prodotti, assiemi, posizionamenti, rappresentazioni, stili) ma solo la
// geometria di circa 1/N dei solidi. Le entita' condivise si ripetono dove servono.
//   stepsplit <file.step> <cartella di uscita> <N>
// Scrive <cartella>\parte<k>.step e stampa su stdout una riga JSON con i conteggi.
//
// Regole:
// - radici della geometria = solidi e gusci (MANIFOLD_SOLID_BREP, BREP_WITH_VOIDS, FACETED_BREP, SHELL_BASED_SURFACE_MODEL,
//   TESSELLATED_SHELL/SOLID...), distribuite sui file per peso (byte della loro chiusura);
// - un riferimento dalla struttura a un solido o a un elemento topologico escluso e' "debole": nella lista degli elementi di
//   una rappresentazione il solido si sostituisce con un punto nuovo (cosi' ogni parte ha comunque una forma e OpenCascade
//   crea la stessa struttura di etichette in tutti i file), nelle altre liste si toglie, come attributo diretto toglie
//   l'entita' (es. STYLED_ITEM di una faccia esclusa); a catena si tolgono i riferimenti alle entita' tolte;
// - una lista di presentazione rimasta vuota (MDGPR, livelli) toglie l'entita'.
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

using namespace std;

static vector<char> readAll(const char* path) {
  vector<char> buf;
#ifdef _WIN32
  int n = MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
  wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, path, -1, &w[0], n);
  FILE* f = _wfopen(w.c_str(), L"rb");
#else
  FILE* f = fopen(path, "rb");
#endif
  if (!f) return buf;
  _fseeki64(f, 0, SEEK_END);
  long long sz = _ftelli64(f);
  _fseeki64(f, 0, SEEK_SET);
  buf.resize((size_t)sz);
  size_t got = sz ? fread(buf.data(), 1, (size_t)sz, f) : 0;
  buf.resize(got);
  fclose(f);
  return buf;
}

static FILE* openW(const string& path) {
#ifdef _WIN32
  int n = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, &w[0], n);
  return _wfopen(w.c_str(), L"wb");
#else
  return fopen(path.c_str(), "wb");
#endif
}

struct Ent {
  uint64_t id;
  size_t start, end;  // [start, end) dal '#' al ';' compreso
  uint32_t type;      // indice nel dizionario dei tipi
  uint32_t refBeg, refEnd;
};

struct Ref {
  uint32_t target;  // indice dell'entita' (o UINT32_MAX se non definita)
  uint32_t pos;     // posizione del '#' rispetto a start dell'entita'
  uint8_t inList;   // 1 = elemento di una lista, 0 = attributo diretto
};

static vector<string> typeNames;
static unordered_map<string, uint32_t> typeIndex;
static uint32_t typeOf(const string& s) {
  auto it = typeIndex.find(s);
  if (it != typeIndex.end()) return it->second;
  uint32_t k = (uint32_t)typeNames.size();
  typeNames.push_back(s);
  typeIndex.emplace(s, k);
  return k;
}

static bool isRootType(const string& t) {
  return t == "MANIFOLD_SOLID_BREP" || t == "BREP_WITH_VOIDS" || t == "FACETED_BREP" ||
         t == "FACETED_BREP_AND_BREP_WITH_VOIDS" || t == "SHELL_BASED_SURFACE_MODEL" || t == "MANIFOLD_SURFACE_SHAPE_REPRESENTATION_ITEM" ||
         t == "TESSELLATED_SHELL" || t == "TESSELLATED_SOLID" || t == "TRIANGULATED_FACE" || t == "COMPLEX_TRIANGULATED_FACE" ||
         t == "TRIANGULATED_SURFACE_SET" || t == "COMPLEX_TRIANGULATED_SURFACE_SET";
}
static bool isTopoType(const string& t) {
  static const char* T[] = {"ADVANCED_FACE", "FACE_SURFACE", "FACE", "ORIENTED_FACE", "CLOSED_SHELL", "OPEN_SHELL", "ORIENTED_CLOSED_SHELL",
                            "ORIENTED_OPEN_SHELL", "EDGE_CURVE", "ORIENTED_EDGE", "EDGE_LOOP", "VERTEX_POINT", "VERTEX_LOOP", "POLY_LOOP",
                            "FACE_BOUND", "FACE_OUTER_BOUND", "SUBEDGE", "CONNECTED_FACE_SET", "CONNECTED_EDGE_SET"};
  for (auto s : T)
    if (t == s) return true;
  return false;
}
static bool endsWith(const string& s, const char* e) {
  size_t n = strlen(e);
  return s.size() >= n && memcmp(s.data() + s.size() - n, e, n) == 0;
}
// liste di presentazione/annotazione: se restano vuote l'entita' non serve piu'
static bool dropIfEmpty(const string& t) {
  return t == "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION" || t == "PRESENTATION_LAYER_ASSIGNMENT" ||
         t == "DRAUGHTING_MODEL" || t == "STYLED_ITEM" || t == "OVER_RIDING_STYLED_ITEM" ||
         t == "CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM" || t == "PRESENTATION_STYLE_ASSIGNMENT" || t == "GEOMETRIC_SET" ||
         t == "GEOMETRIC_CURVE_SET" || t == "MECHANICAL_DESIGN_PRESENTATION_REPRESENTATION_WITH_DRAUGHTING" ||
         t == "INVISIBILITY" || t == "PRESENTATION_SET" || t == "GROUP_ASSIGNMENT" || t == "APPLIED_GROUP_ASSIGNMENT";
}

#ifdef _WIN32
static string toUtf8(const wchar_t* w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  string s(n > 0 ? n - 1 : 0, 0);
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}
static int run(int argc, char** argv);
// argomenti in Unicode (percorsi con lettere accentate), poi tutto in UTF-8
int wmain(int argc, wchar_t** wargv) {
  vector<string> a;
  for (int k = 0; k < argc; k++) a.push_back(toUtf8(wargv[k]));
  vector<char*> p;
  for (auto& x : a) p.push_back(&x[0]);
  return run(argc, p.data());
}
static int run(int argc, char** argv) {
#else
int main(int argc, char** argv) {
#endif
  if (argc < 4) {
    fprintf(stderr, "uso: stepsplit <file.step> <cartella> <N>\n");
    return 2;
  }
  auto t0 = chrono::steady_clock::now();
  vector<char> data = readAll(argv[1]);
  if (data.empty()) {
    printf("{\"ok\":false,\"errore\":\"lettura\"}\n");
    return 1;
  }
  string outDir = argv[2];
  int N = atoi(argv[3]);
  if (N < 1) N = 1;
  if (N > 64) N = 64;
  const char* d = data.data();
  size_t len = data.size();

  // ---- sezione DATA
  auto findTok = [&](const char* tok, size_t from) -> size_t {
    size_t n = strlen(tok);
    bool inStr = false;
    for (size_t i = from; i + n <= len; i++) {
      char c = d[i];
      if (inStr) {
        if (c == '\'') inStr = false;
        continue;
      }
      if (c == '\'') {
        inStr = true;
        continue;
      }
      if (c == '/' && i + 1 < len && d[i + 1] == '*') {
        const char* e = strstr(d + i + 2, "*/");
        i = e ? (size_t)(e - d) + 1 : len;
        continue;
      }
      if (c == tok[0] && memcmp(d + i, tok, n) == 0) return i;
    }
    return SIZE_MAX;
  };
  size_t dataPos = findTok("DATA", 0);
  while (dataPos != SIZE_MAX) {  // "DATA" seguito da ';' o '(' (sezioni con nome)
    size_t k = dataPos + 4;
    while (k < len && isspace((unsigned char)d[k])) k++;
    if (k < len && (d[k] == ';' || d[k] == '(') && (dataPos == 0 || !isalnum((unsigned char)d[dataPos - 1]) && d[dataPos - 1] != '_')) break;
    dataPos = findTok("DATA", dataPos + 4);
  }
  if (dataPos == SIZE_MAX) {
    printf("{\"ok\":false,\"errore\":\"sezione DATA\"}\n");
    return 1;
  }
  size_t headerEnd = dataPos;
  while (headerEnd < len && d[headerEnd] != ';') headerEnd++;
  headerEnd++;

  // ---- entita'
  vector<Ent> ents;
  vector<Ref> refs;
  ents.reserve(len / 70);
  refs.reserve(len / 25);
  vector<uint64_t> refIds;  // id grezzi, risolti dopo
  refIds.reserve(len / 25);
  uint64_t maxId = 0;
  size_t i = headerEnd;
  while (i < len) {
    char c = d[i];
    if (isspace((unsigned char)c)) {
      i++;
      continue;
    }
    if (c == '/' && i + 1 < len && d[i + 1] == '*') {
      const char* e = strstr(d + i + 2, "*/");
      i = e ? (size_t)(e - d) + 2 : len;
      continue;
    }
    if (c != '#') break;  // ENDSEC o fine
    Ent e;
    e.start = i;
    i++;
    uint64_t id = 0;
    while (i < len && isdigit((unsigned char)d[i])) id = id * 10 + (d[i++] - '0');
    e.id = id;
    if (id > maxId) maxId = id;
    while (i < len && isspace((unsigned char)d[i])) i++;
    if (i >= len || d[i] != '=') {
      printf("{\"ok\":false,\"errore\":\"sintassi a %zu\"}\n", i);
      return 1;
    }
    i++;
    while (i < len && isspace((unsigned char)d[i])) i++;
    bool complex = i < len && d[i] == '(';
    string tname;
    if (complex) {
      size_t k = i + 1;
      while (k < len && isspace((unsigned char)d[k])) k++;
      size_t s = k;
      while (k < len && (isalnum((unsigned char)d[k]) || d[k] == '_')) k++;
      tname = "(" + string(d + s, k - s);
    } else {
      size_t s = i;
      while (i < len && (isalnum((unsigned char)d[i]) || d[i] == '_')) i++;
      tname.assign(d + s, i - s);
    }
    e.type = typeOf(tname);
    e.refBeg = (uint32_t)refs.size();
    int depth = 0, attrDepth = complex ? 2 : 1;
    bool ended = false;
    while (i < len) {
      char ch = d[i];
      if (ch == '\'') {
        i++;
        while (i < len) {
          if (d[i] == '\'') {
            if (i + 1 < len && d[i + 1] == '\'') {
              i += 2;
              continue;
            }
            break;
          }
          i++;
        }
        i++;
        continue;
      }
      if (ch == '"') {  // binario
        i++;
        while (i < len && d[i] != '"') i++;
        i++;
        continue;
      }
      if (ch == '(') depth++;
      else if (ch == ')') depth--;
      else if (ch == ';' && depth <= 0) {
        i++;
        ended = true;
        break;
      } else if (ch == '#') {
        size_t p = i;
        i++;
        uint64_t rid = 0;
        while (i < len && isdigit((unsigned char)d[i])) rid = rid * 10 + (d[i++] - '0');
        Ref r;
        r.target = UINT32_MAX;
        r.pos = (uint32_t)(p - e.start);
        r.inList = depth > attrDepth ? 1 : 0;
        refs.push_back(r);
        refIds.push_back(rid);
        continue;
      }
      i++;
    }
    if (!ended) {
      printf("{\"ok\":false,\"errore\":\"entita' #%llu non chiusa\"}\n", (unsigned long long)id);
      return 1;
    }
    e.end = i;
    e.refEnd = (uint32_t)refs.size();
    ents.push_back(e);
  }
  size_t tailPos = i;  // ENDSEC; ed eventuali altre sezioni
  const size_t n = ents.size();

  // id -> indice
  vector<uint32_t> idx;
  unordered_map<uint64_t, uint32_t> idxMap;
  bool dense = maxId < 400000000ull;
  if (dense) idx.assign((size_t)maxId + 1, UINT32_MAX);
  for (uint32_t k = 0; k < n; k++) {
    if (dense) idx[(size_t)ents[k].id] = k;
    else idxMap[ents[k].id] = k;
  }
  for (size_t k = 0; k < refs.size(); k++) {
    uint64_t rid = refIds[k];
    if (dense) refs[k].target = rid <= maxId ? idx[(size_t)rid] : UINT32_MAX;
    else {
      auto it = idxMap.find(rid);
      refs[k].target = it == idxMap.end() ? UINT32_MAX : it->second;
    }
  }
  vector<uint64_t>().swap(refIds);
  vector<uint32_t>().swap(idx);

  vector<uint8_t> isRootT(typeNames.size()), isTopoT(typeNames.size()), isRepT(typeNames.size()), dropEmptyT(typeNames.size());
  for (size_t k = 0; k < typeNames.size(); k++) {
    const string& t = typeNames[k];
    isRootT[k] = isRootType(t);
    isTopoT[k] = isRootT[k] || isTopoType(t);
    isRepT[k] = (endsWith(t, "REPRESENTATION") && t.find("PRESENTATION_REPRESENTATION") == string::npos &&
                 t != "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION" && t != "DRAUGHTING_MODEL") ||
                (t[0] == '(' && t.find("REPRESENTATION") != string::npos && t.find("RELATIONSHIP") == string::npos);
    dropEmptyT[k] = dropIfEmpty(t);
  }

  // ---- radici e pesi
  vector<uint32_t> roots;
  for (uint32_t k = 0; k < n; k++)
    if (isRootT[ents[k].type]) roots.push_back(k);
  // le radici annidate (es. guscio dentro un solido gia' radice) non sono radici
  {
    vector<uint8_t> isRoot(n, 0);
    for (auto r : roots) isRoot[r] = 1;
    vector<uint8_t> sub(n, 0);
    for (auto r : roots)
      for (uint32_t q = ents[r].refBeg; q < ents[r].refEnd; q++) {
        uint32_t t = refs[q].target;
        if (t != UINT32_MAX && isRoot[t]) sub[t] = 1;
      }
    vector<uint32_t> keep;
    for (auto r : roots)
      if (!sub[r]) keep.push_back(r);
    roots.swap(keep);
  }
  int bins = (int)min<size_t>((size_t)N, max<size_t>(roots.size(), 1));

  vector<uint32_t> stamp(n, UINT32_MAX);
  vector<uint32_t> stack;
  vector<uint64_t> weight(roots.size(), 0);
  for (size_t r = 0; r < roots.size(); r++) {
    stack.clear();
    stack.push_back(roots[r]);
    stamp[roots[r]] = (uint32_t)r;
    uint64_t w = 0;
    while (!stack.empty()) {
      uint32_t e = stack.back();
      stack.pop_back();
      w += ents[e].end - ents[e].start;
      for (uint32_t q = ents[e].refBeg; q < ents[e].refEnd; q++) {
        uint32_t t = refs[q].target;
        if (t != UINT32_MAX && stamp[t] != (uint32_t)r) {
          stamp[t] = (uint32_t)r;
          stack.push_back(t);
        }
      }
    }
    weight[r] = w;
  }
  // solidi troppo grandi per un file solo (oltre meta' del carico ideale): si dividono per facce. Il solido e il suo guscio
  // stanno in tutti i file che ne hanno almeno una faccia; la lista delle facce del guscio si riduce a quelle del file.
  uint64_t total = 0;
  for (auto w : weight) total += w;
  vector<vector<uint32_t>> units;  // unita' da distribuire: radici intere o gruppi di facce consecutive
  vector<uint64_t> unitW;
  vector<int64_t> unitOwner;     // per le facce: indice della radice divisa, altrimenti -1
  vector<uint32_t> splitShell(roots.size(), UINT32_MAX);
  uint32_t nextStamp = (uint32_t)roots.size();
  for (size_t r = 0; r < roots.size(); r++) {
    uint32_t R = roots[r];
    uint32_t shell = UINT32_MAX;
    if (bins > 1 && weight[r] * 2 > total / bins) {
      const string& tn = typeNames[ents[R].type];
      vector<uint32_t> sh;
      for (uint32_t q = ents[R].refBeg; q < ents[R].refEnd; q++) {
        uint32_t t = refs[q].target;
        if (t == UINT32_MAX) continue;
        const string& st = typeNames[ents[t].type];
        if (st == "CLOSED_SHELL" || st == "OPEN_SHELL") sh.push_back(t);
      }
      if ((tn == "MANIFOLD_SOLID_BREP" || tn == "SHELL_BASED_SURFACE_MODEL") && sh.size() == 1) shell = sh[0];
    }
    if (shell == UINT32_MAX) {
      units.push_back({R});
      unitW.push_back(weight[r]);
      unitOwner.push_back(-1);
      continue;
    }
    splitShell[r] = shell;
    // facce consecutive (di solito vicine tra loro) nello stesso gruppo: spigoli e curve condivisi non si ripetono
    uint64_t target = max<uint64_t>(total / bins / 4, 1);
    vector<uint32_t> cur;
    uint64_t w = 0;
    uint32_t st = nextStamp++;
    auto flush = [&]() {
      if (cur.empty()) return;
      units.push_back(cur);
      unitW.push_back(w);
      unitOwner.push_back((int64_t)r);
      cur.clear();
      w = 0;
      st = nextStamp++;
    };
    for (uint32_t q = ents[shell].refBeg; q < ents[shell].refEnd; q++) {
      uint32_t F = refs[q].target;
      if (F == UINT32_MAX || !refs[q].inList) continue;
      cur.push_back(F);
      if (stamp[F] != st) {
        stack.clear();
        stack.push_back(F);
        stamp[F] = st;
        while (!stack.empty()) {
          uint32_t e = stack.back();
          stack.pop_back();
          w += ents[e].end - ents[e].start;
          for (uint32_t q2 = ents[e].refBeg; q2 < ents[e].refEnd; q2++) {
            uint32_t t = refs[q2].target;
            if (t != UINT32_MAX && stamp[t] != st) {
              stamp[t] = st;
              stack.push_back(t);
            }
          }
        }
      }
      if (w >= target) flush();
    }
    flush();
  }
  // distribuzione: i piu' pesanti prima, ognuno nel file meno carico
  vector<size_t> order(units.size());
  for (size_t k = 0; k < order.size(); k++) order[k] = k;
  sort(order.begin(), order.end(), [&](size_t a, size_t b) { return unitW[a] > unitW[b]; });
  vector<uint64_t> load(bins, 0);
  vector<int> binOf(units.size(), 0);
  for (size_t k : order) {
    int b = (int)(min_element(load.begin(), load.end()) - load.begin());
    binOf[k] = b;
    load[b] += unitW[k];
  }
  // maschera dei file che contengono ogni entita' geometrica
  vector<uint64_t> mask(n, 0);
  vector<uint32_t> shells;  // gusci divisi: la lista delle facce si riduce in ogni file
  for (size_t r = 0; r < roots.size(); r++)
    if (splitShell[r] != UINT32_MAX) shells.push_back(splitShell[r]);
  for (size_t r = 0; r < units.size(); r++) {
    uint64_t bit = 1ull << binOf[r];
    if (unitOwner[r] >= 0) {
      mask[roots[(size_t)unitOwner[r]]] |= bit;
      mask[splitShell[(size_t)unitOwner[r]]] |= bit;
    }
    stack.clear();
    for (uint32_t u : units[r]) {
      stack.push_back(u);
      mask[u] |= bit;
    }
    while (!stack.empty()) {
      uint32_t e = stack.back();
      stack.pop_back();
      for (uint32_t q = ents[e].refBeg; q < ents[e].refEnd; q++) {
        uint32_t t = refs[q].target;
        if (t != UINT32_MAX && !(mask[t] & bit)) {
          mask[t] |= bit;
          stack.push_back(t);
        }
      }
    }
  }
  // struttura: entita' fuori dalla geometria + tutto cio' che raggiungono con riferimenti "forti"
  // (debole = verso un solido o un elemento topologico della geometria)
  vector<uint8_t> structKeep(n, 0);
  stack.clear();
  for (uint32_t k = 0; k < n; k++)
    if (!mask[k]) {
      structKeep[k] = 1;
      stack.push_back(k);
    }
  while (!stack.empty()) {
    uint32_t e = stack.back();
    stack.pop_back();
    for (uint32_t q = ents[e].refBeg; q < ents[e].refEnd; q++) {
      uint32_t t = refs[q].target;
      if (t == UINT32_MAX || structKeep[t]) continue;
      if (mask[t] && isTopoT[ents[t].type]) continue;  // debole
      structKeep[t] = 1;
      stack.push_back(t);
    }
  }
  // entita' di struttura con riferimenti deboli verso la geometria (le uniche da modificare) e riferimenti inversi
  vector<uint32_t> cand;
  for (uint32_t k = 0; k < n; k++) {
    if (!structKeep[k]) continue;
    for (uint32_t q = ents[k].refBeg; q < ents[k].refEnd; q++) {
      uint32_t t = refs[q].target;
      if (t != UINT32_MAX && !structKeep[t]) {
        cand.push_back(k);
        break;
      }
    }
  }
  unordered_map<uint32_t, vector<uint32_t>> rev;  // solo per la struttura: chi riferisce chi
  for (uint32_t k = 0; k < n; k++) {
    if (!structKeep[k] || mask[k]) continue;  // le entita' condivise con la geometria non riferiscono la struttura
    for (uint32_t q = ents[k].refBeg; q < ents[k].refEnd; q++) {
      uint32_t t = refs[q].target;
      if (t != UINT32_MAX && structKeep[t] && !mask[t]) rev[t].push_back(k);
    }
  }

  // solidi divisi: nelle parti diventano superfici (SHELL_BASED_SURFACE_MODEL con OPEN_SHELL), perche' un solido con solo
  // una parte delle facce farebbe lavorare a vuoto le riparazioni di OpenCascade (gusci aperti da "chiudere")
  vector<uint8_t> retype(n, 0);
  if (!getenv("STEPSPLIT_SOLIDI"))
    for (size_t r = 0; r < roots.size(); r++)
      if (splitShell[r] != UINT32_MAX) {
        if (typeNames[ents[roots[r]].type] == "MANIFOLD_SOLID_BREP") retype[roots[r]] = 1;
        if (typeNames[ents[splitShell[r]].type] == "CLOSED_SHELL") retype[splitShell[r]] = 2;
      }
  auto applyRetype = [&](string& s, uint8_t kind) {
    if (kind == 2) {
      size_t q = s.find("CLOSED_SHELL");
      if (q != string::npos) s.replace(q, 12, "OPEN_SHELL");
    } else if (kind == 1) {
      size_t q = s.find("MANIFOLD_SOLID_BREP");
      size_t h = s.rfind('#');
      if (q == string::npos || h == string::npos || h < q) return;
      size_t e2 = h + 1;
      while (e2 < s.size() && isdigit((unsigned char)s[e2])) e2++;
      s.insert(e2, ")");
      s.insert(h, "(");
      s.replace(q, 19, "SHELL_BASED_SURFACE_MODEL");
    }
  };
  auto t1 = chrono::steady_clock::now();
  uint64_t nextId = maxId + 1;
  string json = "{\"ok\":true,\"entita\":" + to_string(n) + ",\"solidi\":" + to_string(roots.size()) + ",\"divisi\":" + to_string(shells.size()) + ",\"parti\":[";
  uint64_t totalOut = 0;

  // ---- un file per parte
  for (int b = 0; b < bins; b++) {
    uint64_t bit = 1ull << b;
    auto kept = [&](uint32_t e) { return structKeep[e] || (mask[e] & bit); };
    // tolte a catena
    unordered_map<uint32_t, uint8_t> dropped;
    vector<uint32_t> work;
    // modifiche per entita': posizioni dei riferimenti da togliere (0) o sostituire con un punto (1)
    unordered_map<uint32_t, vector<pair<uint32_t, uint8_t>>> edits;
    auto evalEnt = [&](uint32_t e) {
      // ricalcola le modifiche dell'entita' e', restituisce true se va tolta
      const string& tn = typeNames[ents[e].type];
      vector<pair<uint32_t, uint8_t>> ed;
      bool drop = false;
      bool anyListRemoved = false, anyListLeft = false;
      for (uint32_t q = ents[e].refBeg; q < ents[e].refEnd; q++) {
        const Ref& r = refs[q];
        uint32_t t = r.target;
        bool ok = t == UINT32_MAX || (kept(t) && !dropped.count(t));
        if (r.inList) {
          if (ok) {
            anyListLeft = true;
            continue;
          }
          if (isRepT[ents[e].type] && isRootT[ents[t].type] && !dropped.count(t)) {
            ed.push_back({r.pos, 1});
            anyListLeft = true;
          } else {
            ed.push_back({r.pos, 0});
            anyListRemoved = true;
          }
        } else if (!ok) {
          drop = true;
        }
      }
      if (anyListRemoved && !anyListLeft && dropEmptyT[ents[e].type]) drop = true;
      (void)tn;
      if (drop) return true;
      if (ed.empty()) edits.erase(e);
      else edits[e] = move(ed);
      return false;
    };
    for (uint32_t sh : shells)
      if (mask[sh] & bit) evalEnt(sh);
    for (uint32_t e : cand) work.push_back(e);
    while (!work.empty()) {
      uint32_t e = work.back();
      work.pop_back();
      if (dropped.count(e)) continue;
      if (evalEnt(e)) {
        dropped[e] = 1;
        edits.erase(e);
        auto it = rev.find(e);
        if (it != rev.end())
          for (uint32_t p : it->second) work.push_back(p);
      }
    }

    string path = outDir + "/parte" + to_string(b) + ".step";
    FILE* f = openW(path);
    if (!f) {
      printf("{\"ok\":false,\"errore\":\"scrittura %s\"}\n", path.c_str());
      return 1;
    }
    setvbuf(f, nullptr, _IOFBF, 1 << 22);
    fwrite(d, 1, headerEnd, f);
    fputc('\n', f);
    uint64_t written = 0, count = 0, placeholders = 0;
    string extra;  // punti sostitutivi, scritti in fondo
    string buf;
    for (uint32_t e = 0; e < n; e++) {
      if (!kept(e) || dropped.count(e)) continue;
      const Ent& E = ents[e];
      count++;
      auto it = edits.find(e);
      if (it == edits.end() && retype[e]) {
        buf.assign(d + E.start, E.end - E.start);
        applyRetype(buf, retype[e]);
        fwrite(buf.data(), 1, buf.size(), f);
        fputc('\n', f);
        written += buf.size() + 1;
        continue;
      }
      if (it == edits.end()) {
        fwrite(d + E.start, 1, E.end - E.start, f);
        fputc('\n', f);
        written += E.end - E.start + 1;
        continue;
      }
      // riscrittura: si tolgono i riferimenti (con la virgola) o si sostituiscono con un punto nuovo
      auto& ed = it->second;
      sort(ed.begin(), ed.end());
      buf.clear();
      size_t p = E.start;
      size_t k = 0;
      while (p < E.end) {
        if (k < ed.size() && p == E.start + ed[k].first) {
          size_t q = p + 1;
          while (q < E.end && isdigit((unsigned char)d[q])) q++;
          if (ed[k].second == 1) {
            uint64_t pid = nextId++;
            placeholders++;
            buf += "#" + to_string(pid);
            extra += "#" + to_string(pid) + " = CARTESIAN_POINT('',(0.,0.,0.));\n";
            p = q;
          } else {
            // togli il riferimento e la virgola che segue, o quella che precede se e' l'ultimo della lista
            size_t r = q;
            while (r < E.end && isspace((unsigned char)d[r])) r++;
            if (r < E.end && d[r] == ',') {
              p = r + 1;
            } else {
              p = q;
              while (!buf.empty() && isspace((unsigned char)buf.back())) buf.pop_back();
              if (!buf.empty() && buf.back() == ',') buf.pop_back();
            }
          }
          k++;
          continue;
        }
        char ch = d[p];
        if (ch == '\'') {  // stringa copiata tale e quale
          size_t s = p++;
          while (p < E.end) {
            if (d[p] == '\'') {
              if (p + 1 < E.end && d[p + 1] == '\'') {
                p += 2;
                continue;
              }
              break;
            }
            p++;
          }
          p++;
          buf.append(d + s, p - s);
          continue;
        }
        buf.push_back(ch);
        p++;
      }
      if (retype[e]) applyRetype(buf, retype[e]);
      fwrite(buf.data(), 1, buf.size(), f);
      fputc('\n', f);
      written += buf.size() + 1;
    }
    fwrite(extra.data(), 1, extra.size(), f);
    written += extra.size();
    fwrite(d + tailPos, 1, len - tailPos, f);
    fclose(f);
    totalOut += written;
    int nsol = 0;
    for (size_t r = 0; r < roots.size(); r++)
      if (mask[roots[r]] & bit) nsol++;
    if (b) json += ",";
    json += "{\"file\":\"parte" + to_string(b) + ".step\",\"solidi\":" + to_string(nsol) + ",\"entita\":" + to_string(count) +
            ",\"byte\":" + to_string(written) + ",\"punti\":" + to_string(placeholders) + ",\"tolte\":" + to_string(dropped.size()) + "}";
  }
  auto t2 = chrono::steady_clock::now();
  json += "],\"analisi_s\":" + to_string(chrono::duration<double>(t1 - t0).count()) +
          ",\"scrittura_s\":" + to_string(chrono::duration<double>(t2 - t1).count()) + "}";
  printf("%s\n", json.c_str());
  return 0;
}
