"""Immagini di GIMP (.xcf) senza GIMP: lettore scritto qui dalla descrizione pubblica del formato (devel-docs/xcf.txt di GIMP).
Il file non contiene l'immagine finita: si ricompone dai livelli dal basso verso l'alto (visibilita', opacita', posizione, maschera
del livello), con fusione "normale" per tutti i modi (moltiplica, schermo... sono approssimati: l'avviso lo dice). Gruppi: i figli
si ricompongono direttamente, un gruppo nascosto nasconde i figli. Tasselli 64x64 non compressi, RLE o zlib; precisione 8/16/32 bit
intera o a virgola mobile (portata a 8 bit), RGB, scala di grigi o indicizzata. Versioni da 0 (GIMP 1) a 11+ (indirizzi a 64 bit)."""
import struct
import zlib

import numpy as np

PROP_END, PROP_COLORMAP, PROP_OPACITY, PROP_MODE, PROP_VISIBLE = 0, 1, 6, 7, 8
PROP_APPLY_MASK, PROP_OFFSETS, PROP_COMPRESSION = 11, 15, 17
PROP_GROUP_ITEM, PROP_ITEM_PATH, PROP_FLOAT_OPACITY, PROP_COMPOSITE_MODE = 29, 30, 33, 35
TILE = 64


class XcfError(ValueError):
    pass


class _R:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def u32(self):
        v = struct.unpack_from(">I", self.d, self.p)[0]
        self.p += 4
        return v

    def i32(self):
        v = struct.unpack_from(">i", self.d, self.p)[0]
        self.p += 4
        return v

    def ptr(self, wide):
        if wide:
            v = struct.unpack_from(">Q", self.d, self.p)[0]
            self.p += 8
            return v
        return self.u32()

    def string(self):
        n = self.u32()
        s = self.d[self.p:self.p + n]
        self.p += n
        return s.rstrip(b"\x00").decode("utf-8", "replace")

    def props(self):
        out = {}
        while True:
            t = self.u32()
            n = self.u32()
            body = self.d[self.p:self.p + n]
            self.p += n
            if t == PROP_END:
                return out
            out[t] = body


# precisione (dalla versione 4): codice -> (byte per canale, tipo numpy, gamma)
PRECISION = {
    100: (1, ">u1"), 150: (1, ">u1"), 200: (2, ">u2"), 250: (2, ">u2"), 300: (4, ">u4"), 350: (4, ">u4"),
    500: (2, ">f2"), 550: (2, ">f2"), 600: (4, ">f4"), 650: (4, ">f4"), 700: (8, ">f8"), 750: (8, ">f8"),
}
OLD_PRECISION = {0: 150, 1: 350, 2: 550, 3: 650, 4: 150, 5: 250, 6: 350, 7: 550, 8: 650}  # versioni 4-6


def _rle_fast(data, pos, n_px, bpp):
    """Tassello RLE: un canale (byte) alla volta, ognuno n_px valori; restituisce (pixel interleaved, nuova posizione)."""
    planes = []
    for _ch in range(bpp):
        buf = np.empty(n_px, np.uint8)
        i = 0
        while i < n_px:
            op = data[pos]
            pos += 1
            if op >= 128:
                if op == 128:
                    cnt = (data[pos] << 8) | data[pos + 1]
                    pos += 2
                else:
                    cnt = 256 - op
                cnt = min(cnt, n_px - i)
                buf[i:i + cnt] = np.frombuffer(data, np.uint8, cnt, pos)
                pos += cnt
            else:
                if op == 127:
                    cnt = (data[pos] << 8) | data[pos + 1]
                    pos += 2
                else:
                    cnt = op + 1
                cnt = min(cnt, n_px - i)
                buf[i:i + cnt] = data[pos]
                pos += 1
            i += cnt
        planes.append(buf)
    return np.stack(planes, axis=1).tobytes(), pos


