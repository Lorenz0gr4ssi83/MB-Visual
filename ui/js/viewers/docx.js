// Word: vista fedele (docx-preview) e modifica con editor formattato; salvataggio in DOCX.
import { api, button, el, loadScript, readBytes, withExt } from "../core.js";



export async function mount(ctx) {
  await loadScript("/vendor/jszip/dist/jszip.min.js");
  await Promise.all([loadScript("/vendor/docx-preview/dist/docx-preview.min.js"), loadScript("/vendor/mammoth/mammoth.browser.min.js")]);
  const bytes = await readBytes(ctx.path);
  const wrap = el("div", { class: "doc-wrap" });
  ctx.el.append(wrap);
  let mode = "view", editor = null;

  async function showView() {
    mode = "view";
    wrap.innerHTML = "";
    const host = el("div");
    wrap.append(host);
    await window.docx.renderAsync(bytes.buffer.slice(0), host, null, { inWrapper: true, ignoreLastRenderedPageBreak: false, experimental: true, renderHeaders: true, renderFooters: true, renderFootnotes: true });
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
  const block = el("select", { title: "Stile paragrafo", id: "docx-block-" + ctx.tab.name, onchange: e => { cmd("formatBlock", e.target.value)(); e.target.value = ""; } },
    el("option", { value: "" }, "Stile..."), el("option", { value: "p" }, "Normale"), el("option", { value: "h1" }, "Titolo 1"),
    el("option", { value: "h2" }, "Titolo 2"), el("option", { value: "h3" }, "Titolo 3"));
  const fmt = el("span", { style: { display: "contents" } }, el("span", { class: "sep" }), block,
    button("G", null, cmd("bold"), { title: "Grassetto (Ctrl+B)" }), button("C", null, cmd("italic"), { title: "Corsivo (Ctrl+I)" }),
    button("S", null, cmd("underline"), { title: "Sottolineato (Ctrl+U)" }),
    button("Elenco", null, cmd("insertUnorderedList")), button("Numerato", null, cmd("insertOrderedList")),
    button("", "undo", cmd("undo"), { iconOnly: true, title: "Annulla" }), button("", "redo", cmd("redo"), { iconOnly: true, title: "Ripeti" }));
  fmt.hidden = true;
  const viewBtn = button("Vista originale", "eye", showView);
  const editBtn = button("Modifica testo", "edit", showEdit);
  ctx.tb.append(viewBtn, editBtn, fmt, el("span", { class: "grow" }),
    el("span", { class: "note" }, "In modifica si mantengono testi, titoli, grassetti, elenchi, tabelle e immagini; impaginazioni complesse vengono semplificate."));
  await showView();

  return {
    saveInPlace: false,
    saveAsName: () => withExt(ctx.name.replace(/(\.[^.]+)$/, "_modificato$1"), "docx"),
    async save(target) {
      if (mode !== "edit" || !editor) throw new Error("Passa a \"Modifica testo\" per modificare il documento prima di salvarlo.");
      await api("docx_save", { path: target }, { json: { html: editor.innerHTML, title: ctx.name } });
      return { switchTo: false };
    },
  };
}
