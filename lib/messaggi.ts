// Testi dei messaggi del bot (HTML di Telegram).
import {
  chiaveData,
  fasceDi,
  type Appuntamento,
  type DataLibera,
  type Fascia,
  type Filtri,
  type Struttura,
  type Tipo,
} from "./controllo.js";
import { formatoGiorno, formatoOra } from "./dati.js";
import { html, type Tastiera } from "./telegram.js";

const GIORNI = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
export const SITO = "https://prenotasalute.regione.lombardia.it/prenotaonline/";
const MAX_DATE = 40;

/** "20270505113000" → "mer 05/05/2027 11:30" (le date del sito sono già in ora italiana). */
export function formatoData(d: string): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const g = Number(d.slice(6, 8));
  const giorno = GIORNI[new Date(Date.UTC(y, m - 1, g)).getUTCDay()];
  return `${giorno} ${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)} ${d.slice(8, 10)}:${d.slice(10, 12)}`;
}

export function formatoTipo(t: Tipo) {
  return t === "Z" ? "controllo" : t === "U" ? "urgente" : "prima visita";
}

export function descriviAppuntamento(a: Appuntamento): string {
  return [
    `🩺 <b>${html(a.prestazione)}</b>`,
    `🏥 ${html(a.presidio.descrizione)}${a.unita ? `\n   ${html(a.unita)}` : ""}`,
    `📅 Appuntamento attuale: <b>${formatoData(a.data)}</b>`,
  ].join("\n");
}

/** Quante date di un messaggio hanno il pulsante "📅 N" per prenotarle. */
export const DATE_PRENOTABILI = 10;

/** "1." per le date con il pulsante Prenota, "•" per le altre. */
function numero(i: number) {
  return i < DATE_PRENOTABILI ? `${i + 1}.` : "•";
}

function riga(d: DataLibera, i: number, appuntamento: Appuntamento, nuove?: Set<string>) {
  const nuovo = nuove?.has(chiaveData(d)) ? "🆕 " : "";
  const dove =
    d.presidio.codice !== appuntamento.presidio.codice
      ? ` — ${html(d.presidio.descrizione)}`
      : d.agenda.codice !== appuntamento.agenda.codice
        ? ` <i>(altra agenda: ${html(d.agenda.descrizione)})</i>`
        : "";
  return `${numero(i)} ${nuovo}${formatoData(d.data)}${dove}`;
}

/** I pulsanti "📅 N" sotto un elenco di date: toccandone uno il bot chiede conferma prima di prenotare. */
export function tastieraPrenota(id: number, date: DataLibera[]): Tastiera {
  const pulsanti = date.slice(0, DATE_PRENOTABILI).map((d, i) => ({
    text: `📅 ${i + 1}`,
    callback_data: `p:${id}:${d.data}:${d.presidio.codice}`,
  }));
  const righe: Tastiera = [];
  for (let i = 0; i < pulsanti.length; i += 5) righe.push(pulsanti.slice(i, i + 5));
  return righe;
}

/**
 * I pulsanti sotto i risultati di una ricerca: "📅 N" e, se la ricerca non è monitorata, "🔔" per farla
 * ripetere dal cron e "✖️" per chiuderla subito.
 */
export function tastieraRicerca(id: number, date: DataLibera[], monitora: boolean | undefined): Tastiera {
  const righe = tastieraPrenota(id, date);
  if (monitora === false)
    righe.push([
      { text: "🔔 Avvisami di date migliori", callback_data: `m:${id}` },
      { text: "✖️ Chiudi", callback_data: `mx:${id}` },
    ]);
  return righe;
}

/** Il testo sotto i risultati di una ricerca non monitorata. */
export const NON_MONITORATA =
  "ℹ️ Non ripeto questa ricerca. Tocca 🔔 se vuoi che la ricontrolli ogni 15 minuti di giorno (ogni ora di notte) e ti avvisi quando compaiono date migliori. Altrimenti tra un'ora cancello i dati (o subito con ✖️).";

export function elencoDate(date: DataLibera[], appuntamento: Appuntamento, nuove?: Set<string>): string {
  const righe = date.slice(0, MAX_DATE).map((d, i) => riga(d, i, appuntamento, nuove));
  if (date.length > MAX_DATE) righe.push(`… e altre ${date.length - MAX_DATE}`);
  return righe.join("\n");
}

export function messaggioAnticipate(
  id: number,
  appuntamento: Appuntamento,
  anticipate: DataLibera[],
  nuove: Set<string>,
  nStrutture = 1,
): string {
  return [
    `🎉 <b>Date libere prima del tuo appuntamento</b> (controllo #${id})`,
    "",
    descriviAppuntamento(appuntamento),
    "",
    `${nStrutture > 1 ? `Nelle ${nStrutture} strutture scelte` : "Nella stessa struttura"} (${anticipate.length}):`,
    elencoDate(anticipate, appuntamento, nuove),
    "",
    `Per spostarlo tocca 📅 e il numero (ti chiedo conferma), oppure <a href="${SITO}">PrenotaSalute</a> → "Sposta", o 800 638638. I posti possono sparire in fretta.`,
  ].join("\n");
}

// ---- ricerca nuova -------------------------------------------------------------------------------

export const PRIMI_RISULTATI = 10;

export function nomeZona(z: { descrizione?: unknown; codice?: unknown }) {
  return String(z.descrizione ?? z.codice ?? "?");
}

