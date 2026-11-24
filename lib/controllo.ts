// Un giro sul sito: accesso, ricetta con il suo appuntamento, disponibilità nella zona del presidio, sblocco.
// Solo lettura: è il percorso del pulsante "Sposta" fermandosi prima di scegliere una data (vedi README).
import { ErrorePrenota, SessionePrenota, type OpzioniSessione } from "./prenota.js";

/** O prima visita, Z controllo, U urgente: come li manda il sito. */
export type Tipo = "O" | "Z" | "U";
export type DatiRicetta = { codiceFiscale: string; cifre: string; nre: string };
export type Luogo = { codice: string; descrizione: string };
export type Appuntamento = {
  /** AAAAMMGGhhmmss, ora italiana. */
  data: string;
  prestazione: string;
  presidio: Luogo;
  agenda: Luogo;
  unita: string | null;
};
export type DataLibera = { data: string; presidio: Luogo; agenda: Luogo; unita: string | null };
export type Zona = Record<string, unknown>;
export type EsitoSito = {
  /** null se la ricetta non ha (più) un appuntamento futuro. */
  appuntamento: Appuntamento | null;
  /** Tutte le date libere trovate nella zona, in ordine. */
  date: DataLibera[];
  tipo: Tipo;
  zona: Zona | null;
};

/** Errore da far vedere all'utente così com'è (dati sbagliati, ricetta non trovata…). */
export class ErroreUtente extends Error {}

const MESSAGGI: Record<string, string> = {
  "RICETTA.RICERCA.KO": "Ricetta non trovata: controlla il numero di ricetta (NRE)",
};

export type OpzioniGiro = OpzioniSessione & {
  /** Tipo già noto (salvato al primo giro o scelto dall'utente). */
  tipo?: Tipo | null;
  /** Zona già nota, per risparmiare una chiamata. */
  zona?: Zona | null;
  /** "Adesso", per i test. */
  ora?: Date;
};

// ---- date ----------------------------------------------------------------------------------------

const ROMA = "Europe/Rome";

