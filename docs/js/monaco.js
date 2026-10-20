// Caricamento dell'editor Monaco (lo stesso di VS Code), una sola volta per tutta l'app.
import { loadScript } from "./core.js";

let promise = null;
const BASE = window.MBV_ROOT + "vendor/monaco/min";

export function loadMonaco() {
  if (promise) return promise;
  promise = (async () => {
    const abs = new URL(BASE, location.href).href;
    window.MonacoEnvironment = {
      getWorkerUrl() {
        const code = `self.MonacoEnvironment={baseUrl:'${abs}/'};importScripts('${abs}/vs/base/worker/workerMain.js');`;
        return "data:text/javascript;charset=utf-8," + encodeURIComponent(code);
      },
    };
    await loadScript(BASE + "/vs/loader.js");
    window.require.config({ paths: { vs: BASE + "/vs" }, "vs/nls": { availableLanguages: { "*": "it" } } });
    await new Promise((res, rej) => window.require(["vs/editor/editor.main"], res, rej));
    applyTheme();
    window.addEventListener("mbv-theme", applyTheme);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
    return window.monaco;
  })();
  return promise;
}

export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme() {
  if (window.monaco) window.monaco.editor.setTheme(isDark() ? "vs-dark" : "vs");
}

const EXTRA = { vue: "html", svelte: "html", jsonc: "json", json5: "json", geojson: "json", topojson: "json", ipynb: "json",
  csproj: "xml", vbproj: "xml", vcxproj: "xml", props: "xml", targets: "xml", nuspec: "xml", xaml: "xml", resx: "xml",
  kml: "xml", gpx: "xml", gml: "xml", plist: "xml", svg: "xml", rss: "xml", atom: "xml", xsd: "xml", xsl: "xml", xslt: "xml",
  ino: "cpp", h: "cpp", hh: "cpp", m: "objective-c", mm: "objective-c", gradle: "groovy", kts: "kotlin", mjs: "javascript",
  cjs: "javascript", mts: "typescript", cts: "typescript", psm1: "powershell", psd1: "powershell", cmd: "bat", tf: "hcl",
  tfvars: "hcl", toml: "ini", cfg: "ini", conf: "ini", properties: "ini", env: "ini", reg: "ini", inf: "ini", desktop: "ini",
  service: "ini", gitconfig: "ini", editorconfig: "ini", makefile: "shell", mk: "shell", zsh: "shell", fish: "shell",
  ksh: "shell", csh: "shell", dockerfile: "dockerfile", containerfile: "dockerfile", tex: "latex", latex: "latex",
  rmd: "markdown", mdx: "markdown", f: "fortran", f90: "fortran", sv: "systemverilog", v: "verilog", vhd: "vhdl",
  gcode: "plaintext", nc: "plaintext", diff: "plaintext", patch: "plaintext" };

export function languageFor(monaco, ext) {
  if (EXTRA[ext]) return EXTRA[ext];
  for (const l of monaco.languages.getLanguages()) {
    if ((l.extensions || []).some(e => e.toLowerCase() === "." + ext)) return l.id;
  }
  return "plaintext";
}
