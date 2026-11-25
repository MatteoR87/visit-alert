// Comandi del bot Telegram (vedi README e AIUTO in messaggi.ts).
import type { Client } from "@libsql/client";
import { avviaCerca, gestisciPulsante, gestisciTesto, type ContestoCerca } from "./cerca.js";
import { chiaveData, dateAnticipate, ErroreUtente, giroSito, type Tipo } from "./controllo.js";
import { leggiDatiRicetta } from "./dati.js";
import { cancellaControllo, leggiControlli, leggiStato, nuovoControllo, type Controllo } from "./db.js";
import {
  AIUTO,
  descriviAppuntamento,
  descriviFiltri,
  formatoData,
  formatoTipo,
  messaggioAnticipate,
  messaggioRisultati,
} from "./messaggi.js";
import { controllaUno, type Contesto as ContestoMonitor } from "./monitor.js";
import { InCoda } from "./prenota.js";
import { html } from "./telegram.js";

export type ContestoBot = ContestoMonitor &
  ContestoCerca & {
    db: Client;
    utenti: Set<string>;
  };

export const COMANDI = [
  { command: "avvia", description: "Anticipa una visita prenotata: /avvia CODICEFISCALE CIFRE NRE" },
  { command: "cerca", description: "Cerca una visita nuova: /cerca CODICEFISCALE CIFRE NRE" },
  { command: "stato", description: "Controlli e ricerche attivi, ultimo giro" },
  { command: "date", description: "Controlla adesso e mostra le date" },
  { command: "stop", description: "Ferma un controllo o una ricerca e cancella i dati" },
  { command: "aiuto", description: "Come si usa" },
  { command: "id", description: "Il tuo ID Telegram" },
];

/** Compatibilità: la lettura dei dati di /avvia e /cerca. */
export const leggiAvvia = leggiDatiRicetta;

export async function gestisciAggiornamento(update: any, ctx: ContestoBot): Promise<void> {
  if (update?.callback_query) return pulsante(update.callback_query, ctx);
  const msg = update?.message;
  const testo: string | undefined = msg?.text;
  if (!msg || !testo) return;
  const chatId = String(msg.chat.id);
  const utenteId = String(msg.from?.id ?? "");

  if (!testo.startsWith("/")) {
    // Testo libero: serve solo alla procedura di /cerca (periodo o orario scritti a mano).
    if (ctx.utenti.has(utenteId)) {
      const usato = await gestisciTesto(testo, chatId, utenteId, ctx);
      if (!usato) await ctx.tg.manda(chatId, "Scrivi /aiuto per vedere i comandi.");
    }
    return;
  }

  const [primo, ...argomenti] = testo.trim().split(/\s+/);
  const comando = primo.slice(1).split("@")[0].toLowerCase();

  // I messaggi di /avvia e /cerca contengono i dati sanitari: si cancellano prima di tutto, anche se l'utente
  // non è ammesso.
  if (comando === "avvia" || comando === "cerca") await ctx.tg.cancella(chatId, msg.message_id);

  if (comando === "id") {
    await ctx.tg.manda(chatId, `Il tuo ID Telegram: <code>${html(utenteId)}</code>\nID di questa chat: <code>${html(chatId)}</code>`);
    return;
  }
  if (!ctx.utenti.has(utenteId)) {
    await ctx.tg.manda(chatId, "⛔ Non sei abilitato a usare questo bot. Il tuo ID (da mettere in TELEGRAM_UTENTI) si vede con /id.");
    return;
  }

  switch (comando) {
    case "start":
    case "aiuto":
    case "help":
      await ctx.tg.manda(chatId, AIUTO);
      return;
    case "avvia":
      return avvia(argomenti, chatId, utenteId, ctx);
    case "cerca":
      return avviaCerca(argomenti, chatId, utenteId, ctx);
    case "stato":
    case "lista":
      return stato(chatId, utenteId, ctx);
    case "date":
      return date(argomenti, chatId, utenteId, ctx);
    case "stop":
      return stop(argomenti, chatId, utenteId, ctx);
    default:
      await ctx.tg.manda(chatId, `Comando sconosciuto. ${AIUTO}`);
  }
}

async function pulsante(q: any, ctx: ContestoBot) {
  const utenteId = String(q.from?.id ?? "");
  if (!ctx.utenti.has(utenteId)) {
    await ctx.tg.rispondiPulsante(q.id, "Non sei abilitato");
    return;
  }
  if (String(q.data ?? "").startsWith("c:")) return gestisciPulsante(q, utenteId, ctx);
  await ctx.tg.rispondiPulsante(q.id);
}

