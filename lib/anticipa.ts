// /anticipa: dopo il primo giro (o dopo una prenotazione, con "🔎 Cerca date migliori") il bot mostra le date
// prima dell'appuntamento e le strutture della provincia, con quella dell'appuntamento già scelta:
//   "▫️/✅ struttura" (a:<id>:<presidio>) → scegli/togli; "✅ Avvia il controllo" (m:<id>) → il cron lo ripete;
//   "✖️ Annulla" (mx:<id>) → dati cancellati. Finché non si tocca ✅ il controllo non è monitorato.
import type { Client } from "@libsql/client";
import { dateAnticipate, ErroreUtente, giroSito, strutture } from "./controllo.js";
import { aggiornaControllo, cancellaControllo, leggiControlli, presidiDi, type ControlloAnticipa } from "./db.js";
import {
  descriviAppuntamento,
  elencoDate,
  formatoData,
  MAX_STRUTTURE_MOSTRATE,
  nomeZona,
  tastieraPrenota,
  tastieraStrutture,
} from "./messaggi.js";
import { salvaProposte, type GiroSito } from "./monitor.js";
import { InCoda } from "./prenota.js";
import { html, type Tastiera, type Telegram } from "./telegram.js";

export const MAX_STRUTTURE_ANTICIPA = 10;

export type ContestoAnticipa = {
  db: Client;
  chiave: Buffer;
  tg: Pick<Telegram, "manda" | "modifica" | "rispondiPulsante">;
  giro?: GiroSito;
};

/** Testo e pulsanti della scelta delle strutture (con le date anticipate e i 📅 per prenotarle). */
export function schermataAnticipa(c: ControlloAnticipa): { testo: string; tastiera: Tastiera } {
  const k = c.contesto;
  const scelte = presidiDi(k);
  const anticipate = dateAnticipate(k.appuntamento, k.dateZona ?? k.anticipate, scelte);
  const elenco = strutture(k.dateZona ?? [], [k.appuntamento.presidio]);
  const righe = [
    `⏪ <b>Anticipare l'appuntamento</b> (controllo #${c.id})`,
    "",
    descriviAppuntamento(k.appuntamento),
    "",
    anticipate.length > 0
      ? `Date libere prima della tua nelle strutture scelte (${anticipate.length}):\n${elencoDate(anticipate, k.appuntamento)}`
      : "Per ora nessuna data libera prima della tua nelle strutture scelte.",
    "",
    `🏥 <b>In quali strutture?</b> Quelle ${k.zona ? `della zona ${html(nomeZona(k.zona))}` : "della provincia"} con date${elenco.length > MAX_STRUTTURE_MOSTRATE ? ` (le prime ${MAX_STRUTTURE_MOSTRATE})` : ""}; la tua è già scelta. Toccane altre (al massimo ${MAX_STRUTTURE_ANTICIPA}), poi <b>✅ Avvia il controllo</b>: da lì ricontrollo ogni 15 minuti di giorno (ogni ora di notte) e ti avviso quando si libera una data prima della tua.`,
    "Con 📅 prenoti subito una delle date qui sopra (ti chiedo conferma).",
  ];
  const tastiera: Tastiera = [
    ...tastieraPrenota(c.id, anticipate),
    ...tastieraStrutture(elenco, scelte, (codice) => `a:${c.id}:${codice}`),
    [{ text: "✅ Avvia il controllo", callback_data: `m:${c.id}` }],
    [{ text: "✖️ Annulla", callback_data: `mx:${c.id}` }],
  ];
  return { testo: righe.join("\n"), tastiera };
}

async function controlloDi(utenteId: string, id: number, ctx: ContestoAnticipa): Promise<ControlloAnticipa | null> {
  const c = (await leggiControlli(ctx.db, ctx.chiave, utenteId)).find((x) => x.id === id);
  return c && c.modalita === "anticipa" ? c : null;
}

