// Prova di raggiungibilità del sito, senza dati personali: sala d'attesa, token, parametri e un servizio
// pubblico (elenco delle ATS). Usata da /api/test-prenota e da `npm run prova`.
import { ErrorePrenota, InCoda, SessionePrenota, type OpzioniSessione } from "./prenota.js";

export type EsitoDiagnosi = {
  ok: boolean;
  fase: "apertura" | "parametri" | "servizio" | "fatto";
  inCoda: boolean;
  percorso: { host: string; stato: number }[];
  cookie: string[];
  versioneSito?: string;
  ats?: number;
  errore?: string;
  ms: number;
};

export async function diagnosi(opzioni: OpzioniSessione = {}): Promise<EsitoDiagnosi> {
  const inizio = Date.now();
  const s = new SessionePrenota(opzioni);
  let fase: EsitoDiagnosi["fase"] = "apertura";
  const esito = (extra: Partial<EsitoDiagnosi>): EsitoDiagnosi => ({
    ok: false,
    fase,
    inCoda: false,
    percorso: s.percorso,
    cookie: s.cookies.nomi(),
    ms: Date.now() - inizio,
    ...extra,
  });
  try {
    await s.apri();
    fase = "parametri";
    const p = await s.parametri();
    fase = "servizio";
    const ats = await s.chiama<unknown[]>("pgpcitt_ricerca_ats", {});
    fase = "fatto";
    return esito({ ok: true, versioneSito: p["release.version"], ats: Array.isArray(ats) ? ats.length : 0 });
  } catch (e) {
    if (e instanceof InCoda) return esito({ inCoda: true, errore: e.message });
    if (e instanceof ErrorePrenota) return esito({ errore: e.message });
    return esito({ errore: (e as Error).message.slice(0, 300) });
  }
}