class Xcf:
    def __init__(self, data: bytes):
        if not data.startswith(b"gimp xcf "):
            raise XcfError("not-xcf")
        tag = data[9:13]
        self.version = 0 if tag == b"file" else int(tag[1:].decode("ascii"))
        r = _R(data)
        r.p = 14
        self.w, self.h, self.base = r.u32(), r.u32(), r.u32()
        self.wide = self.version >= 11
        prec = 150
        if self.version >= 4:
            p = r.u32()
            prec = OLD_PRECISION.get(p, 150) if self.version < 7 else p
        if prec not in PRECISION:
            raise XcfError("precision")
        self.prec = prec
        self.chan_bytes, self.dtype = PRECISION[prec]
        self.props = r.props()
        self.compression = self.props.get(PROP_COMPRESSION, b"\x00")[0] if PROP_COMPRESSION in self.props else 0
        if self.compression not in (0, 1, 2):
            raise XcfError("compression")
        cm = self.props.get(PROP_COLORMAP)
        self.colormap = None
        if cm:
            n = struct.unpack_from(">I", cm)[0]
            self.colormap = np.frombuffer(cm, np.uint8, n * 3, 4).reshape(n, 3)
        self.layers = []
        while True:
            p = r.ptr(self.wide)
            if not p:
                break
            self.layers.append(p)
        self.d = data
        self.r = r

    # ------------------------------------------------------------------ pixel
    def _to8(self, arr, color=True):
        if self.dtype == ">u1" and (self.prec % 100 or not color):
            return arr.astype(np.uint8)
        a = arr.astype(np.float64)
        if self.dtype.startswith(">u"):
            a = a / (2 ** (8 * self.chan_bytes) - 1)
        a = np.nan_to_num(a)
        if color and self.prec % 100 == 0:  # luce lineare: si porta in sRGB per vederla come in GIMP
            a = np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(np.clip(a, 0, None), 1 / 2.4) - 0.055)
        return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)

    def _hierarchy(self, ptr):
        r = _R(self.d)
        r.p = ptr
        r.u32()
        r.u32()
        bpp = r.u32()
        level = r.ptr(self.wide)
        r.p = level
        lw, lh = r.u32(), r.u32()
        tiles = []
        while True:
            t = r.ptr(self.wide)
            if not t:
                break
            tiles.append(t)
        nch = bpp // self.chan_bytes
        img = np.zeros((lh, lw, nch), np.float64 if self.dtype[1] == "f" else np.uint32) if self.chan_bytes > 1 else np.zeros((lh, lw, nch), np.uint8)
        cols = (lw + TILE - 1) // TILE
        for k, tp in enumerate(tiles):
            ty, tx = divmod(k, cols)
            x0, y0 = tx * TILE, ty * TILE
            tw, th = min(TILE, lw - x0), min(TILE, lh - y0)
            if tw <= 0 or th <= 0:
                continue
            n = tw * th
            end = tiles[k + 1] if k + 1 < len(tiles) else None
            if self.compression == 0:
                raw = self.d[tp:tp + n * bpp]
            elif self.compression == 1:
                raw, _ = _rle_fast(self.d, tp, n, bpp)
            else:
                raw = zlib.decompressobj().decompress(self.d[tp:end] if end and end > tp else self.d[tp:tp + n * bpp * 2 + 1024])
            if len(raw) < n * bpp:
                raw = raw + b"\x00" * (n * bpp - len(raw))
            px = np.frombuffer(raw[:n * bpp], self.dtype).reshape(th, tw, nch)
            img[y0:y0 + th, x0:x0 + tw] = px
        return img

    def _rgba(self, px):
        """pixel del livello -> RGBA 8 bit"""
        nch = px.shape[2]
        if self.base == 2 and self.colormap is not None:  # indicizzata: indice (+ alfa)
            idx = px[..., 0].astype(np.int64).clip(0, len(self.colormap) - 1)
            rgb = self.colormap[idx]
            a = px[..., 1].astype(np.uint8) if nch > 1 else np.full(idx.shape, 255, np.uint8)
            return np.dstack([rgb, a])
        nc = 1 if self.base == 1 else 3
        p8 = self._to8(px[..., :nc])
        a = self._to8(px[..., nc], color=False) if nch > nc else np.full(px.shape[:2], 255, np.uint8)
        if self.base == 1:  # scala di grigi
            p8 = np.repeat(p8, 3, axis=2)
        return np.dstack([p8, a])

    def _layer(self, ptr):
        r = _R(self.d)
        r.p = ptr
        w, h = r.u32(), r.u32()
        r.u32()  # tipo del livello: lo decide il tipo dell immagine
        name = r.string()
        props = r.props()
        hier = r.ptr(self.wide)
        mask = r.ptr(self.wide)
        L = {"w": w, "h": h, "name": name, "hier": hier, "mask": mask,
             "visible": struct.unpack(">I", props[PROP_VISIBLE])[0] if PROP_VISIBLE in props else 1,
             "opacity": (struct.unpack(">f", props[PROP_FLOAT_OPACITY])[0] if PROP_FLOAT_OPACITY in props
                         else struct.unpack(">I", props[PROP_OPACITY])[0] / 255 if PROP_OPACITY in props else 1.0),
             "offset": struct.unpack(">ii", props[PROP_OFFSETS]) if PROP_OFFSETS in props else (0, 0),
             "mode": struct.unpack(">I", props[PROP_MODE][:4])[0] if PROP_MODE in props else 0,
             "apply_mask": struct.unpack(">I", props[PROP_APPLY_MASK])[0] if PROP_APPLY_MASK in props else 0,
             "group": PROP_GROUP_ITEM in props,
             "path": list(struct.unpack(f">{len(props[PROP_ITEM_PATH]) // 4}I", props[PROP_ITEM_PATH])) if PROP_ITEM_PATH in props else []}
        return L

    def _mask(self, ptr):
        r = _R(self.d)
        r.p = ptr
        r.u32()
        r.u32()
        r.string()
        r.props()
        hier = r.ptr(self.wide)
        m = self._hierarchy(hier)
        return self._to8(m[..., :1], color=False)[..., 0]

    # ------------------------------------------------------------------ composizione
    def composite(self):
        layers = [self._layer(p) for p in self.layers]
        # gruppi: il percorso di un figlio e' [indice del gruppo al livello 0, ...]; gruppi nascosti = figli nascosti
        hidden_paths = []
        for L in layers:
            if L["group"] and not L["visible"]:
                hidden_paths.append(L["path"])
        out = np.zeros((self.h, self.w, 4), np.float64)
        approx = False
        for L in reversed(layers):  # dal basso
            if L["group"] or not L["visible"]:
                continue
            if any(L["path"][:len(hp)] == hp and len(L["path"]) > len(hp) for hp in hidden_paths if hp):
                continue
            if L["mode"] not in (0, 28) and L["mode"] != 3:  # normale (vecchio 0, nuovo 28); 3 = dissolvi
                approx = True
            px = self._rgba(self._hierarchy(L["hier"])).astype(np.float64) / 255
            a = px[..., 3] * L["opacity"]
            if L["mask"] and L["apply_mask"]:
                try:
                    a = a * (self._mask(L["mask"]).astype(np.float64) / 255)
                except Exception:  # noqa: BLE001 - maschera illeggibile: il livello resta intero
                    pass
            ox, oy = L["offset"]
            x0, y0 = max(0, ox), max(0, oy)
            x1, y1 = min(self.w, ox + px.shape[1]), min(self.h, oy + px.shape[0])
            if x1 <= x0 or y1 <= y0:
                continue
            sx, sy = x0 - ox, y0 - oy
            src = px[sy:sy + y1 - y0, sx:sx + x1 - x0, :3]
            sa = a[sy:sy + y1 - y0, sx:sx + x1 - x0, None]
            dst = out[y0:y1, x0:x1]
            da = dst[..., 3:4]
            oa = sa + da * (1 - sa)
            rgb = np.where(oa > 0, (src * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(oa, 1e-12), 0)
            out[y0:y1, x0:x1, :3] = rgb
            out[y0:y1, x0:x1, 3:4] = oa
        return (out * 255 + 0.5).clip(0, 255).astype(np.uint8), {"livelli": len(layers), "approssimato": approx, "versione": self.version}


def to_image(path: str):
    """(immagine Pillow RGBA, informazioni)"""
    from PIL import Image
    with open(path, "rb") as f:
        data = f.read()
    x = Xcf(data)
    arr, info = x.composite()
    return Image.fromarray(arr, "RGBA"), info