export function descriviFascia(x: Fascia) {
  return `${formatoOra(x.da)}–${formatoOra(x.a)}`;
}

export function descriviFasce(fasce: Fascia[]) {
  return fasce.map(descriviFascia).join(", ");
}

export function descriviFiltri(f: Filtri): string {
  const periodo =
    f.dal && f.al
      ? `dal ${formatoGiorno(f.dal)} al ${formatoGiorno(f.al)}`
      : f.al
        ? `fino al ${formatoGiorno(f.al)}`
        : f.dal
          ? `dal ${formatoGiorno(f.dal)}`
          : "da subito, senza limite";
  const fasce = fasceDi(f);
  const orario = fasce.length === 0 ? "tutto il giorno" : descriviFasce(fasce);
  return [
    `📍 Zone: ${f.zone.map((z) => html(nomeZona(z))).join(", ")}`,
    `📆 Periodo: ${periodo}`,
    `🕘 Orario: ${orario}`,
    f.presidi && f.presidi.length > 0 ? `🏥 Strutture: ${f.presidi.map((p) => html(p.descrizione)).join(", ")}` : "🏥 Strutture: tutte",
  ].join("\n");
}

/** Quante strutture si mostrano come pulsanti (le prime per data). */
export const MAX_STRUTTURE_MOSTRATE = 20;

/** Un pulsante per struttura: "✅" se scelta, con il numero di date e la prima. */
export function tastieraStrutture(elenco: Struttura[], scelte: string[], dato: (codice: string) => string): Tastiera {
  return elenco.slice(0, MAX_STRUTTURE_MOSTRATE).map((s) => {
    const nome = s.presidio.descrizione.length > 38 ? `${s.presidio.descrizione.slice(0, 37)}…` : s.presidio.descrizione;
    const quante = s.date === 0 ? "nessuna data" : `${s.date} ${s.date === 1 ? "data" : "date"}, dal ${formatoData(s.prima).slice(4, 14)}`;
    return [{ text: `${scelte.includes(s.presidio.codice) ? "✅" : "▫️"} ${nome} · ${quante}`, callback_data: dato(s.presidio.codice) }];
  });
}

function rigaRisultato(d: DataLibera, i: number, nuove?: Set<string>) {
  const segno = nuove?.has(chiaveData(d)) ? "🆕 " : "";
  return `${numero(i)} ${segno}<b>${formatoData(d.data)}</b> — ${html(d.presidio.descrizione)}${d.unita ? `\n    <i>${html(d.unita)}</i>` : ""}`;
}

export function messaggioRisultati(
  id: number,
  prestazione: string,
  filtri: Filtri,
  risultati: DataLibera[],
  nuove?: Set<string>,
  zoneInErrore: string[] = [],
): string {
  const righe = [
    `🔎 <b>Ricerca #${id}</b>: ${html(prestazione)}`,
    descriviFiltri(filtri),
    "",
    risultati.length > 0
      ? `Le prime ${Math.min(risultati.length, PRIMI_RISULTATI)} date libere:`
      : "Per ora nessuna data che rispetta i filtri: ti scrivo appena ne compare una.",
    ...risultati.slice(0, PRIMI_RISULTATI).map((d, i) => rigaRisultato(d, i, nuove)),
  ];
  if (zoneInErrore.length > 0) righe.push("", `⚠️ Non sono riuscito a cercare in: ${html(zoneInErrore.join(", "))}.`);
  if (risultati.length > 0)
    righe.push(
      "",
      `Per prenotare tocca 📅 e il numero (ti chiedo conferma), oppure <a href="${SITO}">PrenotaSalute</a> o 800 638638. I posti possono sparire in fretta.`,
    );
  return righe.join("\n");
}

export const AIUTO = [
  "<b>visit-alert</b>: cerco date su PrenotaSalute e ti avviso quando se ne liberano di migliori.",
  "",
  "<code>/anticipa CODICEFISCALE CIFRE NRE</code> per una ricetta già prenotata: ti mostro le date prima del tuo appuntamento, scegli le strutture della provincia (la tua è già scelta) e con ✅ Avvia il controllo ti avviso quando se ne libera una.",
  "<code>/cerca CODICEFISCALE CIFRE NRE</code> per cercare una visita: scegli con i pulsanti province, periodo, fascia oraria e strutture, ti mostro le prime 10 date e, solo se tocchi 🔔, ti avviso quando ne compaiono di migliori.",
  "CIFRE sono le ultime 5 cifre della tessera sanitaria, NRE il numero di ricetta elettronica. Il messaggio viene cancellato subito; i dati si salvano cifrati.",
  "Facoltativo in fondo: <code>O</code> (prima visita) o <code>Z</code> (controllo), se quello trovato in automatico è sbagliato.",
  "",
  "<code>/stato</code> controlli e ricerche attivi, e l'ultimo giro",
  "<code>/date N</code> controlla adesso e mostra le date",
  "<code>/stop N</code> ferma il controllo o la ricerca N e cancella i suoi dati",
  "<code>/disdici N</code> o <code>/disdici CODICEFISCALE CIFRE NRE</code> disdice la visita prenotata, dopo la tua conferma",
  "<code>/id</code> il tuo ID Telegram",
  "",
  "Sotto le date ci sono i pulsanti 📅 1, 📅 2…: il bot prenota solo dopo che hai confermato quella data. Se la ricetta è già prenotata, il sito annulla da solo l'appuntamento precedente.",
].join("\n");
