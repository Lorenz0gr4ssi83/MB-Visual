// Worker OpenCascade che resta acceso: il motore WebAssembly si carica una volta sola e legge un file dopo l'altro
// (il worker di occt-import-js lo ricarica a ogni file: con un assieme di centinaia di parti sarebbe molto lento).
importScripts("/vendor/occt/dist/occt-import-js.js");
let occt = null;
onmessage = async ev => {
  const { id, format, buffer, params } = ev.data;
  try {
    if (!occt) occt = await occtimportjs({ locateFile: p => "/vendor/occt/dist/" + p });
    postMessage({ id, result: occt.ReadFile(format, buffer, params) });
  } catch (e) {
    postMessage({ id, error: String(e && e.message || e) });
  }
};
