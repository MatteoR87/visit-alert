// Disdetta di un appuntamento già prenotato, SOLO su conferma esplicita dell'utente (/disdici o "🗑 Disdici" →
// "🗑 Sì, disdici"). Mai dai giri del cron.
//
// Come il sito (AppuntamentoConfermaAnnullaController → AppuntamentoVisualizzaService.annulla): in una sessione
// con la ricetta si prende l'appuntamento dalla ricetta e si chiama pgpcitt_annulla_appuntamento con
// {codiceFiscale, appuntamenti: [Appuntamento.newForBackend], appuntamentiAnnullati: []}. Dopo una disdetta
// riuscita la ricetta NON si sblocca (il sito mette daSbloccare = false); dopo un rifiuto sì.
//
// Modalità prova (PRENOTAZIONE_REALE diversa da "1"): tutto tranne l'ultima chiamata; nei log la struttura
// mascherata della richiesta.
import { adessoRoma, appuntamentoSemplice, conRicetta, type Appuntamento, type DatiRicetta } from "./controllo.js";
import * as sito from "./modelli-sito.js";
import { ErrorePrenota, type OpzioniSessione } from "./prenota.js";
import { strutturaMascherata } from "./prenotazione.js";

export type EsitoDisdetta =
  | { esito: "disdetto"; appuntamenti: Appuntamento[] }
  | { esito: "prova"; appuntamenti: Appuntamento[]; richiesta: unknown }
  | { esito: "non-trovato" };

export type OpzioniDisdetta = OpzioniSessione & { reale: boolean; ora?: Date };

/** Gli appuntamenti da disdire: quello con la data indicata, attivo e futuro, e quelli associati a lui. */
export function daDisdire(ricetta: any, data: string, adesso: string): any[] {
  const attivi = ((ricetta?.appuntamenti?.singoli ?? []) as any[]).filter(
    (a) => !a?.annullatoIl && typeof a?.data === "string" && a.data >= adesso,
  );
  const scelto = attivi.find((a) => a.data === data);
  if (!scelto) return [];
  return scelto.associazione ? attivi.filter((a) => a.associazione === scelto.associazione) : [scelto];
}

/** La richiesta di pgpcitt_annulla_appuntamento come la costruisce il sito. */
export function richiestaDisdetta(codiceFiscale: string, appuntamenti: any[]) {
  return {
    codiceFiscale: appuntamenti[0]?.cittadino?.codiceFiscale ?? codiceFiscale,
    appuntamenti: appuntamenti.map(sito.appuntamento),
    appuntamentiAnnullati: [],
  };
}

export async function disdiciAppuntamento(dati: DatiRicetta, data: string, opz: OpzioniDisdetta): Promise<EsitoDisdetta> {
  return conRicetta(dati, opz, async (sess) => {
    const grezzi = daDisdire(sess.ricetta, data, adessoRoma(opz.ora));
    if (grezzi.length === 0) return { esito: "non-trovato" };
    // Le richieste in lista d'attesa (MOSA, "differite") il sito le gestisce in un altro modo: qui no.
    if (grezzi.some((a) => a.differita || a.unitaErogante?.codice === "MOSA"))
      throw new Error("questo appuntamento è una richiesta in lista d'attesa: disdicila dal sito");
    const richiesta = richiestaDisdetta(dati.codiceFiscale, grezzi);
    const appuntamenti = grezzi.map(appuntamentoSemplice);
    if (!opz.reale) {
      console.log(JSON.stringify({ prova_disdetta: strutturaMascherata(richiesta) }));
      return { esito: "prova", appuntamenti, richiesta };
    }
    try {
      await sess.s.chiama("pgpcitt_annulla_appuntamento", richiesta);
    } catch (e) {
      if (e instanceof ErrorePrenota) {
        console.error(JSON.stringify({ disdetta_rifiutata: { codice: e.codice, dettaglio: e.dettaglio, richiesta: strutturaMascherata(richiesta) } }));
        throw new Error(`Il sito ha rifiutato la disdetta (${e.codice})`);
      }
      // Senza risposta la disdetta potrebbe essere avvenuta: meglio non sbloccare la ricetta.
      sess.prenotata = true;
      throw new Error(
        `Nessuna risposta dal sito alla disdetta (${(e as Error).message.slice(0, 80)}): controlla su PrenotaSalute se è avvenuta`,
      );
    }
    sess.prenotata = true; // come il sito: dopo la disdetta la ricetta non si sblocca
    return { esito: "disdetto", appuntamenti };
  });
}
