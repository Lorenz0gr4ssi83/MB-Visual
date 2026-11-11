// File che non si puo' aprire: estensione non in elenco o visualizzatore che non riesce. Solo "File non supportato" (ui/js/unsupported.js).
// La vecchia schermata di recupero e' stata tolta il 02/11/2026 su richiesta dell'utente (si ritrova nella cronologia git).
export async function showRecovery(ctx, error) {
  ctx.el.innerHTML = "";
  ctx.tb.innerHTML = "";
  ctx.fillBody?.(false);
  return (await import("../unsupported.js")).mountUnsupported(ctx, String(error?.message || error || ""));
}

export async function mount(ctx) {
  ctx.fillBody?.(false);
  return (await import("../unsupported.js")).mountUnsupported(ctx, "");
}