async function avvia(argomenti: string[], chatId: string, utenteId: string, ctx: ContestoBot) {
  const a = leggiDatiRicetta(argomenti);
  if (!a.ok) {
    await ctx.tg.manda(chatId, `❌ ${a.errore}\nHo cancellato il messaggio. Riprova: <code>/avvia CODICEFISCALE CIFRE NRE</code>`);
    return;
  }
  await ctx.tg.manda(chatId, "🔒 Ho cancellato il messaggio con i tuoi dati. ⏳ Controllo la ricetta su PrenotaSalute (fino a un minuto)…");

  const dati = { codiceFiscale: a.codiceFiscale, cifre: a.cifre, nre: a.nre };
  let r;
  try {
    r = await (ctx.giro ?? giroSito)(dati, { tipo: a.tipo });
  } catch (e) {
    const testo =
      e instanceof ErroreUtente
        ? e.message
        : e instanceof InCoda
          ? "Il sito ha la sala d'attesa attiva, riprova tra qualche minuto."
          : "Il sito non ha risposto come previsto, riprova tra qualche minuto.";
    if (!(e instanceof ErroreUtente)) console.error(JSON.stringify({ avvia: (e as Error).message.slice(0, 200) }));
    await ctx.tg.manda(chatId, `❌ ${html(testo)}\nNon ho salvato nulla.`);
    return;
  }
  if (!r.appuntamento) {
    await ctx.tg.manda(
      chatId,
      "❌ Questa ricetta non ha un appuntamento futuro da anticipare. Per cercare una data usa /cerca. Non ho salvato nulla.",
    );
    return;
  }

  // Un nuovo /avvia con lo stesso NRE sostituisce il controllo di prima (non le ricerche).
  for (const c of await leggiControlli(ctx.db, ctx.chiave, utenteId)) {
    if (c.modalita === "anticipa" && c.dati.nre === dati.nre) await cancellaControllo(ctx.db, c.id);
  }
  const anticipate = dateAnticipate(r.appuntamento, r.date);
  const primaData = r.date.find((d) => d.presidio.codice === r.appuntamento!.presidio.codice) ?? null;
  const id = await nuovoControllo(ctx.db, ctx.chiave, {
    modalita: "anticipa",
    chatId,
    utenteId,
    dati,
    tipo: r.tipo,
    contesto: { appuntamento: r.appuntamento, zona: r.zona, notificate: anticipate.map(chiaveData), anticipate, primaData },
  });

  const righe = [
    `✅ <b>Controllo #${id} avviato</b>`,
    "",
    descriviAppuntamento(r.appuntamento),
    `Tipo: ${formatoTipo(r.tipo as Tipo)}${a.tipo ? "" : " (trovato in automatico)"}`,
    "",
    anticipate.length > 0
      ? `Ci sono già ${anticipate.length} date libere prima: te le mando qui sotto.`
      : `Per ora nessuna data libera prima della tua.${primaData ? ` La prima libera nella struttura è ${formatoData(primaData.data)}.` : ""}`,
    "Ricontrollo ogni 15 minuti di giorno (ogni ora di notte) e ti scrivo solo quando compare una data nuova prima della tua.",
  ];
  await ctx.tg.manda(chatId, righe.join("\n"));
  if (anticipate.length > 0)
    await ctx.tg.manda(chatId, messaggioAnticipate(id, r.appuntamento, anticipate, new Set(anticipate.map(chiaveData))));
}

/**
 * Minuti oltre i quali il cron è in ritardo (🟠) o fermo (🔴). Di giorno (7-24) gira ogni 15 minuti, di notte
 * (0-7) ogni 60: vedi README.
 */
export function sogliaCron(ora = new Date()) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Rome", hour: "numeric", hourCycle: "h23" }).format(ora));
  // Fino alle 7:20 vale ancora l'ultimo giro notturno (alle 6:00, poi il primo del giorno alle 7:00).
  const notte = h < 7 || (h === 7 && Number(ora.toISOString().slice(14, 16)) < 20);
  return notte ? { giallo: 75, rosso: 130 } : { giallo: 25, rosso: 60 };
}

function quando(iso: string | null) {
  if (!iso) return "mai";
  return new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });
}

function descriviControllo(c: Controllo): string[] {
  const ultimo = `Ultimo controllo: ${quando(c.ultimoControllo)} → ${html(c.ultimoEsito ?? "-")}`;
  if (c.modalita === "cerca") {
    const prima = c.contesto.risultati[0];
    return [
      `<b>#${c.id}</b> 🔎 Ricerca: ${html(c.contesto.prestazione)}`,
      descriviFiltri(c.contesto.filtri),
      `Prima data trovata: ${prima ? `${formatoData(prima.data)}, ${html(prima.presidio.descrizione)}` : "nessuna"}`,
      ultimo,
    ];
  }
  const a = c.contesto.appuntamento;
  return [
    `<b>#${c.id}</b> ⏪ Anticipo: ${html(a.prestazione)}`,
    `🏥 ${html(a.presidio.descrizione)}`,
    `📅 Il tuo: ${formatoData(a.data)}`,
    `🔎 Prima libera nella struttura: ${c.contesto.primaData ? formatoData(c.contesto.primaData.data) : "nessuna"}`,
    `Date anticipate al momento: ${c.contesto.notificate.length}`,
    ultimo,
  ];
}

