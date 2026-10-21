"""Firma con i certificati del magazzino di Windows (smart card, CNS, token USB, certificati software).

La chiave privata non esce mai dal dispositivo: l'app passa a Windows solo l'impronta (hash) da firmare con
NCryptSignHash (CNG) o, per i vecchi driver, CryptSignHash (CryptoAPI). Il PIN lo chiede la finestra di Windows
(o del driver del dispositivo): l'app non lo vede mai. Solo funzioni di sistema (crypt32.dll, ncrypt.dll) via ctypes.
"""
import ctypes
import hashlib
from ctypes import wintypes as W

from .i18n import t

crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
ncrypt = ctypes.WinDLL("ncrypt")
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

X509_ASN_ENCODING = 0x1
PKCS_7_ASN_ENCODING = 0x10000
CERT_STORE_PROV_SYSTEM_W = 10
CERT_SYSTEM_STORE_CURRENT_USER = 0x10000
CERT_STORE_READONLY_FLAG = 0x8000
CERT_STORE_OPEN_EXISTING_FLAG = 0x4000
CERT_KEY_PROV_INFO_PROP_ID = 2
CERT_NCRYPT_KEY_HANDLE_PROP_ID = 78
CRYPT_ACQUIRE_CACHE_FLAG = 0x1
CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG = 0x80
CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG = 0x20000
CERT_NCRYPT_KEY_SPEC = 0xFFFFFFFF
BCRYPT_PAD_PKCS1 = 0x2
HP_HASHVAL = 0x2
CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL = 0x80000000
CALG = {"sha1": 0x8004, "sha256": 0x800C, "sha384": 0x800D, "sha512": 0x800E}
NCRYPT_ALG = {"sha1": "SHA1", "sha256": "SHA256", "sha384": "SHA384", "sha512": "SHA512"}


class CERT_CONTEXT(ctypes.Structure):
    _fields_ = [("dwCertEncodingType", W.DWORD), ("pbCertEncoded", ctypes.POINTER(ctypes.c_ubyte)),
                ("cbCertEncoded", W.DWORD), ("pCertInfo", ctypes.c_void_p), ("hCertStore", ctypes.c_void_p)]


PCCERT_CONTEXT = ctypes.POINTER(CERT_CONTEXT)


class CRYPT_KEY_PROV_INFO(ctypes.Structure):
    _fields_ = [("pwszContainerName", W.LPWSTR), ("pwszProvName", W.LPWSTR), ("dwProvType", W.DWORD),
                ("dwFlags", W.DWORD), ("cProvParam", W.DWORD), ("rgProvParam", ctypes.c_void_p), ("dwKeySpec", W.DWORD)]


class CRYPT_DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", W.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


class BCRYPT_PKCS1_PADDING_INFO(ctypes.Structure):
    _fields_ = [("pszAlgId", W.LPCWSTR)]


class CERT_TRUST_STATUS(ctypes.Structure):
    _fields_ = [("dwErrorStatus", W.DWORD), ("dwInfoStatus", W.DWORD)]


class CERT_CHAIN_ELEMENT(ctypes.Structure):
    _fields_ = [("cbSize", W.DWORD), ("pCertContext", PCCERT_CONTEXT), ("TrustStatus", CERT_TRUST_STATUS)]


class CERT_SIMPLE_CHAIN(ctypes.Structure):
    _fields_ = [("cbSize", W.DWORD), ("TrustStatus", CERT_TRUST_STATUS), ("cElement", W.DWORD),
                ("rgpElement", ctypes.POINTER(ctypes.POINTER(CERT_CHAIN_ELEMENT)))]


class CERT_CHAIN_CONTEXT(ctypes.Structure):
    _fields_ = [("cbSize", W.DWORD), ("TrustStatus", CERT_TRUST_STATUS), ("cChain", W.DWORD),
                ("rgpChain", ctypes.POINTER(ctypes.POINTER(CERT_SIMPLE_CHAIN)))]


class CERT_CHAIN_PARA(ctypes.Structure):
    # RequestedUsage = { dwType, { cUsageIdentifier, rgpszUsageIdentifier } }: tutto a zero = nessun vincolo
    _fields_ = [("cbSize", W.DWORD), ("dwType", W.DWORD), ("cUsage", W.DWORD), ("rgpszUsage", ctypes.c_void_p)]


