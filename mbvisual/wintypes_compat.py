"""ctypes.wintypes anche fuori da Windows: le strutture delle API di Windows (stampa, firma, finestre di dialogo) si
definiscono comunque, cosi' i moduli si importano su Mac e Linux; le funzioni che le usano restano solo per Windows."""
import ctypes
import sys

if sys.platform == "win32":
    from ctypes import wintypes
else:
    import types
    wintypes = types.SimpleNamespace(
        BOOL=ctypes.c_long, BYTE=ctypes.c_ubyte, WORD=ctypes.c_ushort, DWORD=ctypes.c_uint32, UINT=ctypes.c_uint,
        LONG=ctypes.c_int32, HANDLE=ctypes.c_void_p, HWND=ctypes.c_void_p, HDC=ctypes.c_void_p, HINSTANCE=ctypes.c_void_p,
        LPARAM=ctypes.c_ssize_t, WPARAM=ctypes.c_size_t, LPCWSTR=ctypes.c_wchar_p, LPWSTR=ctypes.c_wchar_p)
