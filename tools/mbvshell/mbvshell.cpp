// mbvshell.dll - miniature (IThumbnailProvider) e riquadro di anteprima (IPreviewHandler) di MB Desk per Esplora risorse.
//
// 1. Immagini gia' contenute nel file (veloce, nessun processo): anteprima dei DWG, miniatura dei file OLE (Revit, Inventor,
//    SolidWorks fino al 2014, ...: proprieta' Thumbnail o flussi "Preview"), PNG incorporato negli SketchUp.
// 2. Altrimenti l'immagine la disegna MB Desk stesso: "<Comando> --miniatura <file> <uscita.png> <lato>"
//    (mbvisual/miniature.py), con una cache in %LOCALAPPDATA%\MBVisual\miniature\cache.
// Il comando e le opzioni li scrive mbvisual/shellint.py in HKCU\Software\MB Desk\Integrazione.
// Si compila con tools/mbvshell/build.cmd (MSVC, ARM64 e x64). Nessuna libreria esterna.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <thumbcache.h>
#include <propidl.h>
#include <wincodec.h>
#include <new>
#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <mutex>

#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "msimg32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "comctl32.lib")

// {6F1D8E2A-5C4F-4E3B-9A1D-2F6C8B0E4A11} miniature, {...12} anteprima (gli stessi in mbvisual/shellint.py)
static const CLSID CLSID_Thumb = {0x6f1d8e2a, 0x5c4f, 0x4e3b, {0x9a, 0x1d, 0x2f, 0x6c, 0x8b, 0x0e, 0x4a, 0x11}};
static const CLSID CLSID_Preview = {0x6f1d8e2a, 0x5c4f, 0x4e3b, {0x9a, 0x1d, 0x2f, 0x6c, 0x8b, 0x0e, 0x4a, 0x12}};

static HINSTANCE g_inst;
static std::atomic<long> g_refs{0};
static const wchar_t* REGKEY = L"Software\\MB Visual\\Integrazione";  // chiave tecnica: nome storico

typedef std::vector<BYTE> Bytes;

// ------------------------------------------------------------------ utilita'
static std::wstring RegStr(const wchar_t* name) {
    wchar_t buf[2048];
    // prove senza registro (tools/mbvshell/prova.cpp): MBVSHELL_<nome> nell'ambiente prevale
    std::wstring env = L"MBVSHELL_"; env += name;
    if (GetEnvironmentVariableW(env.c_str(), buf, 2048) > 0) return buf;
    DWORD cb = sizeof(buf);
    if (RegGetValueW(HKEY_CURRENT_USER, REGKEY, name, RRF_RT_REG_SZ, nullptr, buf, &cb) == ERROR_SUCCESS) return buf;
    return L"";
}

static DWORD RegDword(const wchar_t* name, DWORD def) {
    DWORD v = 0, cb = sizeof(v);
    if (RegGetValueW(HKEY_CURRENT_USER, REGKEY, name, RRF_RT_REG_DWORD, nullptr, &v, &cb) == ERROR_SUCCESS) return v;
    return def;
}

static std::wstring LocalDir(const wchar_t* sub) {
    wchar_t* la = nullptr;
    std::wstring d;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &la))) d = la;
    CoTaskMemFree(la);
    d += L"\\MBVisual\\";
    d += sub;
    SHCreateDirectoryExW(nullptr, d.c_str(), nullptr);
    return d;
}

