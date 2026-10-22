// Nuovo messaggio / risposta / inoltro: vedi ui/js/mail/compose.js
export async function mount(ctx) {
  const m = await import("../mail/compose.js");
  return m.mountCompose(ctx);
}
