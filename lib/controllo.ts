// I giri sul sito, solo in lettura (vedi README):
// - giroSito: la ricetta già prenotata, il suo appuntamento e le date nella zona del presidio (per anticipare);
// - anteprimaRicetta: la ricetta e le zone, per preparare una ricerca nuova;
// - cercaNuova: le date nelle zone scelte, con periodo e orario.
// Dopo la ricerca della ricetta, che la blocca, si chiama sempre lo sblocco, come fa il sito.
import { ErrorePrenota, InCoda, SessionePrenota, type OpzioniSessione } from "./prenota.js";

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
/** Una zona del sito (provincia, o Milano città), come la restituisce pgpcitt_ricerca_zona più `codice`. */
export type Zona = Record<string, unknown> & { codice?: string; descrizione?: string };
export type EsitoSito = {
  /** null se la ricetta non ha (più) un appuntamento futuro. */
  appuntamento: Appuntamento | null;
  /** Tutte le date libere trovate nella zona, in ordine. */
  date: DataLibera[];
  tipo: Tipo;
  zona: Zona | null;
};

/** Una fascia oraria in minuti dalla mezzanotte, estremi inclusi. */
export type Fascia = { da: number; a: number };

/** Filtri di una ricerca nuova. Date AAAAMMGG (incluse). */
export type Filtri = {
  zone: Zona[];
  dal: string | null;
  al: string | null;
  /** Le fasce orarie accettate; vuota = tutto il giorno. */
  fasce?: Fascia[];
  /** Prima versione (una sola fascia): si legge ancora con fasceDi. */
  oraDa?: number;
  oraA?: number;
};

export const GIORNO_INTERO: Fascia = { da: 0, a: 24 * 60 };

/** Le fasce di un filtro, anche se salvato dalla prima versione; vuota = tutto il giorno. */
export function fasceDi(f: Filtri): Fascia[] {
  if (f.fasce) return f.fasce;
  if (f.oraDa !== undefined && f.oraA !== undefined && !(f.oraDa <= 0 && f.oraA >= 24 * 60)) return [{ da: f.oraDa, a: f.oraA }];
  return [];
}

export type Anteprima = {
  prestazione: string;
  /** Il tipo dedotto dalla ricetta come fa il sito; null se il sito lo chiederebbe. */
  tipo: Tipo | null;
  /** L'appuntamento futuro, se la ricetta è già prenotata. */
  appuntamento: Appuntamento | null;
  zone: Zona[];
};

export type EsitoRicerca = {
  /** L'appuntamento futuro della ricetta, se è prenotata. */
  appuntamento: Appuntamento | null;
  /** Le date che rispettano i filtri, in ordine, da tutte le zone. */
  date: DataLibera[];
  /** Zone in cui la ricerca è fallita (le altre valgono comunque). */
  zoneInErrore: string[];
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

function parti(ora: Date, conOra: boolean) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ROMA,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(conOra ? { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" } : {}),
    })
      .formatToParts(ora)
      .map((x) => [x.type, x.value]),
  );
}

/** Data di oggi in Italia come AAAAMMGG. */
export function oggiRoma(ora = new Date()): string {
  const p = parti(ora, false);
  return `${p.year}${p.month}${p.day}`;
}

