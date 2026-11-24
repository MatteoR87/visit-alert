// Testi dei messaggi del bot (HTML di Telegram).
import { chiaveData, type Appuntamento, type DataLibera, type Tipo } from "./controllo.js";
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

export const AIUTO = [
  "<b>visit-alert</b>: ti avviso quando su PrenotaSalute si libera una data prima del tuo appuntamento, nella stessa struttura.",
  "",
  "<code>/avvia CODICEFISCALE CIFRE NRE</code> avvia il controllo. CIFRE sono le ultime 5 cifre della tessera sanitaria, NRE il numero di ricetta elettronica. Il messaggio viene cancellato subito; i dati si salvano cifrati.",
  "Facoltativo in fondo: <code>O</code> (prima visita) o <code>Z</code> (controllo), solo se quello trovato in automatico è sbagliato.",
  "<code>/stato</code> i controlli attivi e l'ultimo giro",
  "<code>/date N</code> controlla adesso e mostra tutte le date libere",
  "<code>/stop N</code> ferma il controllo N e cancella i suoi dati",
  "<code>/id</code> il tuo ID Telegram",
  "",
  "Il bot legge e basta: non prenota né disdice nulla.",
].join("\n");