/** Data di oggi in Italia come AAAAMMGG. */
export function oggiRoma(ora = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: ROMA, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(ora)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}`;
}

/** Adesso in Italia come AAAAMMGGhhmmss, confrontabile con le date del sito. */
export function adessoRoma(ora = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ROMA,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(ora)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}

/** "AAAAMMGG" → mezzanotte italiana in ISO, come la serializza il sito (moment → Date → JSON). */
export function mezzanotteRomaIso(giorno: string | null | undefined): string | null {
  if (!giorno || giorno.length < 8) return null;
  const y = Number(giorno.slice(0, 4));
  const m = Number(giorno.slice(4, 6));
  const d = Number(giorno.slice(6, 8));
  const utc = Date.UTC(y, m - 1, d);
  const ore = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: ROMA, hour: "numeric", hourCycle: "h23" }).format(new Date(utc)),
  );
  return new Date(utc - ore * 3_600_000).toISOString();
}

// ---- richieste -----------------------------------------------------------------------------------

export function normalizzaNre(nre: string) {
  return nre.replace(/[\s-]/g, "").toUpperCase();
}

function criteriRicetta(dati: DatiRicetta) {
  return {
    codiceFiscale: dati.codiceFiscale,
    iup: null,
    iurp: null,
    nre: dati.nre,
    rur: null,
    periodo: { dal: null, al: null },
    flagFlussoPostoInCoda: "N",
    flagIncludiNonPrenotabili: "N",
    codicePrestazione: "",
    categoriaPrestazione: "",
  };
}

/** La ricetta come la rimanda il sito nella ricerca delle disponibilità (altrimenti risponde ES0001). */
function ricettaPerDisponibilita(ricetta: any) {
  return {
    ...ricetta,
    emessaIl: mezzanotteRomaIso(ricetta.emessaIl),
    scadenzaIl: mezzanotteRomaIso(ricetta.scadenzaIl),
    prestazioniPrenotate: (ricetta.prestazioni ?? []).filter((p: any) => p?.stato?.codice === "03"),
    appuntamentiUnificati: null,
  };
}

const SI = "S";
function criteriDisponibilita(p: {
  codiceFiscale: string;
  zona: Zona;
  ricetta: any;
  tipo: Tipo;
  regimeErogazione: string | null;
  recapiti: { telefono: string | null; email: string | null };
  oggi: string;
}) {
  return {
    codiceFiscale: p.codiceFiscale,
    zona: p.zona,
    ricetta: ricettaPerDisponibilita(p.ricetta),
    tipoPrestazione: p.tipo,
    presidi: [],
    aziende: [],
    recapiti: { telefono: p.recapiti.telefono, cellulare: null, email: p.recapiti.email },
    vincoliTemporali: {
      dal: `${p.oggi}000000`,
      al: null,
      lunedi: SI,
      martedi: SI,
      mercoledi: SI,
      giovedi: SI,
      venerdi: SI,
      sabato: SI,
      domenica: SI,
      mattina: SI,
      pomeriggio: SI,
    },
    caricaRequestRicercaAgende: "N",
    minDal: null,
    ats: null,
    tipoNegoziazione: null,
    regimeErogazione: p.regimeErogazione,
    risorsa: null,
    codiceProvincia: null,
    codiceComune: null,
    codiceStruttura: null,
    equipe: null,
    soggettoPagante: null,
  };
}

// ---- lettura delle risposte ----------------------------------------------------------------------

function luogo(x: any): Luogo {
  return { codice: String(x?.codice ?? ""), descrizione: String(x?.descrizioneEstesa ?? x?.descrizione ?? "") };
}

/** Il primo appuntamento futuro, non annullato, della ricetta. */
export function scegliAppuntamento(ricetta: any, adesso: string): any | null {
  const singoli: any[] = ricetta?.appuntamenti?.singoli ?? [];
  return (
    singoli
      .filter((a) => !a.annullatoIl && typeof a.data === "string" && a.data > adesso)
      .sort((a, b) => a.data.localeCompare(b.data))[0] ?? null
  );
}

function appuntamentoSemplice(a: any): Appuntamento {
  return {
    data: a.data,
    prestazione: String(a.prestazione?.descrizione ?? ""),
    presidio: luogo(a.unitaErogante?.presidio),
    agenda: luogo(a.agenda),
    unita: a.unitaErogante?.descrizione ?? null,
  };
}

export function leggiDisponibilita(r: any): DataLibera[] {
  const viste = new Set<string>();
  const out: DataLibera[] = [];
  for (const d of r?.singole ?? []) {
    const a = d?.appuntamento;
    if (!a || typeof a.data !== "string") continue;
    const x: DataLibera = {
      data: a.data,
      presidio: luogo(a.unitaErogante?.presidio),
      agenda: luogo(a.agenda),
      unita: a.unitaErogante?.descrizione ?? null,
    };
    const k = chiaveData(x);
    if (viste.has(k)) continue;
    viste.add(k);
    out.push(x);
  }
  return out.sort((a, b) => a.data.localeCompare(b.data));
}

export function chiaveData(d: DataLibera) {
  return `${d.data}|${d.presidio.codice}|${d.agenda.codice}`;
}

/** Le regole del sito per capire dalla ricetta se è prima visita o controllo; null se il sito lo chiederebbe. */
export function tipoDaRicetta(ricetta: any): Tipo | null {
  if (ricetta?.tipoPrestazione) return ricetta.tipoPrestazione as Tipo;
  if ((ricetta?.priorita ?? "P") === "U") return "U";
  for (const p of ricetta?.prestazioni ?? []) {
    const d = String(p?.descrizione ?? "").replace(/\s/g, "").toUpperCase();
    if (d.includes("(PRIMAVISITA)")) return "O";
    if (d.includes("(CONTROLLO)")) return "Z";
  }
  if (ricetta?.flagEsenzionePatologia === "S") return "Z";
  return null;
}

// ---- il giro -------------------------------------------------------------------------------------

export async function giroSito(dati: DatiRicetta, opz: OpzioniGiro = {}): Promise<EsitoSito> {
  const s = new SessionePrenota({ timeoutMs: 40_000, ...opz });
  await s.apri();
  await s.parametri();
  let login: any;
  try {
    login = await s.accedi(dati.codiceFiscale, dati.cifre);
  } catch (e) {
    if (e instanceof ErrorePrenota)
      throw new ErroreUtente(`Accesso rifiutato dal sito (${e.codice}): controlla codice fiscale e cifre della tessera`);
    throw e;
  }

  // Da qui la ricetta elettronica può risultare bloccata: si sblocca sempre, come fa il sito.
  try {
    let rr: any;
    try {
      rr = await s.chiama("pgpcitt_ricerca_ricetta", criteriRicetta(dati));
    } catch (e) {
      if (e instanceof ErrorePrenota) throw new ErroreUtente(MESSAGGI[e.codice] ?? `Ricetta: errore del sito (${e.codice})`);
      throw e;
    }
    const ricetta = rr?.ricette?.[0];
    if (!ricetta) throw new ErroreUtente(MESSAGGI["RICETTA.RICERCA.KO"]);

    const grezzo = scegliAppuntamento(ricetta, adessoRoma(opz.ora));
    if (!grezzo) return { appuntamento: null, date: [], tipo: opz.tipo ?? "O", zona: opz.zona ?? null };
    const appuntamento = appuntamentoSemplice(grezzo);

    const zona = opz.zona ?? (await trovaZona(s, grezzo));
    const cittadino = login?.cittadino ?? {};
    const cerca = async (tipo: Tipo) =>
      leggiDisponibilita(
        await s.chiama(
          "pgpcitt_ricerca_disponibilita",
          criteriDisponibilita({
            codiceFiscale: dati.codiceFiscale,
            zona,
            ricetta,
            tipo,
            regimeErogazione: grezzo.regimeErogazione ?? null,
            recapiti: { telefono: cittadino.telefono ?? null, email: cittadino.email ?? null },
            oggi: oggiRoma(opz.ora),
          }),
        ),
      );

    let tipo = opz.tipo ?? tipoDaRicetta(ricetta);
    let date: DataLibera[];
    if (tipo) {
      date = await cerca(tipo);
    } else {
      // Il sito lo chiederebbe: si prova "prima visita" e si controlla che le date siano nella stessa agenda
      // dell'appuntamento; se no si prova "controllo".
      const stessaAgenda = (l: DataLibera[]) => l.some((d) => d.agenda.codice === appuntamento.agenda.codice);
      tipo = "O";
      date = await cerca("O");
      if (!stessaAgenda(date)) {
        const z = await cerca("Z");
        if (stessaAgenda(z)) {
          tipo = "Z";
          date = z;
        }
      }
    }
    return { appuntamento, date, tipo, zona };
  } finally {
    await s
      .chiama("pgpcitt_sblocca_ricetta_elettronica", { codiceFiscale: dati.codiceFiscale, nre: dati.nre })
      .catch((e) => console.warn(JSON.stringify({ sblocco: (e as Error).message.slice(0, 120) })));
  }
}

async function trovaZona(s: SessionePrenota, appuntamento: any): Promise<Zona> {
  const provincia = String(appuntamento?.unitaErogante?.presidio?.puntoIndirizzo?.localita?.codice ?? "").slice(0, 3);
  const zone = await s.chiama<any[]>("pgpcitt_ricerca_zona", {});
  const z = (zone ?? []).find((x) => x.codiceProvincia === provincia && x.codiceComune === "%");
  if (!z) throw new Error(`Zona della provincia ${provincia || "?"} non trovata`);
  return { ...z, codice: `${z.codiceProvincia}${z.codiceComune}` };
}

/** Le date libere prima dell'appuntamento, nello stesso presidio. */
export function dateAnticipate(appuntamento: Appuntamento, date: DataLibera[]): DataLibera[] {
  return date.filter((d) => d.presidio.codice === appuntamento.presidio.codice && d.data < appuntamento.data);
}