/** Adesso in Italia come AAAAMMGGhhmmss, confrontabile con le date del sito. */
export function adessoRoma(ora = new Date()): string {
  const p = parti(ora, true);
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

type Vincoli = { dal: string; al: string | null; mattina: boolean; pomeriggio: boolean };

const sn = (b: boolean) => (b ? "S" : "N");
function criteriDisponibilita(p: {
  codiceFiscale: string;
  zona: Zona;
  ricetta: any;
  tipo: Tipo;
  regimeErogazione: string | null;
  recapiti: { telefono: string | null; email: string | null };
  vincoli: Vincoli;
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
      dal: `${p.vincoli.dal}000000`,
      al: p.vincoli.al ? `${p.vincoli.al}235959` : null,
      lunedi: "S",
      martedi: "S",
      mercoledi: "S",
      giovedi: "S",
      venerdi: "S",
      sabato: "S",
      domenica: "S",
      mattina: sn(p.vincoli.mattina),
      pomeriggio: sn(p.vincoli.pomeriggio),
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

function prestazioneDi(ricetta: any): string {
  return (ricetta?.prestazioni ?? []).map((p: any) => String(p?.descrizione ?? "")).filter(Boolean).join(" + ");
}

// ---- sessione con la ricetta ---------------------------------------------------------------------

type Sessione = { s: SessionePrenota; login: any; ricetta: any };

/** Accesso e ricetta; `lavoro` gira con la ricetta bloccata, che poi si sblocca sempre. */
async function conRicetta<T>(dati: DatiRicetta, opz: OpzioniSessione, lavoro: (x: Sessione) => Promise<T>): Promise<T> {
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
    return await lavoro({ s, login, ricetta });
  } finally {
    await s
      .chiama("pgpcitt_sblocca_ricetta_elettronica", { codiceFiscale: dati.codiceFiscale, nre: dati.nre })
      .catch((e) => console.warn(JSON.stringify({ sblocco: (e as Error).message.slice(0, 120) })));
  }
}

function recapiti(login: any) {
  const c = login?.cittadino ?? {};
  return { telefono: c.telefono ?? null, email: c.email ?? null };
}

async function zoneDelSito(s: SessionePrenota): Promise<Zona[]> {
  const zone = await s.chiama<any[]>("pgpcitt_ricerca_zona", {});
  return (zone ?? []).map((z) => ({ ...z, codice: `${z.codiceProvincia}${z.codiceComune}` }));
}

async function trovaZona(s: SessionePrenota, appuntamento: any): Promise<Zona> {
  const provincia = String(appuntamento?.unitaErogante?.presidio?.puntoIndirizzo?.localita?.codice ?? "").slice(0, 3);
  const z = (await zoneDelSito(s)).find((x) => x.codiceProvincia === provincia && x.codiceComune === "%");
  if (!z) throw new Error(`Zona della provincia ${provincia || "?"} non trovata`);
  return z;
}

// ---- anticipare un appuntamento ------------------------------------------------------------------

export async function giroSito(dati: DatiRicetta, opz: OpzioniGiro = {}): Promise<EsitoSito> {
  return conRicetta(dati, opz, async ({ s, login, ricetta }) => {
    const grezzo = scegliAppuntamento(ricetta, adessoRoma(opz.ora));
    if (!grezzo) return { appuntamento: null, date: [], tipo: opz.tipo ?? "O", zona: opz.zona ?? null };
    const appuntamento = appuntamentoSemplice(grezzo);

    const zona = opz.zona ?? (await trovaZona(s, grezzo));
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
            recapiti: recapiti(login),
            vincoli: { dal: oggiRoma(opz.ora), al: null, mattina: true, pomeriggio: true },
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
  });
}

/** Le date libere prima dell'appuntamento, nello stesso presidio. */
export function dateAnticipate(appuntamento: Appuntamento, date: DataLibera[]): DataLibera[] {
  return date.filter((d) => d.presidio.codice === appuntamento.presidio.codice && d.data < appuntamento.data);
}

// ---- ricerca nuova -------------------------------------------------------------------------------

/** Ricetta e zone, per preparare una ricerca nuova (e controllare subito i dati). */
export async function anteprimaRicetta(dati: DatiRicetta, opz: OpzioniGiro = {}): Promise<Anteprima> {
  return conRicetta(dati, opz, async ({ s, ricetta }) => {
    const grezzo = scegliAppuntamento(ricetta, adessoRoma(opz.ora));
    return {
      prestazione: prestazioneDi(ricetta),
      tipo: tipoDaRicetta(ricetta),
      appuntamento: grezzo ? appuntamentoSemplice(grezzo) : null,
      zone: await zoneDelSito(s),
    };
  });
}

const minuti = (data: string) => Number(data.slice(8, 10)) * 60 + Number(data.slice(10, 12));
/** Il confine tra mattina e pomeriggio del sito non è documentato: si chiede largo e si filtra qui. */
const FINE_MATTINA = 14 * 60;
const INIZIO_POMERIGGIO = 12 * 60;

export function rispettaFiltri(d: DataLibera, f: Filtri, oggi: string): boolean {
  const giorno = d.data.slice(0, 8);
  if (giorno < oggi) return false;
  if (f.dal && giorno < f.dal) return false;
  if (f.al && giorno > f.al) return false;
  const fasce = fasceDi(f);
  if (fasce.length === 0) return true;
  const m = minuti(d.data);
  return fasce.some((x) => m >= x.da && m <= x.a);
}

/** Mattina e/o pomeriggio da chiedere al sito per coprire tutte le fasce. */
export function fasceSito(fasce: Fascia[]): { mattina: boolean; pomeriggio: boolean } {
  if (fasce.length === 0) return { mattina: true, pomeriggio: true };
  return {
    mattina: fasce.some((x) => x.da < FINE_MATTINA),
    pomeriggio: fasce.some((x) => x.a > INIZIO_POMERIGGIO),
  };
}

export async function cercaNuova(
  dati: DatiRicetta,
  tipo: Tipo,
  filtri: Filtri,
  opz: OpzioniSessione & { ora?: Date } = {},
): Promise<EsitoRicerca> {
  return conRicetta(dati, opz, async ({ s, login, ricetta }) => {
    // Anche con la ricetta già prenotata si cerca: può servire una data migliore altrove. Chi chiama decide
    // cosa fare dell'appuntamento (il giro periodico si ferma se compare dopo l'avvio).
    const grezzo = scegliAppuntamento(ricetta, adessoRoma(opz.ora));
    const oggi = oggiRoma(opz.ora);
    const vincoli: Vincoli = {
      dal: filtri.dal && filtri.dal > oggi ? filtri.dal : oggi,
      al: filtri.al,
      ...fasceSito(fasceDi(filtri)),
    };
    const tutte: DataLibera[] = [];
    const zoneInErrore: string[] = [];
    for (const zona of filtri.zone) {
      try {
        const r = await s.chiama(
          "pgpcitt_ricerca_disponibilita",
          criteriDisponibilita({
            codiceFiscale: dati.codiceFiscale,
            zona,
            ricetta,
            tipo,
            regimeErogazione: grezzo?.regimeErogazione ?? null,
            recapiti: recapiti(login),
            vincoli,
          }),
        );
        tutte.push(...leggiDisponibilita(r));
      } catch (e) {
        if (e instanceof InCoda) throw e;
        zoneInErrore.push(String(zona.descrizione ?? zona.codice));
        console.warn(JSON.stringify({ ricerca: { zona: zona.codice, errore: (e as Error).message.slice(0, 120) } }));
      }
    }
    if (zoneInErrore.length === filtri.zone.length) throw new Error("La ricerca è fallita in tutte le zone");
    const viste = new Set<string>();
    const date = tutte
      .filter((d) => rispettaFiltri(d, filtri, oggi))
      .filter((d) => (viste.has(chiaveData(d)) ? false : (viste.add(chiaveData(d)), true)))
      .sort((a, b) => a.data.localeCompare(b.data) || a.presidio.descrizione.localeCompare(b.presidio.descrizione));
    return { appuntamento: grezzo ? appuntamentoSemplice(grezzo) : null, date, zoneInErrore };
  });
}