static bool FileExists(const std::wstring& p) {
    DWORD a = GetFileAttributesW(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static unsigned long long Fnv(const void* p, size_t n, unsigned long long h = 1469598103934665603ULL) {
    const BYTE* b = (const BYTE*)p;
    for (size_t i = 0; i < n; i++) { h ^= b[i]; h *= 1099511628211ULL; }
    return h;
}

static std::wstring ExtOf(const std::wstring& name) {
    const wchar_t* e = PathFindExtensionW(name.c_str());
    std::wstring x = (e && *e) ? e + 1 : L"";
    for (auto& c : x) c = (wchar_t)towlower(c);
    return x;
}

// ------------------------------------------------------------------ sorgente: flusso (miniature) o percorso (anteprima)
struct Source {
    IStream* stream = nullptr;   // non posseduto
    std::wstring path;           // percorso completo, se noto
    std::wstring name;           // nome del file (per l'estensione)
    ULONGLONG size = 0;
    FILETIME mtime{};

    bool ReadAt(ULONGLONG off, void* buf, ULONG n) const {
        if (!stream) return false;
        LARGE_INTEGER li; li.QuadPart = (LONGLONG)off;
        if (FAILED(stream->Seek(li, STREAM_SEEK_SET, nullptr))) return false;
        ULONG got = 0;
        return SUCCEEDED(stream->Read(buf, n, &got)) && got == n;
    }
    Bytes Head(ULONG n) const {
        Bytes b((size_t)std::min<ULONGLONG>(n, size));
        if (!b.empty() && !ReadAt(0, b.data(), (ULONG)b.size())) b.clear();
        return b;
    }
};

// ------------------------------------------------------------------ decodifica immagini (WIC) -> HBITMAP 32 bit
static HBITMAP Decode(const BYTE* data, size_t n, UINT maxSide, bool premul, UINT* outW = nullptr, UINT* outH = nullptr) {
    IWICImagingFactory* f = nullptr;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&f)))) return nullptr;
    HBITMAP hbm = nullptr;
    IWICStream* st = nullptr; IWICBitmapDecoder* dec = nullptr; IWICBitmapFrameDecode* fr = nullptr;
    IWICBitmapScaler* sc = nullptr; IWICFormatConverter* cv = nullptr;
    do {
        if (FAILED(f->CreateStream(&st)) || FAILED(st->InitializeFromMemory((BYTE*)data, (DWORD)n))) break;
        if (FAILED(f->CreateDecoderFromStream(st, nullptr, WICDecodeMetadataCacheOnDemand, &dec))) break;
        if (FAILED(dec->GetFrame(0, &fr))) break;
        UINT w = 0, h = 0;
        fr->GetSize(&w, &h);
        if (!w || !h) break;
        IWICBitmapSource* src = fr;
        if (maxSide && (w > maxSide || h > maxSide)) {
            double k = (double)maxSide / std::max(w, h);
            UINT nw = std::max(1u, (UINT)(w * k + 0.5)), nh = std::max(1u, (UINT)(h * k + 0.5));
            if (SUCCEEDED(f->CreateBitmapScaler(&sc)) && SUCCEEDED(sc->Initialize(fr, nw, nh, WICBitmapInterpolationModeFant))) { src = sc; w = nw; h = nh; }
        }
        if (FAILED(f->CreateFormatConverter(&cv))) break;
        if (FAILED(cv->Initialize(src, premul ? GUID_WICPixelFormat32bppPBGRA : GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) break;
        BITMAPINFO bi{};
        bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bi.bmiHeader.biWidth = (LONG)w;
        bi.bmiHeader.biHeight = -(LONG)h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        void* bits = nullptr;
        hbm = CreateDIBSection(nullptr, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
        if (!hbm) break;
        if (FAILED(cv->CopyPixels(nullptr, w * 4, w * h * 4, (BYTE*)bits))) { DeleteObject(hbm); hbm = nullptr; break; }
        if (outW) *outW = w;
        if (outH) *outH = h;
    } while (false);
    if (cv) cv->Release(); if (sc) sc->Release(); if (fr) fr->Release(); if (dec) dec->Release(); if (st) st->Release();
    f->Release();
    return hbm;
}

// DIB senza intestazione di file (anteprime dei DWG, appunti CF_DIB) -> BMP completo
static Bytes DibToBmp(const BYTE* dib, size_t n) {
    if (n < sizeof(BITMAPINFOHEADER)) return {};
    const BITMAPINFOHEADER* h = (const BITMAPINFOHEADER*)dib;
    DWORD colors = h->biClrUsed;
    if (!colors && h->biBitCount <= 8) colors = 1u << h->biBitCount;
    DWORD off = sizeof(BITMAPFILEHEADER) + h->biSize + colors * 4 + (h->biCompression == BI_BITFIELDS ? 12 : 0);
    Bytes out(sizeof(BITMAPFILEHEADER) + n);
    BITMAPFILEHEADER fh{};
    fh.bfType = 0x4D42;
    fh.bfSize = (DWORD)out.size();
    fh.bfOffBits = off;
    memcpy(out.data(), &fh, sizeof(fh));
    memcpy(out.data() + sizeof(fh), dib, n);
    return out;
}

static const BYTE PNG_SIG[8] = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};

// PNG completo (fino a IEND) piu' grande dentro un blocco di byte
static Bytes FindPng(const BYTE* d, size_t n) {
    Bytes best;
    for (size_t i = 0; i + 8 < n; i++) {
        if (d[i] != 0x89 || memcmp(d + i, PNG_SIG, 8)) continue;
        size_t p = i + 8;
        bool ok = false;
        while (p + 12 <= n) {
            DWORD len = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
            if (len > n - p - 12) break;
            bool end = !memcmp(d + p + 4, "IEND", 4);
            p += 12 + len;
            if (end) { ok = true; break; }
        }
        if (ok && p - i > best.size()) best.assign(d + i, d + p);
        if (ok) i = p - 1;
    }
    return best;
}

// immagine in un blocco qualsiasi: PNG, JPEG, BMP o DIB
static Bytes SniffImage(const BYTE* d, size_t n) {
    if (n > 8 && !memcmp(d, PNG_SIG, 8)) return Bytes(d, d + n);
    if (n > 3 && d[0] == 0xFF && d[1] == 0xD8 && d[2] == 0xFF) return Bytes(d, d + n);
    if (n > 2 && d[0] == 'B' && d[1] == 'M') return Bytes(d, d + n);
    if (n > 40 && *(const DWORD*)d == 40) return DibToBmp(d, n);
    Bytes p = FindPng(d, n);
    return p;
}

// ------------------------------------------------------------------ immagini incorporate
// DWG (R13 e successivi): all'offset 0x0D c'e' l'indirizzo dell'anteprima (codice 2 = BMP, 3 = WMF, 6 = PNG)
static Bytes DwgPreview(const Source& s) {
    Bytes h = s.Head(0x20);
    if (h.size() < 0x14 || memcmp(h.data(), "AC10", 4)) return {};
    DWORD addr = *(DWORD*)(h.data() + 0x0D);
    BYTE hdr[16 + 4 + 1];
    if (!addr || addr >= s.size || !s.ReadAt(addr, hdr, sizeof(hdr))) return {};
    BYTE cnt = hdr[20];
    if (!cnt || cnt > 8) return {};
    Bytes ent(cnt * 9u);
    if (!s.ReadAt(addr + 21, ent.data(), (ULONG)ent.size())) return {};
    Bytes best; int bestCode = 0;
    for (int i = 0; i < cnt; i++) {
        BYTE code = ent[i * 9];
        DWORD start = *(DWORD*)&ent[i * 9 + 1], size = *(DWORD*)&ent[i * 9 + 5];
        if ((code != 2 && code != 6) || !size || size > 32u << 20 || start + (ULONGLONG)size > s.size) continue;
        if (code == 2 && bestCode == 6) continue;
        Bytes b(size);
        if (!s.ReadAt(start, b.data(), size)) continue;
        best = code == 2 ? DibToBmp(b.data(), b.size()) : b;
        bestCode = code;
    }
    return best;
}

// ILockBytes sopra un IStream: per leggere i file OLE (Compound File) passati come flusso
class StreamLockBytes : public ILockBytes {
    long ref = 1; IStream* st;
public:
    explicit StreamLockBytes(IStream* s) : st(s) { st->AddRef(); }
    ~StreamLockBytes() { st->Release(); }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (riid == IID_IUnknown || riid == IID_ILockBytes) { *ppv = this; AddRef(); return S_OK; }
        *ppv = nullptr; return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref); }
    STDMETHODIMP_(ULONG) Release() override { long r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
    STDMETHODIMP ReadAt(ULARGE_INTEGER off, void* pv, ULONG cb, ULONG* read) override {
        LARGE_INTEGER li; li.QuadPart = (LONGLONG)off.QuadPart;
        HRESULT hr = st->Seek(li, STREAM_SEEK_SET, nullptr);
        if (FAILED(hr)) return hr;
        ULONG got = 0;
        hr = st->Read(pv, cb, &got);
        if (read) *read = got;
        return FAILED(hr) ? hr : S_OK;
    }
    STDMETHODIMP WriteAt(ULARGE_INTEGER, const void*, ULONG, ULONG*) override { return STG_E_ACCESSDENIED; }
    STDMETHODIMP Flush() override { return S_OK; }
    STDMETHODIMP SetSize(ULARGE_INTEGER) override { return STG_E_ACCESSDENIED; }
    STDMETHODIMP LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
    STDMETHODIMP UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
    STDMETHODIMP Stat(STATSTG* ps, DWORD flag) override { return st->Stat(ps, flag | STATFLAG_NONAME); }
};

