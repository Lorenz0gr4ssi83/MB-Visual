// SAMB - casi di carico e verifica delle tensioni ASME B31.3. Puro, senza DOM.
// SUS = peso; OPE = peso + dilatazione; EXP = OPE - SUS (come fanno i programmi di calcolo).
//   Sostenuto (par. 320): SL = sqrt((|Fa/Ap + P Ai/Ap| + Sb)^2 + (2 Mt/Z)^2), Sb = sqrt((Ii Mi)^2 + (Io Mo)^2)/Z, con Ii/Io = 0,75 i (min 1)
//   Dilatazione (par. 319.4.4): SE = sqrt(Sb^2 + 4 St^2), Sb = sqrt((ii Mi)^2 + (io Mo)^2)/Z, St = Mt/(2Z)
//   Ammissibili: SL <= Sh; SE <= SA = f (1,25 Sc + 0,25 Sh)
// Le formule vanno riscontrate sul testo della norma in uso: gli ammissibili li inserisce l'utente, non sono nel programma.
import { prepare, solveCase, subtract } from "./sambsolve.js";

function ends(f) { // azioni interne alle due estremita' in assi locali: Mi attorno a z (nel piano della curva), Mo attorno a y
  return [{ Fa: -f[0], Mt: -f[3], Mo: -f[4], Mi: -f[5] }, { Fa: f[6], Mt: f[9], Mo: f[10], Mi: f[11] }];
}

export function checkB313(model, sus, exp) {
  const { Sc, Sh, f } = model.opts;
  const SA = Sc && Sh ? f * (1.25 * Sc + 0.25 * Sh) : null;
  const rows = [];
  model.elems.forEach((e, k) => {
    const s = e.sec, fs = ends(sus.forces[k]), fe = ends(exp.forces[k]), Ii = Math.max(1, 0.75 * e.ii), Io = Math.max(1, 0.75 * e.io);
    for (const end of [0, 1]) {
      const a = fs[end], b = fe[end];
      const SbL = Math.hypot(Ii * a.Mi, Io * a.Mo) / s.Z, Sax = Math.abs(a.Fa / s.A + e.P * s.Ai / s.A);
      const SL = Math.hypot(Sax + SbL, 2 * a.Mt / s.Z);
      const SE = Math.hypot(Math.hypot(e.ii * b.Mi, e.io * b.Mo) / s.Z, b.Mt / s.Z);
      rows.push({ elem: k, end, node: end ? e.j : e.i, kind: e.kind, source: e.source, SL, SE, rSL: Sh ? SL / Sh : null, rSE: SA ? SE / SA : null });
    }
  });
  const top = key => rows.reduce((m, r) => (r[key] > (m?.[key] ?? -1) ? r : m), null);
  return { rows, SA, Sh, maxSL: top("SL"), maxSE: top("SE") };
}

export function analyze(model) {
  const S = prepare(model);
  const sus = solveCase(S, { weight: true, thermal: false }), ope = solveCase(S, { weight: true, thermal: true }), exp = subtract(ope, sus);
  return { cases: { SUS: sus, OPE: ope, EXP: exp }, code: checkB313(model, sus, exp) };
}
