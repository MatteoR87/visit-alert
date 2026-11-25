// Prenotazione di una data trovata, SOLO su conferma esplicita dell'utente (pulsanti "📅" → "✅ Prenota").
//
// Come il sito (VerificaPrenotazione → DisponibilitaService.conferma): in un'unica sessione si rifà la ricerca, si
// ritrova la stessa data (deve essere ancora libera: il codice "richiesta" vale per quella ricerca) e si chiama
// pgpcitt_conferma_disponibilita con un ConfermaDisponibilita. Se la ricetta è già prenotata, il sito annulla da
// solo l'appuntamento precedente ("confermando una nuova prenotazione, l'appuntamento precedente verrà
// automaticamente annullato"). Dopo una prenotazione riuscita la ricetta NON si sblocca (il sito mette
// daSbloccare = false).
//
// Modalità prova (PRENOTAZIONE_REALE diversa da "1"): tutto tranne l'ultima chiamata; nei log va la struttura della
// richiesta con i valori mascherati, per controllarla prima del primo uso reale.
import {
  appuntamentoSemplice,
  conRicetta,
  criteriDisponibilita,
  oggiRoma,
  recapiti,
  ricettaPerDisponibilita,
  type Appuntamento,
  type DatiRicetta,
  type Tipo,
  type Zona,
} from "./controllo.js";
import { ErrorePrenota, type OpzioniSessione } from "./prenota.js";

/** La data da prenotare: giorno e ora (AAAAMMGGhhmmss) e presidio; l'agenda, se c'è, decide tra omonime. */
export type Bersaglio = { data: string; presidio: string; agenda?: string | null };

export type EsitoPrenotazione =
  | { esito: "prenotato"; appuntamenti: Appuntamento[]; codici: string[]; importo: string | null; trattenuta: boolean }
  | { esito: "prova"; appuntamento: Appuntamento; richiesta: unknown; trattenuta: boolean }
  | { esito: "non-disponibile" };

/**
 * La disponibilità grezza della data, dall'ultima ricerca che l'ha trovata. Se la ricerca nuova non la vede (la
 * ricerca di prima la trattiene ancora) e non è più vecchia di DURATA_PROPOSTA_MS, si conferma con questa.
 */
export type Riserva = { singola: any; quando: string };
export const DURATA_PROPOSTA_MS = 20 * 60_000;

export type OpzioniPrenotazione = OpzioniSessione & { reale: boolean; ora?: Date; riserva?: Riserva | null };

/** I campi del modello Appuntamento del sito (gpmodel), nell'ordine del sito. */
const CAMPI_APPUNTAMENTO = [
  "uuid", "idAppuntamento", "iup", "iurp", "modulo", "associazione", "ipCup", "cup", "data", "cittadino",
  "prenotatoIl", "registratoIl", "modificatoIl", "annullatoIl", "noteAnnullamento", "stato", "tipo",
  "prestazione", "azienda", "unitaErogante", "unitaErogatrice", "agenda", "infoNote", "infoNotePreparazione",
  "infoLuogoPresentazione", "infoMemorandum", "infoNoteDisdettaPrenotazione", "infoConsensoInformato",
  "infoMezzi", "cicli", "quesitoDiagnostico", "differita", "ricetta", "regimeErogazione", "risorsa",
  "tariffaLp", "importo",
] as const;

/** Ricetta.newFromAppuntamento del sito: una Ricetta vuota con iup, iurp e modulo {id, tipo}. */
function ricettaDaAppuntamento(a: any) {
  return {
    iup: a?.iup ?? null, iurp: a?.iurp ?? null, cittadino: null, emessaIl: null, scadenzaIl: null, tipo: null,
    modulo: { id: a?.modulo ?? null, tipo: null }, flagRe: null, priorita: null, urgenza: null,
    tipoPrestazione: null, stato: null, quesitoDiagnostico: null, note: null, esenzione: null,
    flagEsenzionePatologia: null, flagAltreEsenzioni: null, flagSuggerita: null, brancaSpecialistica: null,
    provenienzaPrescrizione: null, prescrittore: null, nrPrestazioni: null, prestazioni: [],
    prestazioniPrenotate: [], datiRispostaMEF: null, appuntamenti: null, appuntamentiUnificati: [],
    daSbloccare: false,
  };
}

