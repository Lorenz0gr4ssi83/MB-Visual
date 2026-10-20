// Archivi (7-Zip): contenuto ad albero, apertura diretta dei file interni, estrazione, aggiunta/eliminazione/rinomina.
import { api, askText, button, confirmBox, el, fmtSize, loading, modal, pickFiles, pickFolder, toast } from "../core.js";

export async function mount(ctx) {
  let password = null;
  let data;
  const list = el("div", { style: { overflow: "auto", height: "100%" } });
  ctx.fillBody(true);

  async function load() {
    loading(ctx.el, "Lettura dell'archivio");
    data = await api("archive_list", password ? { path: ctx.path, password } : { path: ctx.path }, { allowFail: true });
    if (!data.ok) throw new Error(data.errore);
    if (data.items.some(i => i.encrypted) && !password) {
      const p = await askText("Archivio protetto", "Password dell'archivio", "");
      if (p) { password = p; }
    }
    ctx.el.innerHTML = "";
    ctx.el.append(list);
    render();
  }

  let filter = "", selected = new Set(), cwd = "";
  function render() {
    list.innerHTML = "";
    const items = data.items.filter(i => i.path);
    // cartelle implicite
    const dirs = new Set();
    for (const i of items) { const parts = i.path.split("/"); for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join("/")); if (i.dir) dirs.add(i.path); }
    const inCwd = p => (cwd ? p.startsWith(cwd + "/") : true) && !p.slice(cwd ? cwd.length + 1 : 0).includes("/");
    const rows = [];
    if (!filter) {
      for (const d of [...dirs].filter(inCwd).sort()) rows.push({ path: d, dir: true, size: 0, modified: "" });
      for (const i of items.filter(i => !i.dir && inCwd(i.path))) rows.push(i);
    } else {
      for (const i of items.filter(i => !i.dir && i.path.toLowerCase().includes(filter))) rows.push(i);
    }
    const crumbs = el("div", { style: { padding: "8px 12px", display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
      el("button", { class: "link", onclick: () => { cwd = ""; render(); } }, ctx.name));
    let acc = "";
    for (const part of cwd ? cwd.split("/") : []) { acc = acc ? acc + "/" + part : part; const target = acc; crumbs.append(" / ", el("button", { class: "link", onclick: () => { cwd = target; render(); } }, part)); }
    const t = el("table", { class: "grid", style: { width: "100%" } },
      el("thead", {}, el("tr", {}, el("th", { style: { width: "28px" } }, ""), el("th", {}, "Nome"), el("th", {}, "Dimensione"), el("th", {}, "Compresso"), el("th", {}, "Modificato"))));
    const tb = el("tbody");
    for (const r of rows) {
      const name = filter ? r.path : r.path.split("/").pop();
      const cb = el("input", { type: "checkbox", checked: selected.has(r.path) });
      cb.addEventListener("change", () => { cb.checked ? selected.add(r.path) : selected.delete(r.path); });
      const tr = el("tr", { style: { cursor: "pointer" } }, el("td", {}, cb), el("td", {}, (r.dir ? "📁 " : "") + name + (r.encrypted ? " 🔒" : "")),
        el("td", { style: { textAlign: "right" } }, r.dir ? "" : fmtSize(r.size)), el("td", { style: { textAlign: "right" } }, r.dir ? "" : fmtSize(r.packed)), el("td", {}, r.modified || ""));
      tr.addEventListener("dblclick", () => (r.dir ? ((cwd = r.path), render()) : openEntry(r.path)));
      tb.append(tr);
    }
    t.append(tb);
    list.append(crumbs, t);
    const files = items.filter(i => !i.dir);
    ctx.status(`${files.length} file · ${fmtSize(files.reduce((s, i) => s + i.size, 0))} non compressi` + (data.type ? " · formato " + data.type : ""));
  }

  async function openEntry(entry) {
    toast("Estrazione di " + entry.split("/").pop() + "...");
    const r = await api("archive_extract", { path: ctx.path }, { json: { entry, password } });
    ctx.openFile(r.path);
  }

  const search = el("input", { type: "search", placeholder: "Cerca nell'archivio", id: "arc-q-" + ctx.tab.name, style: { width: "200px" } });
  search.addEventListener("input", () => { filter = search.value.trim().toLowerCase(); render(); });
  const editable = () => data?.editable;
  async function add(paths) {
    if (!editable()) return toast("Questo tipo di archivio e' in sola lettura: si possono solo estrarre i file.", true);
    await api("archive_add", { path: ctx.path }, { json: { files: paths, folder: cwd } });
    toast(`${paths.length} elemento/i aggiunti all'archivio`);
    await load();
  }
  ctx.tb.append(search, el("span", { class: "sep" }),
    button("Apri", "open", () => { const f = [...selected].find(p => !data.items.find(i => i.path === p)?.dir); if (f) openEntry(f); else toast("Seleziona un file (o fai doppio clic)"); }),
    button("Estrai selezionati", "download", async () => {
      const dest = await pickFolder();
      if (!dest) return;
      const sel = [...selected];
      if (!sel.length) return toast("Seleziona almeno un elemento", true);
      for (const e of sel) await api("archive_extract", { path: ctx.path }, { json: { entry: e, dest, password } });
      toast("Estratti in " + dest);
    }),
    button("Estrai tutto", "download", async () => {
      const dest = await pickFolder();
      if (!dest) return;
      await api("archive_extract", { path: ctx.path }, { json: { dest, password } });
      toast("Archivio estratto in " + dest);
    }),
    el("span", { class: "sep" }),
    button("Aggiungi file", "plus", async () => { const ps = await pickFiles(); if (ps?.length) add(ps); }),
    button("Rinomina", "edit", async () => {
      const [one] = [...selected];
      if (!one || selected.size !== 1) return toast("Seleziona un solo elemento", true);
      const nn = await askText("Rinomina", "Nuovo nome", one.split("/").pop());
      if (!nn) return;
      await api("archive_rename", { path: ctx.path }, { json: { old: one, new: one.replace(/[^/]*$/, nn) } });
      selected.clear(); await load();
    }),
    button("Elimina", "trash", async () => {
      if (!selected.size) return toast("Seleziona gli elementi da eliminare", true);
      if (!(await confirmBox("Elimina dall'archivio", `Eliminare ${selected.size} elemento/i dall'archivio? L'operazione modifica il file.`, "Elimina", true))) return;
      await api("archive_delete", { path: ctx.path }, { json: { entries: [...selected] } });
      selected.clear(); await load();
    }),
    el("span", { class: "grow" }), el("span", { class: "note" }, "Doppio clic per aprire · trascina file qui per aggiungerli"));
  await load();

  return {
    onBack() { // indietro: prima si risale di una cartella dentro l'archivio
      if (!cwd) return false;
      cwd = cwd.includes("/") ? cwd.slice(0, cwd.lastIndexOf("/")) : "";
      render();
      return true;
    },
    async acceptDrop(paths) {
      if (!editable()) return false;
      const choice = await modal("File trascinati", `<p>Aggiungere ${paths.length} elemento/i all'archivio <b>${ctx.name}</b>${cwd ? " nella cartella " + cwd : ""}, oppure aprirli?</p>`,
        [{ label: "Aprili", value: "open" }, { label: "Aggiungi all'archivio", value: "add", primary: true }]);
      if (choice === "add") { await add(paths); return true; }
      return false;
    },
  };
}
