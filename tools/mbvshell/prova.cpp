// Prova di mbvshell.dll senza registrarla: carica la DLL, crea il fornitore di miniature con il flusso del file
// (come fa Esplora) e salva il risultato in PNG.
//   prova.exe <mbvshell.dll> <file> <uscita.png> [lato]        (comando di MB Visual in MBVSHELL_Comando)
//   prova.exe --shell <file> <uscita.png> [lato]               miniatura chiesta a Windows (DLL gia' registrata)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <thumbcache.h>
#include <wincodec.h>
#include <cstdio>
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "gdi32.lib")

static const CLSID CLSID_Thumb = {0x6f1d8e2a, 0x5c4f, 0x4e3b, {0x9a, 0x1d, 0x2f, 0x6c, 0x8b, 0x0e, 0x4a, 0x11}};

static bool SavePng(HBITMAP hb, const wchar_t* out) {
    IWICImagingFactory* f = nullptr;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&f)))) return false;
    IWICBitmap* bmp = nullptr; IWICStream* st = nullptr; IWICBitmapEncoder* enc = nullptr; IWICBitmapFrameEncode* fr = nullptr;
    bool ok = SUCCEEDED(f->CreateBitmapFromHBITMAP(hb, nullptr, WICBitmapUseAlpha, &bmp)) && SUCCEEDED(f->CreateStream(&st)) &&
              SUCCEEDED(st->InitializeFromFilename(out, GENERIC_WRITE)) && SUCCEEDED(f->CreateEncoder(GUID_ContainerFormatPng, nullptr, &enc)) &&
              SUCCEEDED(enc->Initialize(st, WICBitmapEncoderNoCache)) && SUCCEEDED(enc->CreateNewFrame(&fr, nullptr)) &&
              SUCCEEDED(fr->Initialize(nullptr)) && SUCCEEDED(fr->WriteSource(bmp, nullptr)) && SUCCEEDED(fr->Commit()) && SUCCEEDED(enc->Commit());
    if (fr) fr->Release(); if (enc) enc->Release(); if (st) st->Release(); if (bmp) bmp->Release(); f->Release();
    return ok;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 4) { fwprintf(stderr, L"uso: prova.exe <dll|--shell> <file> <uscita.png> [lato]\n"); return 2; }
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    UINT cx = argc > 4 ? _wtoi(argv[4]) : 256;
    HBITMAP hb = nullptr;
    ULONGLONG t0 = GetTickCount64();
    HRESULT hr;
    if (!wcscmp(argv[1], L"--shell")) {
        IShellItemImageFactory* fac = nullptr;
        hr = SHCreateItemFromParsingName(argv[2], nullptr, IID_PPV_ARGS(&fac));
        if (SUCCEEDED(hr)) { hr = fac->GetImage(SIZE{(LONG)cx, (LONG)cx}, SIIGBF_THUMBNAILONLY, &hb); fac->Release(); }
    } else {
        HMODULE m = LoadLibraryW(argv[1]);
        if (!m) { fwprintf(stderr, L"DLL non caricata (%lu)\n", GetLastError()); return 1; }
        auto get = (HRESULT(WINAPI*)(REFCLSID, REFIID, void**))GetProcAddress(m, "DllGetClassObject");
        IClassFactory* cf = nullptr;
        hr = get(CLSID_Thumb, IID_PPV_ARGS(&cf));
        IInitializeWithStream* init = nullptr;
        if (SUCCEEDED(hr)) hr = cf->CreateInstance(nullptr, IID_PPV_ARGS(&init));
        IStream* st = nullptr;
        if (SUCCEEDED(hr)) hr = SHCreateStreamOnFileEx(argv[2], STGM_READ | STGM_SHARE_DENY_NONE, 0, FALSE, nullptr, &st);
        if (SUCCEEDED(hr)) hr = init->Initialize(st, STGM_READ);
        IThumbnailProvider* tp = nullptr;
        if (SUCCEEDED(hr)) hr = init->QueryInterface(IID_PPV_ARGS(&tp));
        WTS_ALPHATYPE at;
        if (SUCCEEDED(hr)) hr = tp->GetThumbnail(cx, &hb, &at);
        if (tp) tp->Release(); if (st) st->Release(); if (init) init->Release(); if (cf) cf->Release();
    }
    if (FAILED(hr) || !hb) { wprintf(L"nessuna miniatura (0x%08lx) in %llu ms\n", hr, GetTickCount64() - t0); return 1; }
    BITMAP b; GetObject(hb, sizeof(b), &b);
    bool ok = SavePng(hb, argv[3]);
    wprintf(L"miniatura %ldx%ld in %llu ms -> %s\n", b.bmWidth, b.bmHeight, GetTickCount64() - t0, ok ? argv[3] : L"(non salvata)");
    return ok ? 0 : 1;
}