static Bytes ReadStream(IStream* s, ULONG limit = 64u << 20) {
    STATSTG ss{};
    if (FAILED(s->Stat(&ss, STATFLAG_NONAME)) || !ss.cbSize.QuadPart || ss.cbSize.QuadPart > limit) return {};
    Bytes b((size_t)ss.cbSize.QuadPart);
    ULONG got = 0;
    if (FAILED(s->Read(b.data(), (ULONG)b.size(), &got))) return {};
    b.resize(got);
    return b;
}

static bool NameLike(const wchar_t* n) {
    std::wstring s = n;
    for (auto& c : s) c = (wchar_t)towlower(c);
    return s.find(L"preview") != std::wstring::npos || s.find(L"thumb") != std::wstring::npos;
}

static void ScanStorage(IStorage* stg, Bytes& best, int depth) {
    IEnumSTATSTG* en = nullptr;
    if (depth > 3 || FAILED(stg->EnumElements(0, nullptr, 0, &en))) return;
    STATSTG ss;
    while (en->Next(1, &ss, nullptr) == S_OK) {
        if (ss.type == STGTY_STREAM && NameLike(ss.pwcsName)) {
            IStream* s = nullptr;
            if (SUCCEEDED(stg->OpenStream(ss.pwcsName, nullptr, STGM_READ | STGM_SHARE_EXCLUSIVE, 0, &s))) {
                Bytes b = ReadStream(s);
                Bytes img = b.empty() ? Bytes() : SniffImage(b.data(), b.size());
                if (img.size() > best.size()) best.swap(img);
                s->Release();
            }
        } else if (ss.type == STGTY_STORAGE) {
            IStorage* sub = nullptr;
            if (SUCCEEDED(stg->OpenStorage(ss.pwcsName, nullptr, STGM_READ | STGM_SHARE_EXCLUSIVE, nullptr, 0, &sub))) {
                ScanStorage(sub, best, depth + 1);
                sub->Release();
            }
        }
        CoTaskMemFree(ss.pwcsName);
    }
    en->Release();
}