/**
 * L'appuntamento della disponibilità come lo manda il sito (Appuntamento.newFrom): solo i campi del modello
 * (gli assenti a null), le date restano stringhe, `cicli` è una lista e `ricetta` è una Ricetta vuota con i codici.
 */
function appuntamentoPerConferma(a: any) {
  const fuori: Record<string, unknown> = {};
  for (const k of CAMPI_APPUNTAMENTO) fuori[k] = a?.[k] ?? null;
  fuori.cicli = Array.isArray(a?.cicli) ? a.cicli : [];
  fuori.ricetta = ricettaDaAppuntamento(a);
  return fuori;
}

/** Il ConfermaDisponibilita del sito, per una disponibilità singola. */
export function richiestaConferma(p: {
  codiceFiscale: string;
  zona: Zona;
  ricetta: any;
  tipo: Tipo;
  recapiti: { telefono: string | null; email: string | null };
  singola: any;
}) {
  return {
    codiceFiscale: p.codiceFiscale,
    disponibilita: [
      {
        selezionabile: true,
        appuntamento: appuntamentoPerConferma(p.singola.appuntamento),
        prestazioni: null,
        richiesta: p.singola.richiesta ?? null,
        primaDataProposta: p.singola.primaDataProposta ?? null,
      },
    ],
    // Il sito qui mette solo gli appuntamenti "differiti" da annullare (non gestiti online da questo servizio).
    appuntamenti: [],
    zona: p.zona,
    ricetta: { ...ricettaPerDisponibilita(p.ricetta), appuntamenti: null, appuntamentiUnificati: null },
    tipoPrestazione: p.tipo,
    recapiti: { telefono: p.recapiti.telefono, cellulare: null, email: p.recapiti.email },
  };
}

/** Le chiavi i cui valori si possono stampare nei log della prova (codici e date, niente dati personali). */
const VISIBILI = new Set([
  "data",
  "primaDataProposta",
  "emessaIl",
  "scadenzaIl",
  "tipoPrestazione",
  "regimeErogazione",
  "selezionabile",
  "stato",
  "tipo",
  "flagRe",
  "priorita",
  "urgenza",
  "codiceProvincia",
  "codiceComune",
]);

/** La struttura di un oggetto con i valori mascherati: stringhe come <s:lunghezza>, salvo le chiavi VISIBILI. */
export function strutturaMascherata(v: unknown, chiave = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => strutturaMascherata(x));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strutturaMascherata(x, k)]));
  if (typeof v === "string") return VISIBILI.has(chiave) ? v : `<s:${v.length}>`;
  return v;
}

function corrisponde(a: any, b: Bersaglio) {
  return a?.data === b.data && String(a?.unitaErogante?.presidio?.codice ?? "") === b.presidio;
}

/**
 * Ritrova la data nelle zone (nell'ordine dato, fermandosi alla prima che la contiene) e, se è ancora libera, la
 * prenota (o in prova prepara soltanto la richiesta).
 */