async function stato(chatId: string, utenteId: string, ctx: ContestoBot) {
  const controlli = await leggiControlli(ctx.db, ctx.chiave, utenteId);
  const cron = await leggiStato(ctx.db, "ultimo_giro");
  const minuti = cron ? Math.round((Date.now() - Date.parse(cron.aggiornato)) / 60_000) : null;
  const { giallo, rosso } = sogliaCron();
  const semaforo = minuti === null ? "🔴" : minuti > rosso ? "🔴" : minuti > giallo ? "🟠" : "🟢";
  const righe = [`${semaforo} Ultimo giro del cron: ${cron ? `${quando(cron.aggiornato)} (${minuti} min fa)` : "mai"}`];
  if (controlli.length === 0) righe.push("", "Nessun controllo attivo. /avvia per anticipare una visita prenotata, /cerca per cercarne una.");
  for (const c of controlli) righe.push("", ...descriviControllo(c));
  await ctx.tg.manda(chatId, righe.join("\n"));
}

async function scegli(argomenti: string[], chatId: string, utenteId: string, ctx: ContestoBot, comando: string) {
  const controlli = await leggiControlli(ctx.db, ctx.chiave, utenteId);
  if (controlli.length === 0) {
    await ctx.tg.manda(chatId, "Nessun controllo attivo.");
    return null;
  }
  if (argomenti[0] === undefined && controlli.length === 1) return controlli[0];
  const n = Number(String(argomenti[0] ?? "").replace("#", ""));
  const c = controlli.find((x) => x.id === n);
  if (!c) await ctx.tg.manda(chatId, `Quale? <code>/${comando} N</code> con N tra: ${controlli.map((x) => `#${x.id}`).join(", ")}`);
  return c ?? null;
}

async function date(argomenti: string[], chatId: string, utenteId: string, ctx: ContestoBot) {
  const c = await scegli(argomenti, chatId, utenteId, ctx, "date");
  if (!c) return;
  await ctx.tg.manda(chatId, `⏳ Controllo #${c.id} su PrenotaSalute…`);
  // Lo stesso giro del cron (aggiorna anche le date già notificate), poi le date aggiornate.
  const esito = await controllaUno(c, ctx);
  const aggiornato = (await leggiControlli(ctx.db, ctx.chiave, utenteId)).find((x) => x.id === c.id);
  if (!aggiornato) return; // finito: controllaUno ha già avvisato
  if (esito === "errore" || esito === "coda") {
    await ctx.tg.manda(chatId, `❌ Non sono riuscito a leggere il sito: ${html(aggiornato.ultimoEsito ?? "")}`);
    return;
  }
  if (esito === "notificato") return; // il messaggio con le date è appena partito

  if (aggiornato.modalita === "cerca") {
    const k = aggiornato.contesto;
    await ctx.tg.manda(chatId, messaggioRisultati(aggiornato.id, k.prestazione, k.filtri, k.risultati));
    return;
  }
  const { appuntamento, anticipate, primaData } = aggiornato.contesto;
  if (anticipate.length > 0) {
    await ctx.tg.manda(chatId, messaggioAnticipate(c.id, appuntamento, anticipate, new Set()));
    return;
  }
  await ctx.tg.manda(
    chatId,
    [
      descriviAppuntamento(appuntamento),
      "",
      "Nessuna data libera prima della tua.",
      primaData ? `Prima data libera nella struttura: ${formatoData(primaData.data)}` : "",
    ]
      .filter((x) => x !== "")
      .join("\n"),
  );
}

async function stop(argomenti: string[], chatId: string, utenteId: string, ctx: ContestoBot) {
  const c = await scegli(argomenti, chatId, utenteId, ctx, "stop");
  if (!c) return;
  await cancellaControllo(ctx.db, c.id);
  const cosa = c.modalita === "cerca" ? "Ricerca" : "Controllo";
  const fermo = c.modalita === "cerca" ? "fermata" : "fermato";
  await ctx.tg.manda(chatId, `⏹ ${cosa} #${c.id} ${fermo}. Ho cancellato i suoi dati (codice fiscale, tessera, ricetta).`);
}
