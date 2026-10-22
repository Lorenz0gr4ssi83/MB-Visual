// Word: vista fedele (docx-preview) e modifica con editor formattato; salvataggio in DOCX.
import { api, button, el, loadScript, readBytes, withExt } from "../core.js";
import { t } from "../i18n.js";



export async function mount(ctx) {
  await loadScript("/vendor/jszip/dist/jszip.min.js");
  await Promise.all([loadScript("/vendor/docx-preview/dist/docx-preview.min.js"), loadScript("/vendor/mammoth/mammoth.browser.min.js")]);
  const bytes = await readBytes(ctx.path);
  const wrap = el("div", { class: "doc-wrap" });
  ctx.el.append(wrap);
  let mode = "view", editor = null;
  // schermo piu' stretto della pagina (telefono): la pagina si riduce alla larghezza disponibile invece di uscire dai lati
  function fitWidth(host) {
    host.style.zoom = "";
    const page = Math.max(0, ...[...host.querySelectorAll("section.docx")].map(s => s.offsetWidth));
    const avail = wrap.clientWidth - 16;
    if (page && avail > 0 && page + 60 > avail) host.style.zoom = String(Math.max(0.3, avail / (page + 20)));
  }
  new ResizeObserver(() => { if (mode === "view" && wrap.firstChild) fitWidth(wrap.firstChild); }).observe(wrap);

  async function showView() {
    mode = "view";
    wrap.innerHTML = "";
    const host = el("div");
    wrap.append(host);
    await window.docx.renderAsync(bytes.buffer.slice(0), host, null, { inWrapper: true, ignoreLastRenderedPageBreak: false, experimental: true, renderHeaders: true, renderFooters: true, renderFootnotes: true });
    fitWidth(host);
    viewBtn.classList.add("on");
    editBtn.classList.remove("on");
    fmt.hidden = true;
  }

  async function showEdit() {
    mode = "edit";
    const res = await window.mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(0) }, {
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Titolo'] => h1:fresh"],
    });
    wrap.innerHTML = "";
    editor = el("div", { class: "editable-doc", contenteditable: "true", spellcheck: "true", html: res.value });
    editor.addEventListener("input", () => ctx.setDirty(true));
    wrap.append(editor);
    editBtn.classList.add("on");
    viewBtn.classList.remove("on");
    fmt.hidden = false;
    editor.focus();
  }

  const cmd = (c, v) => () => { document.execCommand(c, false, v); editor?.focus(); ctx.setDirty(true); };
  const block = el("select", { title: t("v_docx.stile_paragrafo"), id: "docx-block-" + ctx.tab.name, onchange: e => { cmd("formatBlock", e.target.value)(); e.target.value = ""; } },
    el("option", { value: "" }, t("v_docx.stile")), el("option", { value: "p" }, t("v_docx.normale")), el("option", { value: "h1" }, t("v_docx.titolo_1")),
    el("option", { value: "h2" }, t("v_docx.titolo_2")), el("option", { value: "h3" }, t("v_docx.titolo_3")));
  const fmt = el("span", { style: { display: "contents" } }, el("span", { class: "sep" }), block,
    button("G", null, cmd("bold"), { title: t("v_docx.grassetto_ctrl_b") }), button("C", null, cmd("italic"), { title: t("v_docx.corsivo_ctrl_i") }),
    button("S", null, cmd("underline"), { title: t("v_docx.sottolineato_ctrl_u") }),
    button(t("v_docx.elenco"), null, cmd("insertUnorderedList")), button(t("v_docx.numerato"), null, cmd("insertOrderedList")),
    button("", "undo", cmd("undo"), { iconOnly: true, title: t("common.annulla_op") }), button("", "redo", cmd("redo"), { iconOnly: true, title: t("common.ripeti") }));
  fmt.hidden = true;
  const viewBtn = button(t("v_docx.vista_originale"), "eye", showView);
  const editBtn = button(t("v_docx.modifica_testo"), "edit", showEdit);
  ctx.tb.append(viewBtn, editBtn, fmt, el("span", { class: "grow" }),
    el("span", { class: "note" }, t("v_docx.modifica_si_mantengono_testi_titoli")));
  await showView();

  return {
    saveInPlace: false,
    saveAsName: () => withExt(ctx.name.replace(/(\.[^.]+)$/, "_modificato$1"), "docx"),
    async save(target) {
      if (mode !== "edit" || !editor) throw new Error(t("v_docx.passa_modifica_testo_modificare_documento"));
      await api("docx_save", { path: target }, { json: { html: editor.innerHTML, title: ctx.name } });
      return { switchTo: false };
    },
  };
}