/** "▫️/✅ struttura" (a:<id>:<presidio>): la sceglie o la toglie e aggiorna le date. */
export async function toccaStruttura(q: any, utenteId: string, ctx: ContestoAnticipa) {
  const [, n, codice] = String(q.data ?? "").split(":");
  const chatId = String(q.message?.chat?.id ?? "");
  const messaggio = Number(q.message?.message_id ?? 0);
  const c = await controlloDi(utenteId, Number(n), ctx);
  if (!c) return ctx.tg.rispondiPulsante(q.id, "Questo controllo non c'è più: rifai /anticipa");
  const k = c.contesto;
  let scelte = presidiDi(k);
  if (scelte.includes(codice)) {
    if (scelte.length === 1) return ctx.tg.rispondiPulsante(q.id, "Serve almeno una struttura");
    scelte = scelte.filter((x) => x !== codice);
  } else {
    if (scelte.length >= MAX_STRUTTURE_ANTICIPA) return ctx.tg.rispondiPulsante(q.id, `Al massimo ${MAX_STRUTTURE_ANTICIPA} strutture`);
    scelte = [...scelte, codice];
  }
  const noti = strutture(k.dateZona ?? [], [k.appuntamento.presidio]).map((s) => s.presidio);
  const presidi = scelte.map((x) => noti.find((p) => p.codice === x)).filter((p): p is NonNullable<typeof p> => !!p);
  const anticipate = dateAnticipate(k.appuntamento, k.dateZona ?? k.anticipate, presidi.map((p) => p.codice));
  const nuovo: ControlloAnticipa = { ...c, contesto: { ...k, presidi, anticipate } };
  await aggiornaControllo(ctx.db, ctx.chiave, nuovo);
  await ctx.tg.rispondiPulsante(q.id);
  const s = schermataAnticipa(nuovo);
  await ctx.tg.modifica(chatId, messaggio, s.testo, s.tastiera);
}

/**
 * "🔎 Cerca date migliori" (ap:<id>) dopo una prenotazione: un giro adesso, poi la scelta delle strutture con le
 * date anticipate (e i 📅). Il cron parte solo con ✅ Avvia il controllo.
 */
export async function cercaMigliori(q: any, utenteId: string, ctx: ContestoAnticipa) {
  const [, n] = String(q.data ?? "").split(":");
  const chatId = String(q.message?.chat?.id ?? "");
  const c = await controlloDi(utenteId, Number(n), ctx);
  if (!c) return ctx.tg.rispondiPulsante(q.id, "Questo controllo non c'è più: usa /anticipa");
  await ctx.tg.rispondiPulsante(q.id);
  await ctx.tg.manda(chatId, `⏳ Cerco date prima del ${formatoData(c.contesto.appuntamento.data)}…`);
  let r;
  try {
    r = await (ctx.giro ?? giroSito)(c.dati, { tipo: c.tipo, zona: c.contesto.zona });
  } catch (e) {
    const testo =
      e instanceof ErroreUtente ? e.message : e instanceof InCoda ? "Il sito ha la sala d'attesa attiva, riprova tra qualche minuto." : "Il sito non ha risposto come previsto, riprova tra qualche minuto.";
    await ctx.tg.manda(chatId, `❌ ${html(testo)}`);
    return;
  }
  if (!r.appuntamento) {
    await cancellaControllo(ctx.db, c.id);
    await ctx.tg.manda(chatId, "ℹ️ La ricetta non ha più un appuntamento futuro. Ho cancellato i dati del controllo.");
    return;
  }
  const k = { ...c.contesto, appuntamento: r.appuntamento, zona: r.zona, dateZona: r.date };
  const anticipate = dateAnticipate(r.appuntamento, r.date, presidiDi(k));
  const nuovo: ControlloAnticipa = {
    ...c,
    tipo: r.tipo,
    contesto: { ...k, anticipate, proposte: salvaProposte(r.proposte, r.date) },
  };
  await aggiornaControllo(ctx.db, ctx.chiave, nuovo);
  const s = schermataAnticipa(nuovo);
  await ctx.tg.manda(chatId, s.testo, s.tastiera);
}