crypt32.CertOpenStore.restype = ctypes.c_void_p
crypt32.CertOpenStore.argtypes = [ctypes.c_void_p, W.DWORD, ctypes.c_void_p, W.DWORD, ctypes.c_void_p]
crypt32.PFXImportCertStore.restype = ctypes.c_void_p
crypt32.PFXImportCertStore.argtypes = [ctypes.POINTER(CRYPT_DATA_BLOB), W.LPCWSTR, W.DWORD]
crypt32.CertDuplicateStore.restype = ctypes.c_void_p
crypt32.CertDuplicateStore.argtypes = [ctypes.c_void_p]
crypt32.CertCloseStore.argtypes = [ctypes.c_void_p, W.DWORD]
crypt32.CertEnumCertificatesInStore.restype = PCCERT_CONTEXT
crypt32.CertEnumCertificatesInStore.argtypes = [ctypes.c_void_p, PCCERT_CONTEXT]
crypt32.CertDuplicateCertificateContext.restype = PCCERT_CONTEXT
crypt32.CertDuplicateCertificateContext.argtypes = [PCCERT_CONTEXT]
crypt32.CertFreeCertificateContext.argtypes = [PCCERT_CONTEXT]
crypt32.CertGetCertificateContextProperty.restype = W.BOOL
crypt32.CertGetCertificateContextProperty.argtypes = [PCCERT_CONTEXT, W.DWORD, ctypes.c_void_p, ctypes.POINTER(W.DWORD)]
crypt32.CryptAcquireCertificatePrivateKey.restype = W.BOOL
crypt32.CryptAcquireCertificatePrivateKey.argtypes = [PCCERT_CONTEXT, W.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                                                       ctypes.POINTER(W.DWORD), ctypes.POINTER(W.BOOL)]
crypt32.CertGetCertificateChain.restype = W.BOOL
crypt32.CertGetCertificateChain.argtypes = [ctypes.c_void_p, PCCERT_CONTEXT, ctypes.c_void_p, ctypes.c_void_p,
                                            ctypes.POINTER(CERT_CHAIN_PARA), W.DWORD, ctypes.c_void_p,
                                            ctypes.POINTER(ctypes.POINTER(CERT_CHAIN_CONTEXT))]
crypt32.CertFreeCertificateChain.argtypes = [ctypes.POINTER(CERT_CHAIN_CONTEXT)]
ncrypt.NCryptSignHash.restype = ctypes.c_long
ncrypt.NCryptSignHash.argtypes = [ctypes.c_size_t, ctypes.c_void_p, ctypes.c_char_p, W.DWORD, ctypes.c_void_p, W.DWORD,
                                  ctypes.POINTER(W.DWORD), W.DWORD]
ncrypt.NCryptFreeObject.argtypes = [ctypes.c_size_t]
advapi32.CryptCreateHash.restype = W.BOOL
advapi32.CryptCreateHash.argtypes = [ctypes.c_size_t, W.DWORD, ctypes.c_size_t, W.DWORD, ctypes.POINTER(ctypes.c_size_t)]
advapi32.CryptSetHashParam.restype = W.BOOL
advapi32.CryptSetHashParam.argtypes = [ctypes.c_size_t, W.DWORD, ctypes.c_char_p, W.DWORD]
advapi32.CryptSignHashW.restype = W.BOOL
advapi32.CryptSignHashW.argtypes = [ctypes.c_size_t, W.DWORD, W.LPCWSTR, W.DWORD, ctypes.c_void_p, ctypes.POINTER(W.DWORD)]
advapi32.CryptDestroyHash.argtypes = [ctypes.c_size_t]
advapi32.CryptReleaseContext.argtypes = [ctypes.c_size_t, W.DWORD]

# errori frequenti con smart card e token: messaggi comprensibili (chiavi srv_firma.win_*)
_ERRORI = {
    0x8010006E: "srv_firma.win_annullato", 0x800704C7: "srv_firma.win_annullato", 0x80090030: "srv_firma.win_non_risponde",
    0x8010000C: "srv_firma.win_non_inserita", 0x80100069: "srv_firma.win_rimossa", 0x8010006B: "srv_firma.win_pin_errato",
    0x8010006C: "srv_firma.win_pin_bloccato", 0x80090016: "srv_firma.win_chiave_assente", 0x8009000D: "srv_firma.win_chiave_assente",
    0x80090029: "srv_firma.win_non_supportato", 0x8009000F: "srv_firma.win_contenitore", 0x80090027: "srv_firma.win_parametro",
}
_OPERAZIONI = {"magazzino": "srv_firma.winop_magazzino", "prova": "srv_firma.winop_prova", "chiave": "srv_firma.winop_chiave",
               "firma": "srv_firma.winop_firma", "impronta": "srv_firma.winop_impronta"}