// metafile degli appunti (CF_METAFILEPICT / CF_ENHMETAFILE) -> PNG via WIC non serve: si disegna su un DIB e si rende BMP
static Bytes MetafileToBmp(const BYTE* d, size_t n, bool enhanced) {
    HENHMETAFILE emf = enhanced ? SetEnhMetaFileBits((UINT)n, d) : SetWinMetaFileBits((UINT)n, d, nullptr, nullptr);
    if (!emf) return {};
    ENHMETAHEADER eh{};
    GetEnhMetaFileHeader(emf, sizeof(eh), &eh);
    int w = eh.rclBounds.right - eh.rclBounds.left, h = eh.rclBounds.bottom - eh.rclBounds.top;
    if (w <= 0 || h <= 0) { w = 256; h = 256; }
    double k = 512.0 / std::max(w, h);
    w = std::max(1, (int)(w * k)); h = std::max(1, (int)(h * k));
    BITMAPINFO bi{};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); bi.bmiHeader.biWidth = w; bi.bmiHeader.biHeight = h;
    bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 24;
    void* bits = nullptr;
    HDC dc = CreateCompatibleDC(nullptr);
    HBITMAP bm = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    Bytes out;
    if (bm) {
        HGDIOBJ old = SelectObject(dc, bm);
        RECT r{0, 0, w, h};
        FillRect(dc, &r, (HBRUSH)GetStockObject(WHITE_BRUSH));
        PlayEnhMetaFile(dc, emf, &r);
        SelectObject(dc, old);
        GdiFlush();
        DWORD stride = ((w * 3 + 3) & ~3u);
        Bytes dib(sizeof(BITMAPINFOHEADER) + stride * h);
        memcpy(dib.data(), &bi.bmiHeader, sizeof(BITMAPINFOHEADER));
        memcpy(dib.data() + sizeof(BITMAPINFOHEADER), bits, stride * h);
        out = DibToBmp(dib.data(), dib.size());
        DeleteObject(bm);
    }
    DeleteDC(dc);
    DeleteEnhMetaFile(emf);
    return out;
}

static Bytes OleThumbnail(IStorage* stg) {
    Bytes best;
    IPropertySetStorage* pss = nullptr;
    if (SUCCEEDED(stg->QueryInterface(IID_PPV_ARGS(&pss)))) {
        IPropertyStorage* ps = nullptr;
        if (SUCCEEDED(pss->Open(FMTID_SummaryInformation, STGM_READ | STGM_SHARE_EXCLUSIVE, &ps))) {
            PROPSPEC spec{PRSPEC_PROPID}; spec.propid = PIDSI_THUMBNAIL;
            PROPVARIANT pv; PropVariantInit(&pv);
            if (SUCCEEDED(ps->ReadMultiple(1, &spec, &pv)) && pv.vt == VT_CF && pv.pclipdata && pv.pclipdata->cbSize > 4) {
                const BYTE* d = pv.pclipdata->pClipData;
                size_t n = pv.pclipdata->cbSize - 4;
                long fmt = pv.pclipdata->ulClipFmt;
                if (fmt == -1 && n > 4) {
                    DWORD cf = *(const DWORD*)d; d += 4; n -= 4;
                    if (cf == CF_DIB) best = DibToBmp(d, n);
                    else if (cf == CF_METAFILEPICT && n > 8) best = MetafileToBmp(d + 8, n - 8, false);
                    else if (cf == CF_ENHMETAFILE) best = MetafileToBmp(d, n, true);
                    else best = SniffImage(d, n);
                } else {
                    best = SniffImage(d, n);
                }
            }
            PropVariantClear(&pv);
            ps->Release();
        }
        pss->Release();
    }
    Bytes s;
    ScanStorage(stg, s, 0);
    return s.size() > best.size() ? s : best;
}

static Bytes Embedded(const Source& s) {
    Bytes h = s.Head(16);
    if (h.size() < 8) return {};
    if (!memcmp(h.data(), "AC10", 4)) return DwgPreview(s);
    static const BYTE OLE[8] = {0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1};
    if (!memcmp(h.data(), OLE, 8)) {
        IStorage* stg = nullptr;
        if (s.stream) {
            StreamLockBytes* lb = new StreamLockBytes(s.stream);
            StgOpenStorageOnILockBytes(lb, nullptr, STGM_READ | STGM_SHARE_DENY_WRITE, nullptr, 0, &stg);
            lb->Release();
        }
        if (!stg) return {};
        Bytes b = OleThumbnail(stg);
        stg->Release();
        return b;
    }
    // SketchUp: la miniatura PNG e' all'inizio del file
    std::wstring ext = ExtOf(s.name);
    if (ext == L"skp" || ext == L"skb") {
        Bytes b = s.Head(8u << 20);
        return FindPng(b.data(), b.size());
    }
    return {};
}

// ------------------------------------------------------------------ immagine disegnata da MB Desk
static std::wstring CachePath(const Source& s, UINT side) {
    std::wstring key = s.name + L"|" + std::to_wstring(s.size) + L"|" + std::to_wstring(*(ULONGLONG*)&s.mtime);
    for (auto& c : key) c = (wchar_t)towlower(c);
    if (!s.path.empty()) { std::wstring p = s.path; for (auto& c : p) c = (wchar_t)towlower(c); key += L"|" + p; }
    wchar_t hex[32];
    swprintf_s(hex, L"%016llx-%u.png", Fnv(key.data(), key.size() * 2), side);
    return LocalDir(L"miniature\\cache") + L"\\" + hex;
}

static Bytes ReadFileBytes(const std::wstring& p) {
    HANDLE h = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return {};
    LARGE_INTEGER sz{};
    GetFileSizeEx(h, &sz);
    Bytes b;
    if (sz.QuadPart > 0 && sz.QuadPart < (64 << 20)) {
        b.resize((size_t)sz.QuadPart);
        DWORD got = 0;
        if (!ReadFile(h, b.data(), (DWORD)b.size(), &got, nullptr)) b.clear(); else b.resize(got);
    }
    CloseHandle(h);
    return b;
}

