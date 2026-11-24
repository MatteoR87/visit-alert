// Comandi del bot Telegram (vedi README e AIUTO in messaggi.ts).
import type { Client } from "@libsql/client";
import { chiaveData, dateAnticipate, ErroreUtente, giroSito, normalizzaNre, type Tipo } from "./controllo.js";
import { cancellaControllo, leggiControlli, leggiStato, nuovoControllo } from "./db.js";
import { AIUTO, descriviAppuntamento, formatoData, formatoTipo, messaggioAnticipate } from "./messaggi.js";
import { controllaUno, type GiroSito } from "./monitor.js";
import { InCoda } from "./prenota.js";
import { html, type Telegram } from "./telegram.js";

export type ContestoBot = {
  db: Client;
  chiave: Buffer;
  utenti: Set<string>;
  tg: Pick<Telegram, "manda" | "cancella">;
  giro?: GiroSito;
};

export const COMANDI = [
  { command: "avvia", description: "Avvia un controllo: /avvia CODICEFISCALE CIFRE NRE" },
  { command: "stato", description: "Controlli attivi e ultimo giro" },
  { command: "date", description: "Controlla adesso e mostra le date libere" },
  { command: "stop", description: "Ferma un controllo e cancella i suoi dati" },
  { command: "aiuto", description: "Come si usa" },
  { command: "id", description: "Il tuo ID Telegram" },
];

const RE_CF = /^[A-Z0-9]{16}$/;
const RE_CIFRE = /^\d{5}$/;
const RE_NRE = /^[0-9A-Z]{15}$/;

export function leggiAvvia(argomenti: string[]):
  | { ok: true; codiceFiscale: string; cifre: string; nre: string; tipo: Tipo | null }
  | { ok: false; errore: string } {
  if (argomenti.length < 3 || argomenti.length > 4)
    return { ok: false, errore: "Servono codice fiscale, ultime 5 cifre della tessera e numero di ricetta (NRE)." };
  const codiceFiscale = argomenti[0].toUpperCase();
  const cifre = argomenti[1];
  const nre = normalizzaNre(argomenti[2]);
  const tipo = argomenti[3]?.toUpperCase() ?? null;
  if (!RE_CF.test(codiceFiscale)) return { ok: false, errore: "Il codice fiscale deve avere 16 caratteri." };
  if (!RE_CIFRE.test(cifre)) return { ok: false, errore: "Le cifre della tessera devono essere le ultime 5, solo numeri." };
  if (!RE_NRE.test(nre)) return { ok: false, errore: "Il numero di ricetta (NRE) deve avere 15 caratteri, per esempio 030A01234567890." };
  if (tipo !== null && tipo !== "O" && tipo !== "Z") return { ok: false, errore: "In fondo si può aggiungere solo O (prima visita) o Z (controllo)." };
  return { ok: true, codiceFiscale, cifre, nre, tipo: tipo as Tipo | null };
}

export async function gestisciAggiornamento(update: any, ctx: ContestoBot): Promise<void> {
  const msg = update?.message;
  const testo: string | undefined = msg?.text;
  if (!msg || !testo?.startsWith("/")) return;
  const chatId = String(msg.chat.id);
  const utenteId = String(msg.from?.id ?? "");
  const [primo, ...argomenti] = testo.trim().split(/\s+/);
  const comando = primo.slice(1).split("@")[0].toLowerCase();

  // Il messaggio di /avvia contiene i dati sanitari: si cancella prima di tutto, anche se l'utente non è ammesso.
  if (comando === "avvia") await ctx.tg.cancella(chatId, msg.message_id);

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
      return ctx.tg.manda(chatId, AIUTO);
    case "avvia":
      return avvia(argomenti, chatId, utenteId, ctx);
    case "stato":
    case "lista":
      return stato(chatId, utenteId, ctx);
    case "date":
      return date(argomenti, chatId, utenteId, ctx);
    case "stop":
      return stop(argomenti, chatId, utenteId, ctx);
    default:
      return ctx.tg.manda(chatId, `Comando sconosciuto. ${AIUTO}`);
  }
}

async function avvia(argomenti: string[], chatId: string, utenteId: string, ctx: ContestoBot) {
  const a = leggiAvvia(argomenti);
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
    await ctx.tg.manda(chatId, "❌ Questa ricetta non ha un appuntamento futuro da anticipare. Non ho salvato nulla.");
    return;
  }

  // Una ricetta per utente: un nuovo /avvia con lo stesso NRE sostituisce quello di prima.
  for (const c of await leggiControlli(ctx.db, ctx.chiave, utenteId)) {
    if (c.dati.nre === dati.nre) await cancellaControllo(ctx.db, c.id);
  }
  const anticipate = dateAnticipate(r.appuntamento, r.date);
  const primaData = r.date.find((d) => d.presidio.codice === r.appuntamento!.presidio.codice) ?? null;
  const id = await nuovoControllo(ctx.db, ctx.chiave, {
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
    `Tipo: ${formatoTipo(r.tipo)}${a.tipo ? "" : " (trovato in automatico)"}`,
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

async function stato(chatId: string, utenteId: string, ctx: ContestoBot) {
  const controlli = await leggiControlli(ctx.db, ctx.chiave, utenteId);
  const cron = await leggiStato(ctx.db, "ultimo_giro");
  const minuti = cron ? Math.round((Date.now() - Date.parse(cron.aggiornato)) / 60_000) : null;
  const { giallo, rosso } = sogliaCron();
  const semaforo = minuti === null ? "🔴" : minuti > rosso ? "🔴" : minuti > giallo ? "🟠" : "🟢";
  const righe = [`${semaforo} Ultimo giro del cron: ${cron ? `${quando(cron.aggiornato)} (${minuti} min fa)` : "mai"}`];
  if (controlli.length === 0) righe.push("", "Nessun controllo attivo. Avvialo con /avvia.");
  for (const c of controlli) {
    const a = c.contesto.appuntamento;
    righe.push(
      "",
      `<b>#${c.id}</b> ${html(a.prestazione)}`,
      `🏥 ${html(a.presidio.descrizione)}`,
      `📅 Il tuo: ${formatoData(a.data)}`,
      `🔎 Prima libera nella struttura: ${c.contesto.primaData ? formatoData(c.contesto.primaData.data) : "nessuna"}`,
      `Date anticipate al momento: ${c.contesto.notificate.length}`,
      `Ultimo controllo: ${quando(c.ultimoControllo)} → ${html(c.ultimoEsito ?? "-")}`,
    );
  }
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
  // Lo stesso giro del cron (aggiorna anche le date già notificate), poi tutte le date della struttura.
  const esito = await controllaUno(c, ctx);
  const [aggiornato] = (await leggiControlli(ctx.db, ctx.chiave, utenteId)).filter((x) => x.id === c.id);
  if (!aggiornato) return; // finito: controllaUno ha già avvisato
  if (esito === "errore" || esito === "coda") {
    await ctx.tg.manda(chatId, `❌ Non sono riuscito a leggere il sito: ${html(aggiornato.ultimoEsito ?? "")}`);
    return;
  }
  const { appuntamento, anticipate, primaData } = aggiornato.contesto;
  if (esito === "notificato") return; // il messaggio con tutte le date è appena partito
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
  await ctx.tg.manda(chatId, `⏹ Controllo #${c.id} fermato. Ho cancellato i suoi dati (codice fiscale, tessera, ricetta).`);
}