class WinSignError(Exception):
    pass


def _err(code: int, what: str) -> WinSignError:
    code &= 0xFFFFFFFF
    msg = t(_ERRORI[code]) if code in _ERRORI else (ctypes.FormatError(code).strip() if code else "?")
    return WinSignError(f"{msg} ({t(_OPERAZIONI[what])}, 0x{code:08X})")


def _der(ctx) -> bytes:
    return ctypes.string_at(ctx.contents.pbCertEncoded, ctx.contents.cbCertEncoded)


def _prov_info(ctx):
    cb = W.DWORD(0)
    if not crypt32.CertGetCertificateContextProperty(ctx, CERT_KEY_PROV_INFO_PROP_ID, None, ctypes.byref(cb)):
        return None
    buf = ctypes.create_string_buffer(cb.value)
    if not crypt32.CertGetCertificateContextProperty(ctx, CERT_KEY_PROV_INFO_PROP_ID, buf, ctypes.byref(cb)):
        return None
    info = ctypes.cast(buf, ctypes.POINTER(CRYPT_KEY_PROV_INFO)).contents
    return {"provider": info.pwszProvName or "", "contenitore": info.pwszContainerName or "", "tipo": info.dwProvType}


def _has_prop(ctx, prop) -> bool:
    cb = W.DWORD(0)
    return bool(crypt32.CertGetCertificateContextProperty(ctx, prop, None, ctypes.byref(cb)))


def _open_my():
    h = crypt32.CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, None,
                              CERT_SYSTEM_STORE_CURRENT_USER | CERT_STORE_READONLY_FLAG | CERT_STORE_OPEN_EXISTING_FLAG,
                              ctypes.c_wchar_p("MY"))
    if not h:
        raise _err(ctypes.get_last_error(), "magazzino")
    return h


_open_store = _open_my


def use_test_pfx(pfx: bytes | None, password: str = "") -> None:
    """SOLO COLLAUDO: sostituisce il magazzino personale con un magazzino in memoria creato da un .pfx, con la chiave
    non salvata nel sistema (PKCS12_NO_PERSIST_KEY + provider CNG): prova lo stesso percorso NCrypt senza toccare
    i certificati di Windows. None = torna al magazzino personale."""
    global _open_store
    if pfx is None:
        _open_store = _open_my
        return
    blob = CRYPT_DATA_BLOB(len(pfx), ctypes.cast(ctypes.create_string_buffer(pfx, len(pfx)), ctypes.POINTER(ctypes.c_ubyte)))
    mem = crypt32.PFXImportCertStore(ctypes.byref(blob), password, 0x8000 | 0x200)  # NO_PERSIST_KEY | ALWAYS_CNG_KSP
    if not mem:
        raise _err(ctypes.get_last_error(), "prova")
    _open_store = lambda: crypt32.CertDuplicateStore(mem)  # noqa: E731


def list_certificates() -> list[dict]:
    """Certificati personali con chiave privata associata: [{id (SHA-1), der, provider}]."""
    out = []
    store = _open_store()
    try:
        ctx = crypt32.CertEnumCertificatesInStore(store, None)
        while ctx:
            prov = _prov_info(ctx)
            if prov is None and _has_prop(ctx, CERT_NCRYPT_KEY_HANDLE_PROP_ID):
                prov = {"provider": "", "contenitore": "", "tipo": 0}
            if prov is not None:
                der = _der(ctx)
                out.append({"id": hashlib.sha1(der).hexdigest().upper(), "der": der, **prov})
            ctx = crypt32.CertEnumCertificatesInStore(store, ctx)  # libera il precedente
    finally:
        crypt32.CertCloseStore(store, 0)
    return out


def _find(store, cert_id: str):
    """Contesto del certificato (da liberare con CertFreeCertificateContext) o None."""
    ctx = crypt32.CertEnumCertificatesInStore(store, None)
    while ctx:
        if hashlib.sha1(_der(ctx)).hexdigest().upper() == cert_id.upper():
            return ctx  # l'enumerazione si ferma qui: il contesto resta a chi chiama
        ctx = crypt32.CertEnumCertificatesInStore(store, ctx)
    return None