// copia temporanea del flusso (le miniature arrivano come flusso, senza percorso)
static std::wstring CopyToTemp(const Source& s) {
    if (!s.stream || s.size > (ULONGLONG)RegDword(L"MaxMB", 300) << 20) return L"";
    wchar_t hex[24];
    swprintf_s(hex, L"%016llx", Fnv(s.name.data(), s.name.size() * 2, *(ULONGLONG*)&s.mtime ^ s.size));
    std::wstring dir = LocalDir(L"miniature\\sorgenti") + L"\\" + hex;
    SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
    std::wstring p = dir + L"\\" + s.name;
    HANDLE h = CreateFileW(p.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (h == INVALID_HANDLE_VALUE) return L"";
    LARGE_INTEGER z{};
    s.stream->Seek(z, STREAM_SEEK_SET, nullptr);
    std::vector<BYTE> buf(1 << 20);
    bool ok = true;
    for (;;) {
        ULONG got = 0;
        HRESULT hr = s.stream->Read(buf.data(), (ULONG)buf.size(), &got);
        if (FAILED(hr)) { ok = false; break; }
        if (!got) break;
        DWORD w = 0;
        if (!WriteFile(h, buf.data(), got, &w, nullptr) || w != got) { ok = false; break; }
        if (hr == S_FALSE) break;
    }
    CloseHandle(h);
    if (!ok) { DeleteFileW(p.c_str()); RemoveDirectoryW(dir.c_str()); return L""; }
    return p;
}

static void RemoveTemp(const std::wstring& p) {
    if (p.empty()) return;
    DeleteFileW(p.c_str());
    std::wstring d = p.substr(0, p.find_last_of(L'\\'));
    RemoveDirectoryW(d.c_str());
}

// lancia MB Desk e aspetta il PNG (o la fine del processo, o il tempo massimo)
static bool RunRenderer(const std::wstring& src, const std::wstring& out, UINT side, DWORD timeoutMs, const std::atomic<bool>* cancel) {
    std::wstring cmd = RegStr(L"Comando");
    if (cmd.empty()) return false;
    cmd += L" --miniatura \"" + src + L"\" \"" + out + L"\" " + std::to_wstring(side);
    STARTUPINFOW si{sizeof(si)};
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_SHOWNOACTIVATE;  // non SW_HIDE: WebView2 in una finestra nascosta carica la pagina lentissimo
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> line(cmd.begin(), cmd.end());
    line.push_back(0);
    if (!CreateProcessW(nullptr, line.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) return false;
    CloseHandle(pi.hThread);
    ULONGLONG t0 = GetTickCount64();
    bool ok = false;
    while (GetTickCount64() - t0 < timeoutMs) {
        if (FileExists(out)) { ok = true; break; }
        if (cancel && *cancel) break;
        if (WaitForSingleObject(pi.hProcess, 150) == WAIT_OBJECT_0) { ok = FileExists(out); break; }
    }
    CloseHandle(pi.hProcess);  // il processo (servizio) resta acceso da solo per le richieste successive
    return ok;
}

static Bytes Rendered(const Source& s, UINT side, DWORD timeoutMs, const std::atomic<bool>* cancel = nullptr) {
    std::wstring cache = CachePath(s, side);
    if (FileExists(cache)) return ReadFileBytes(cache);
    if (!RegDword(L"Disegna", 1)) return {};
    std::wstring src = s.path, tmp;
    if (src.empty() || !FileExists(src)) src = tmp = CopyToTemp(s);
    if (src.empty()) return {};
    bool ok = RunRenderer(src, cache, side, timeoutMs, cancel);
    if (ok) RemoveTemp(tmp);  // se il tempo scade la copia resta al servizio, che la cancella dopo (miniature.py)
    return ok ? ReadFileBytes(cache) : Bytes();
}

static void FillSource(Source& s, IStream* st) {
    s.stream = st;
    STATSTG ss{};
    if (SUCCEEDED(st->Stat(&ss, STATFLAG_DEFAULT))) {
        s.size = ss.cbSize.QuadPart;
        s.mtime = ss.mtime;
        if (ss.pwcsName) {
            s.name = ss.pwcsName;
            if (PathIsRelativeW(ss.pwcsName) == FALSE && FileExists(ss.pwcsName)) s.path = ss.pwcsName;
            s.name = PathFindFileNameW(ss.pwcsName);
            CoTaskMemFree(ss.pwcsName);
        }
    }
    if (s.name.empty()) s.name = L"file.bin";
}

// ================================================================== IThumbnailProvider
class ThumbProvider : public IInitializeWithStream, public IThumbnailProvider {
    long ref = 1; IStream* st = nullptr;
public:
    ThumbProvider() { g_refs++; }
    ~ThumbProvider() { if (st) st->Release(); g_refs--; }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        static const QITAB qit[] = {QITABENT(ThumbProvider, IInitializeWithStream), QITABENT(ThumbProvider, IThumbnailProvider), {0}};
        return QISearch(this, qit, riid, ppv);
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref); }
    STDMETHODIMP_(ULONG) Release() override { long r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
    STDMETHODIMP Initialize(IStream* s, DWORD) override {
        if (st) return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
        st = s; st->AddRef();
        return S_OK;
    }
    STDMETHODIMP GetThumbnail(UINT cx, HBITMAP* phbmp, WTS_ALPHATYPE* alpha) override {
        if (!st) return E_UNEXPECTED;
        Source s;
        FillSource(s, st);
        UINT side = cx <= 512 ? 512 : 1024;
        Bytes img = Embedded(s);
        // anteprime incorporate molto piccole (DWG vecchi: 180x130): meglio il disegno di MB Desk se e' gia' pronto
        UINT w = 0, h = 0;
        HBITMAP hb = img.empty() ? nullptr : Decode(img.data(), img.size(), cx, false, &w, &h);
        if (hb && std::max(w, h) < std::min(cx, 200u) && FileExists(CachePath(s, side))) { DeleteObject(hb); hb = nullptr; }
        if (!hb) {
            img = Rendered(s, side, RegDword(L"AttesaMs", 45000));
            if (!img.empty()) hb = Decode(img.data(), img.size(), cx, false);
        }
        if (!hb) return E_FAIL;
        *phbmp = hb;
        *alpha = WTSAT_ARGB;
        return S_OK;
    }
};

// ================================================================== IPreviewHandler
struct PreviewJob {
    std::mutex m;
    HWND hwnd = nullptr;         // finestra a cui consegnare l'immagine (nullptr = anteprima chiusa)
    std::atomic<bool> cancel{false};
};

#define WM_MBV_IMAGE (WM_APP + 1)
#define ID_OPEN 101

class PreviewHandler : public IInitializeWithFile, public IInitializeWithStream, public IObjectWithSite, public IOleWindow,
                       public IPreviewHandler, public IPreviewHandlerVisuals {
    long ref = 1;
    IUnknown* site = nullptr;
    HWND parent = nullptr, hwnd = nullptr, btn = nullptr;
    RECT rc{};
    std::wstring path;
    IStream* st = nullptr;
    HBITMAP bmp = nullptr; UINT bw = 0, bh = 0;
    bool done = false;
    COLORREF bg = RGB(250, 250, 250), fg = RGB(60, 60, 60);
    HFONT font = nullptr;
    std::shared_ptr<PreviewJob> job;

    static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
        PreviewHandler* self = (PreviewHandler*)GetWindowLongPtrW(h, GWLP_USERDATA);
        if (msg == WM_NCCREATE) {
            self = (PreviewHandler*)((CREATESTRUCTW*)lp)->lpCreateParams;
            SetWindowLongPtrW(h, GWLP_USERDATA, (LONG_PTR)self);
        }
        if (self) return self->Proc(h, msg, wp, lp);
        return DefWindowProcW(h, msg, wp, lp);
    }

    LRESULT Proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
        switch (msg) {
        case WM_ERASEBKGND: return 1;
        case WM_PAINT: { PAINTSTRUCT ps; HDC dc = BeginPaint(h, &ps); Paint(dc); EndPaint(h, &ps); return 0; }
        case WM_SIZE: LayoutButton(); InvalidateRect(h, nullptr, FALSE); return 0;
        case WM_MBV_IMAGE: {
            HBITMAP nb = (HBITMAP)wp;
            if (nb) { if (bmp) DeleteObject(bmp); bmp = nb; BITMAP b; GetObject(bmp, sizeof(b), &b); bw = b.bmWidth; bh = abs(b.bmHeight); }
            if (lp) done = true;
            InvalidateRect(h, nullptr, FALSE);
            return 0;
        }
        case WM_COMMAND:
            if (LOWORD(wp) == ID_OPEN) OpenInApp();
            return 0;
        }
        return DefWindowProcW(h, msg, wp, lp);
    }

    void OpenInApp() {
        std::wstring cmd = RegStr(L"Apri");
        if (cmd.empty() || path.empty()) return;
        cmd += L" \"" + path + L"\"";
        STARTUPINFOW si{sizeof(si)};
        PROCESS_INFORMATION pi{};
        std::vector<wchar_t> line(cmd.begin(), cmd.end()); line.push_back(0);
        if (CreateProcessW(nullptr, line.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
    }

    void LayoutButton() {
        if (!btn || !hwnd) return;
        RECT r; GetClientRect(hwnd, &r);
        UINT dpi = GetDpiForWindow(hwnd);
        int w = MulDiv(150, dpi, 96), hh = MulDiv(28, dpi, 96), m = MulDiv(10, dpi, 96);
        MoveWindow(btn, r.right - w - m, r.bottom - hh - m, w, hh, TRUE);
    }

    void Paint(HDC dc) {
        RECT r; GetClientRect(hwnd, &r);
        HDC mem = CreateCompatibleDC(dc);
        HBITMAP buf = CreateCompatibleBitmap(dc, std::max(1L, r.right), std::max(1L, r.bottom));
        HGDIOBJ ob = SelectObject(mem, buf);
        HBRUSH br = CreateSolidBrush(bg);
        FillRect(mem, &r, br);
        DeleteObject(br);
        UINT dpi = GetDpiForWindow(hwnd);
        int bottom = MulDiv(48, dpi, 96);
        RECT area{r.left + 8, r.top + 8, r.right - 8, r.bottom - bottom};
        if (bmp && area.right > area.left && area.bottom > area.top) {
            double k = std::min((double)(area.right - area.left) / bw, (double)(area.bottom - area.top) / bh);
            int w = std::max(1, (int)(bw * k)), h = std::max(1, (int)(bh * k));
            int x = area.left + (area.right - area.left - w) / 2, y = area.top + (area.bottom - area.top - h) / 2;
            HDC src = CreateCompatibleDC(mem);
            HGDIOBJ o2 = SelectObject(src, bmp);
            SetStretchBltMode(mem, HALFTONE);
            BLENDFUNCTION bf{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
            AlphaBlend(mem, x, y, w, h, src, 0, 0, bw, bh, bf);
            SelectObject(src, o2);
            DeleteDC(src);
        }
        ::SetBkMode(mem, TRANSPARENT);
        ::SetTextColor(mem, fg);
        HGDIOBJ of = SelectObject(mem, font);
        RECT tr{r.left + 12, r.bottom - bottom, r.right - MulDiv(170, dpi, 96), r.bottom};
        const wchar_t* msg = !done ? L"MB Desk: preparazione dell'anteprima..." : (bmp ? L"" : L"MB Desk: anteprima non disponibile per questo file");
        DrawTextW(mem, msg, -1, &tr, DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
        SelectObject(mem, of);
        BitBlt(dc, 0, 0, r.right, r.bottom, mem, 0, 0, SRCCOPY);
        SelectObject(mem, ob);
        DeleteObject(buf);
        DeleteDC(mem);
    }

    void Start() {
        job = std::make_shared<PreviewJob>();
        job->hwnd = hwnd;
        struct Arg { std::shared_ptr<PreviewJob> job; std::wstring path; IStream* st; };
        Arg* a = new Arg{job, path, nullptr};
        if (st) CoMarshalInterThreadInterfaceInStream(IID_IStream, st, &a->st);
        g_refs++;
        HMODULE self = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, (LPCWSTR)&g_inst, &self);
        HANDLE th = CreateThread(nullptr, 0, [](LPVOID p) -> DWORD {
            Arg* a = (Arg*)p;
            CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
            IStream* s = nullptr;
            if (a->st) CoGetInterfaceAndReleaseStream(a->st, IID_IStream, (void**)&s);
            else if (!a->path.empty()) SHCreateStreamOnFileEx(a->path.c_str(), STGM_READ | STGM_SHARE_DENY_NONE, 0, FALSE, nullptr, &s);
            Source src;
            if (s) FillSource(src, s);
            if (!a->path.empty()) { src.path = a->path; src.name = PathFindFileNameW(a->path.c_str()); }
            auto post = [&](HBITMAP hb, bool last) {
                std::lock_guard<std::mutex> g(a->job->m);
                if (a->job->hwnd && PostMessageW(a->job->hwnd, WM_MBV_IMAGE, (WPARAM)hb, last)) return;
                if (hb) DeleteObject(hb);
            };
            if (s) {
                Bytes img = Embedded(src);
                if (!img.empty()) post(Decode(img.data(), img.size(), 0, true), false);
                img = Rendered(src, 1024, RegDword(L"AttesaAnteprimaMs", 90000), &a->job->cancel);
                post(img.empty() ? nullptr : Decode(img.data(), img.size(), 0, true), true);
                s->Release();
            } else {
                post(nullptr, true);
            }
            delete a;
            CoUninitialize();
            g_refs--;
            FreeLibraryAndExitThread(g_inst, 0);  // la DLL resta caricata finche' il lavoro non e' finito
            return 0;
        }, a, 0, nullptr);
        if (th) CloseHandle(th); else { g_refs--; delete a; FreeLibrary(self); }
    }

    void StopJob() {
        if (!job) return;
        std::lock_guard<std::mutex> g(job->m);
        job->hwnd = nullptr;
        job->cancel = true;
        job.reset();
    }

public:
    PreviewHandler() { g_refs++; }
    ~PreviewHandler() { Unload(); if (site) site->Release(); if (font) DeleteObject(font); g_refs--; }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        static const QITAB qit[] = {
            QITABENT(PreviewHandler, IInitializeWithFile), QITABENT(PreviewHandler, IInitializeWithStream),
            QITABENT(PreviewHandler, IObjectWithSite), QITABENT(PreviewHandler, IOleWindow),
            QITABENT(PreviewHandler, IPreviewHandler), QITABENT(PreviewHandler, IPreviewHandlerVisuals), {0}};
        return QISearch(this, qit, riid, ppv);
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref); }
    STDMETHODIMP_(ULONG) Release() override { long r = InterlockedDecrement(&ref); if (!r) delete this; return r; }

    STDMETHODIMP Initialize(LPCWSTR p, DWORD) override { path = p; return S_OK; }
    STDMETHODIMP Initialize(IStream* s, DWORD) override { if (st) st->Release(); st = s; st->AddRef(); return S_OK; }

    STDMETHODIMP SetSite(IUnknown* s) override { if (site) site->Release(); site = s; if (site) site->AddRef(); return S_OK; }
    STDMETHODIMP GetSite(REFIID riid, void** ppv) override { return site ? site->QueryInterface(riid, ppv) : E_FAIL; }

    STDMETHODIMP GetWindow(HWND* ph) override { *ph = parent; return parent ? S_OK : E_FAIL; }
    STDMETHODIMP ContextSensitiveHelp(BOOL) override { return E_NOTIMPL; }

    STDMETHODIMP SetWindow(HWND h, const RECT* r) override {
        parent = h; rc = *r;
        if (hwnd) { SetParent(hwnd, parent); SetWindowPos(hwnd, nullptr, rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top, SWP_NOZORDER | SWP_NOACTIVATE); }
        return S_OK;
    }
    STDMETHODIMP SetRect(const RECT* r) override {
        rc = *r;
        if (hwnd) SetWindowPos(hwnd, nullptr, rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top, SWP_NOZORDER | SWP_NOACTIVATE);
        return S_OK;
    }
    STDMETHODIMP DoPreview() override {
        if (hwnd) return S_OK;
        static ATOM cls = 0;
        if (!cls) {
            WNDCLASSW wc{};
            wc.lpfnWndProc = WndProc;
            wc.hInstance = g_inst;
            wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
            wc.lpszClassName = L"MBVisualAnteprima";
            cls = RegisterClassW(&wc);
        }
        hwnd = CreateWindowExW(0, L"MBVisualAnteprima", L"", WS_CHILD | WS_CLIPCHILDREN | WS_VISIBLE, rc.left, rc.top,
                               rc.right - rc.left, rc.bottom - rc.top, parent, nullptr, g_inst, this);
        if (!hwnd) return HRESULT_FROM_WIN32(GetLastError());
        UINT dpi = GetDpiForWindow(hwnd);
        NONCLIENTMETRICSW ncm{sizeof(ncm)};
        SystemParametersInfoForDpi(SPI_GETNONCLIENTMETRICS, sizeof(ncm), &ncm, 0, dpi);
        font = CreateFontIndirectW(&ncm.lfMessageFont);
        if (!path.empty() && !RegStr(L"Apri").empty()) {
            btn = CreateWindowExW(0, L"BUTTON", L"Apri in MB Desk", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 0, 0, 10, 10, hwnd, (HMENU)ID_OPEN, g_inst, nullptr);
            SendMessageW(btn, WM_SETFONT, (WPARAM)font, TRUE);
            LayoutButton();
        }
        Start();
        return S_OK;
    }
    STDMETHODIMP Unload() override {
        StopJob();
        if (hwnd) { DestroyWindow(hwnd); hwnd = nullptr; btn = nullptr; }
        if (bmp) { DeleteObject(bmp); bmp = nullptr; }
        if (st) { st->Release(); st = nullptr; }
        done = false;
        return S_OK;
    }
    STDMETHODIMP SetFocus() override { if (btn) ::SetFocus(btn); return S_OK; }
    STDMETHODIMP QueryFocus(HWND* ph) override { *ph = GetFocus(); return *ph ? S_OK : HRESULT_FROM_WIN32(GetLastError()); }
    STDMETHODIMP TranslateAccelerator(MSG* m) override {
        IPreviewHandlerFrame* fr = nullptr;
        HRESULT hr = S_FALSE;
        if (site && SUCCEEDED(site->QueryInterface(IID_PPV_ARGS(&fr)))) { hr = fr->TranslateAccelerator(m); fr->Release(); }
        return hr;
    }

    STDMETHODIMP SetBackgroundColor(COLORREF c) override { bg = c; if (hwnd) InvalidateRect(hwnd, nullptr, FALSE); return S_OK; }
    STDMETHODIMP SetFont(const LOGFONTW*) override { return S_OK; }
    STDMETHODIMP SetTextColor(COLORREF c) override { fg = c; if (hwnd) InvalidateRect(hwnd, nullptr, FALSE); return S_OK; }
};

