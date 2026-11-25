// Testi dei messaggi del bot (HTML di Telegram).
import { chiaveData, type Appuntamento, type DataLibera, type Filtri, type Tipo } from "./controllo.js";
import { formatoGiorno, formatoOra } from "./dati.js";
import { html } from "./telegram.js";

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

function riga(d: DataLibera, appuntamento: Appuntamento, nuove?: Set<string>) {
  const nuovo = nuove?.has(chiaveData(d)) ? "🆕 " : "• ";
  const agenda = d.agenda.codice !== appuntamento.agenda.codice ? ` <i>(altra agenda: ${html(d.agenda.descrizione)})</i>` : "";
  return `${nuovo}${formatoData(d.data)}${agenda}`;
}

export function elencoDate(date: DataLibera[], appuntamento: Appuntamento, nuove?: Set<string>): string {
  const righe = date.slice(0, MAX_DATE).map((d) => riga(d, appuntamento, nuove));
  if (date.length > MAX_DATE) righe.push(`… e altre ${date.length - MAX_DATE}`);
  return righe.join("\n");
}

export function messaggioAnticipate(
  id: number,
  appuntamento: Appuntamento,
  anticipate: DataLibera[],
  nuove: Set<string>,
): string {
  return [
    `🎉 <b>Date libere prima del tuo appuntamento</b> (controllo #${id})`,
    "",
    descriviAppuntamento(appuntamento),
    "",
    `Nella stessa struttura (${anticipate.length}):`,
    elencoDate(anticipate, appuntamento, nuove),
    "",
    `Per spostarlo: <a href="${SITO}">PrenotaSalute</a> → "Sposta", oppure 800 638638. I posti possono sparire in fretta.`,
  ].join("\n");
}

// ---- ricerca nuova -------------------------------------------------------------------------------

export const PRIMI_RISULTATI = 10;

export function nomeZona(z: { descrizione?: unknown; codice?: unknown }) {
  return String(z.descrizione ?? z.codice ?? "?");
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
  const orario = f.oraDa === 0 && f.oraA >= 24 * 60 ? "tutto il giorno" : `${formatoOra(f.oraDa)}–${formatoOra(f.oraA)}`;
  return [
    `📍 Zone: ${f.zone.map((z) => html(nomeZona(z))).join(", ")}`,
    `📆 Periodo: ${periodo}`,
    `🕘 Orario: ${orario}`,
  ].join("\n");
}

function rigaRisultato(d: DataLibera, nuove?: Set<string>) {
  const segno = nuove?.has(chiaveData(d)) ? "🆕" : "•";
  return `${segno} <b>${formatoData(d.data)}</b> — ${html(d.presidio.descrizione)}${d.unita ? `\n    <i>${html(d.unita)}</i>` : ""}`;
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
    ...risultati.slice(0, PRIMI_RISULTATI).map((d) => rigaRisultato(d, nuove)),
  ];
  if (zoneInErrore.length > 0) righe.push("", `⚠️ Non sono riuscito a cercare in: ${html(zoneInErrore.join(", "))}.`);
  if (risultati.length > 0)
    righe.push("", `Per prenotare: <a href="${SITO}">PrenotaSalute</a> oppure 800 638638. I posti possono sparire in fretta.`);
  return righe.join("\n");
}

export const AIUTO = [
  "<b>visit-alert</b>: cerco date su PrenotaSalute e ti avviso quando se ne liberano di migliori.",
  "",
  "<code>/avvia CODICEFISCALE CIFRE NRE</code> per una ricetta già prenotata: ti avviso quando si libera una data prima del tuo appuntamento, nella stessa struttura.",
  "<code>/cerca CODICEFISCALE CIFRE NRE</code> per cercare una visita: scegli con i pulsanti province, periodo e fascia oraria, ti mostro le prime 10 date e ti avviso quando ne compaiono di migliori.",
  "CIFRE sono le ultime 5 cifre della tessera sanitaria, NRE il numero di ricetta elettronica. Il messaggio viene cancellato subito; i dati si salvano cifrati.",
  "Facoltativo in fondo: <code>O</code> (prima visita) o <code>Z</code> (controllo), se quello trovato in automatico è sbagliato.",
  "",
  "<code>/stato</code> controlli e ricerche attivi, e l'ultimo giro",
  "<code>/date N</code> controlla adesso e mostra le date",
  "<code>/stop N</code> ferma il controllo o la ricerca N e cancella i suoi dati",
  "<code>/id</code> il tuo ID Telegram",
  "",
  "Il bot legge e basta: non prenota né disdice nulla.",
].join("\n");
