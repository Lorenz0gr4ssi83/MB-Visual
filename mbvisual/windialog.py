"""Finestre di Windows Apri / Salva con nome / Scegli cartella chiamate direttamente (ctypes, comdlg32 e shell32).

Servono quando MB Visual non ha la sua finestra (pythonnet bloccato da criteri aziendali o antivirus) e gira nel ripiego
in Edge: senza queste l'interfaccia poteva solo chiedere di scrivere il percorso a mano. Ogni chiamata blocca finche'
l'utente chiude la finestra; la finestra si aggancia a quella in primo piano (Edge) per restarle sopra.
"""
import ctypes
import os
from ctypes import wintypes

_BUF = 65536  # caratteri: abbastanza per molti file scelti insieme

OFN_ALLOWMULTISELECT = 0x00000200
OFN_EXPLORER = 0x00080000
OFN_FILEMUSTEXIST = 0x00001000
OFN_PATHMUSTEXIST = 0x00000800
OFN_OVERWRITEPROMPT = 0x00000002
OFN_NOCHANGEDIR = 0x00000008


class OPENFILENAMEW(ctypes.Structure):
    _fields_ = [("lStructSize", wintypes.DWORD), ("hwndOwner", wintypes.HWND), ("hInstance", wintypes.HINSTANCE),
                ("lpstrFilter", wintypes.LPCWSTR), ("lpstrCustomFilter", wintypes.LPWSTR), ("nMaxCustFilter", wintypes.DWORD),
                ("nFilterIndex", wintypes.DWORD), ("lpstrFile", wintypes.LPWSTR), ("nMaxFile", wintypes.DWORD),
                ("lpstrFileTitle", wintypes.LPWSTR), ("nMaxFileTitle", wintypes.DWORD), ("lpstrInitialDir", wintypes.LPCWSTR),
                ("lpstrTitle", wintypes.LPCWSTR), ("Flags", wintypes.DWORD), ("nFileOffset", wintypes.WORD),
                ("nFileExtension", wintypes.WORD), ("lpstrDefExt", wintypes.LPCWSTR), ("lCustData", wintypes.LPARAM),
                ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wintypes.LPCWSTR), ("pvReserved", ctypes.c_void_p),
                ("dwReserved", wintypes.DWORD), ("FlagsEx", wintypes.DWORD)]


class BROWSEINFOW(ctypes.Structure):
    _fields_ = [("hwndOwner", wintypes.HWND), ("pidlRoot", ctypes.c_void_p), ("pszDisplayName", wintypes.LPWSTR),
                ("lpszTitle", wintypes.LPCWSTR), ("ulFlags", wintypes.UINT), ("lpfn", ctypes.c_void_p),
                ("lParam", wintypes.LPARAM), ("iImage", ctypes.c_int)]


def _owner():
    try:
        return ctypes.windll.user32.GetForegroundWindow()
    except Exception:  # noqa: BLE001
        return None


def _ofn(buf, flags, initial_dir=None, title=None):
    o = OPENFILENAMEW()
    o.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    o.hwndOwner = _owner()
    o.lpstrFilter = "Tutti i file (*.*)\0*.*\0\0"
    o.nFilterIndex = 1
    o.lpstrFile = ctypes.cast(buf, wintypes.LPWSTR)
    o.nMaxFile = _BUF
    o.lpstrInitialDir = initial_dir or None
    o.lpstrTitle = title or None
    o.Flags = flags | OFN_EXPLORER | OFN_NOCHANGEDIR
    return o


def open_files(multiple=True, initial_dir=None, title=None):
    buf = ctypes.create_unicode_buffer(_BUF)
    o = _ofn(buf, OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | (OFN_ALLOWMULTISELECT if multiple else 0), initial_dir, title)
    if not ctypes.windll.comdlg32.GetOpenFileNameW(ctypes.byref(o)):
        return []
    parts = ctypes.wstring_at(ctypes.addressof(buf), _BUF).split("\0")
    parts = parts[:parts.index("")] if "" in parts else parts
    if len(parts) == 1:
        return [parts[0]]
    return [os.path.join(parts[0], n) for n in parts[1:]]  # selezione multipla: cartella, poi i nomi


def save_as(suggested="", directory="", title=None):
    buf = ctypes.create_unicode_buffer(_BUF)
    buf.value = os.path.basename(suggested or "")
    ext = os.path.splitext(suggested or "")[1].lstrip(".")
    o = _ofn(buf, OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST, directory or None, title)
    o.lpstrDefExt = ext or None
    if not ctypes.windll.comdlg32.GetSaveFileNameW(ctypes.byref(o)):
        return None
    return buf.value or None


def choose_folder(title=None):
    BIF_RETURNONLYFSDIRS, BIF_NEWDIALOGSTYLE = 0x0001, 0x0040
    ctypes.windll.ole32.CoInitialize(None)
    name = ctypes.create_unicode_buffer(260)
    bi = BROWSEINFOW()
    bi.hwndOwner = _owner()
    bi.pszDisplayName = ctypes.cast(name, wintypes.LPWSTR)
    bi.lpszTitle = title or None
    bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
    shell32 = ctypes.windll.shell32
    shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
    pidl = shell32.SHBrowseForFolderW(ctypes.byref(bi))
    if not pidl:
        return None
    path = ctypes.create_unicode_buffer(32768)
    ok = shell32.SHGetPathFromIDListW(ctypes.c_void_p(pidl), path)
    ctypes.windll.ole32.CoTaskMemFree(ctypes.c_void_p(pidl))
    return path.value if ok and path.value else None