// ================================================================== fabbrica di classi ed esportazioni
template <class T>
class Factory : public IClassFactory {
    long ref = 1;
public:
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (riid == IID_IUnknown || riid == IID_IClassFactory) { *ppv = this; AddRef(); return S_OK; }
        *ppv = nullptr; return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref); }
    STDMETHODIMP_(ULONG) Release() override { long r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
    STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
        *ppv = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        T* o = new (std::nothrow) T();
        if (!o) return E_OUTOFMEMORY;
        HRESULT hr = o->QueryInterface(riid, ppv);
        o->Release();
        return hr;
    }
    STDMETHODIMP LockServer(BOOL lock) override { if (lock) g_refs++; else g_refs--; return S_OK; }
};

extern "C" BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) { g_inst = h; DisableThreadLibraryCalls(h); }
    return TRUE;
}

STDAPI DllCanUnloadNow() { return g_refs == 0 ? S_OK : S_FALSE; }

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
    *ppv = nullptr;
    IClassFactory* f = nullptr;
    if (clsid == CLSID_Thumb) f = new (std::nothrow) Factory<ThumbProvider>();
    else if (clsid == CLSID_Preview) f = new (std::nothrow) Factory<PreviewHandler>();
    else return CLASS_E_CLASSNOTAVAILABLE;
    if (!f) return E_OUTOFMEMORY;
    HRESULT hr = f->QueryInterface(riid, ppv);
    f->Release();
    return hr;
}
