// Posta elettronica (scheda "Posta"): vedi ui/js/mail/mailapp.js
export async function mount(ctx) {
  const m = await import("../mail/mailapp.js");
  return m.mountMail(ctx);
}