export async function prenotaData(
  dati: DatiRicetta,
  tipo: Tipo,
  zone: Zona[],
  bersaglio: Bersaglio,
  opz: OpzioniPrenotazione,
): Promise<EsitoPrenotazione> {
  return conRicetta(dati, opz, async (sess) => {
    const { s, login, ricetta } = sess;
    const regime =
      (ricetta?.appuntamenti?.singoli ?? []).find((x: any) => !x.annullatoIl)?.regimeErogazione ?? null;

    /** Prova o conferma di una disponibilità singola. */
    const concludi = async (zona: Zona, singola: any, trattenuta: boolean): Promise<EsitoPrenotazione> => {
      const richiesta = richiestaConferma({
        codiceFiscale: dati.codiceFiscale,
        zona,
        ricetta,
        tipo,
        recapiti: recapiti(login),
        singola,
      });
      if (!opz.reale) {
        console.log(JSON.stringify({ prova_prenotazione: strutturaMascherata(richiesta), trattenuta }));
        return { esito: "prova", appuntamento: appuntamentoSemplice(singola.appuntamento), richiesta, trattenuta };
      }
      let esito: any;
      try {
        esito = await s.chiama("pgpcitt_conferma_disponibilita", richiesta);
      } catch (e) {
        // Rifiutata dal sito: nulla è cambiato, la ricetta si sblocca come sempre. Nei log il testo del sito
        // (ripulito) e la struttura mascherata della richiesta, per capire il rifiuto.
        if (e instanceof ErrorePrenota) {
          console.error(
            JSON.stringify({
              conferma_rifiutata: { codice: e.codice, dettaglio: e.dettaglio, trattenuta, richiesta: strutturaMascherata(richiesta) },
            }),
          );
          throw new Error(`Il sito ha rifiutato la prenotazione (${e.codice})`);
        }
        // Errore di rete: la prenotazione potrebbe essere andata a buon fine. Meglio non sbloccare la ricetta.
        sess.prenotata = true;
        throw new Error(
          `Nessuna risposta dal sito alla conferma (${(e as Error).message.slice(0, 80)}): controlla su PrenotaSalute se la prenotazione è avvenuta`,
        );
      }
      sess.prenotata = true;
      const fatti: any[] = (esito?.disponibilita ?? []).map((x: any) => x?.appuntamento).filter(Boolean);
      return {
        esito: "prenotato",
        appuntamenti: fatti.map(appuntamentoSemplice),
        codici: fatti.map((x) => String(x.ipCup ?? x.codice ?? "")).filter(Boolean),
        importo: esito?.importo != null ? String(esito.importo) : null,
        trattenuta,
      };
    };

    for (const zona of zone) {
      const r: any = await s.chiama(
        "pgpcitt_ricerca_disponibilita",
        criteriDisponibilita({
          codiceFiscale: dati.codiceFiscale,
          zona,
          ricetta,
          tipo,
          regimeErogazione: regime,
          recapiti: recapiti(login),
          // La stessa ricerca dei giri: con un limite "al" il sito propone date diverse (provato il 25/11/2026).
          vincoli: { dal: oggiRoma(opz.ora), al: null, mattina: true, pomeriggio: true },
        }),
      );
      const candidate = (r?.singole ?? []).filter((x: any) => corrisponde(x?.appuntamento, bersaglio));
      if (candidate.length === 0)
        console.log(JSON.stringify({ prenota_non_trovata: { zona: zona.codice, date: (r?.singole ?? []).length } }));
      const singola =
        candidate.find((x: any) => !bersaglio.agenda || x.appuntamento?.agenda?.codice === bersaglio.agenda) ?? candidate[0];
      if (singola) return concludi(zona, singola, false);
    }

    // Non si vede: forse è la data trattenuta dall'ultima ricerca. Se la sua proposta è recente, si usa quella.
    const r = opz.riserva;
    const adesso = (opz.ora ?? new Date()).getTime();
    if (r && corrisponde(r.singola?.appuntamento, bersaglio) && adesso - Date.parse(r.quando) < DURATA_PROPOSTA_MS) {
      const provincia = String(r.singola.appuntamento?.unitaErogante?.presidio?.puntoIndirizzo?.localita?.codice ?? "").slice(0, 3);
      const zona = zone.find((z) => z.codiceProvincia === provincia) ?? zone[0];
      return concludi(zona, r.singola, true);
    }
    return { esito: "non-disponibile" };
  });
}