def chain(cert_id: str) -> list[bytes]:
    """Certificati della catena (intermedi e radice) costruita da Windows, senza scaricare nulla dalla rete."""
    store = _open_store()
    try:
        ctx = _find(store, cert_id)
        if not ctx:
            return []
        try:
            para = CERT_CHAIN_PARA()
            para.cbSize = ctypes.sizeof(CERT_CHAIN_PARA)
            pchain = ctypes.POINTER(CERT_CHAIN_CONTEXT)()
            if not crypt32.CertGetCertificateChain(None, ctx, None, None, ctypes.byref(para), CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL,
                                                   None, ctypes.byref(pchain)):
                return []
            try:
                res = []
                cc = pchain.contents
                if cc.cChain:
                    sc = cc.rgpChain[0].contents
                    for i in range(1, sc.cElement):
                        res.append(_der(sc.rgpElement[i].contents.pCertContext))
                return res
            finally:
                crypt32.CertFreeCertificateChain(pchain)
        finally:
            crypt32.CertFreeCertificateContext(ctx)
    finally:
        crypt32.CertCloseStore(store, 0)


def sign_digest(cert_id: str, digest: bytes, hash_name: str, key_algo: str, hwnd: int | None = None) -> bytes:
    """Firma un'impronta gia' calcolata. RSA -> PKCS#1 v1.5; EC -> (r||s) grezzo come lo restituisce Windows."""
    hash_name = hash_name.lower()
    if hash_name not in NCRYPT_ALG:
        raise WinSignError(t("srv_firma.impronta_non_supportata", hash_name))
    store = _open_store()
    try:
        ctx = _find(store, cert_id)
        if not ctx:
            raise WinSignError(t("srv_firma.cert_non_trovato"))
        try:
            key = ctypes.c_size_t(0)
            spec = W.DWORD(0)
            free = W.BOOL(False)
            flags = CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG | CRYPT_ACQUIRE_CACHE_FLAG
            hw = ctypes.c_void_p(hwnd) if hwnd else None
            if hw:
                flags |= CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG
            if not crypt32.CryptAcquireCertificatePrivateKey(ctx, flags, ctypes.byref(hw) if hw else None, ctypes.byref(key),
                                                             ctypes.byref(spec), ctypes.byref(free)):
                raise _err(ctypes.get_last_error(), "chiave")
            try:
                if spec.value == CERT_NCRYPT_KEY_SPEC:
                    return _sign_cng(key.value, digest, hash_name, key_algo)
                return _sign_capi(key.value, spec.value, digest, hash_name, key_algo)
            finally:
                if free.value:
                    if spec.value == CERT_NCRYPT_KEY_SPEC:
                        ncrypt.NCryptFreeObject(key.value)
                    else:
                        advapi32.CryptReleaseContext(key.value, 0)
        finally:
            crypt32.CertFreeCertificateContext(ctx)
    finally:
        crypt32.CertCloseStore(store, 0)


def _sign_cng(key: int, digest: bytes, hash_name: str, key_algo: str) -> bytes:
    pad, flags = None, 0
    if key_algo == "rsa":
        pad = BCRYPT_PKCS1_PADDING_INFO(NCRYPT_ALG[hash_name])
        flags = BCRYPT_PAD_PKCS1
    ppad = ctypes.byref(pad) if pad is not None else None
    size = W.DWORD(0)
    st = ncrypt.NCryptSignHash(key, ppad, digest, len(digest), None, 0, ctypes.byref(size), flags)
    if st:
        raise _err(st, "firma")
    buf = ctypes.create_string_buffer(size.value)
    st = ncrypt.NCryptSignHash(key, ppad, digest, len(digest), buf, size.value, ctypes.byref(size), flags)
    if st:
        raise _err(st, "firma")
    return buf.raw[: size.value]


def _sign_capi(prov: int, spec: int, digest: bytes, hash_name: str, key_algo: str) -> bytes:
    if key_algo != "rsa":
        raise WinSignError(t("srv_firma.capi_solo_rsa"))
    h = ctypes.c_size_t(0)
    if not advapi32.CryptCreateHash(prov, CALG[hash_name], 0, 0, ctypes.byref(h)):
        raise _err(ctypes.get_last_error(), "impronta")
    try:
        if not advapi32.CryptSetHashParam(h.value, HP_HASHVAL, digest, 0):
            raise _err(ctypes.get_last_error(), "impronta")
        size = W.DWORD(0)
        if not advapi32.CryptSignHashW(h.value, spec, None, 0, None, ctypes.byref(size)):
            raise _err(ctypes.get_last_error(), "firma")
        buf = ctypes.create_string_buffer(size.value)
        if not advapi32.CryptSignHashW(h.value, spec, None, 0, buf, ctypes.byref(size)):
            raise _err(ctypes.get_last_error(), "firma")
        return buf.raw[: size.value][::-1]  # CryptoAPI restituisce la firma in little-endian
    finally:
        advapi32.CryptDestroyHash(h.value)
