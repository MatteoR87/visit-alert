// /anticipa: dopo il primo giro (o dopo una prenotazione, con "🔎 Cerca date migliori") il bot mostra le date
// prima dell'appuntamento e le strutture delle province scelte (all'inizio quella dell'appuntamento), con la sua
// struttura già scelta:
//   "▫️/✅ struttura" (a:<id>:<presidio>) → scegli/togli;
//   "📍 Cambia provincia" (az:<id>) → le zone del sito da accendere/spegnere (azz:<id>:<zona>, al massimo 4),
//     "🔎 Cerca qui" (azok:<id>) → un giro nelle zone scelte e di nuovo le strutture; "↩️ Indietro" (azx:<id>);
//   "✅ Avvia il controllo" (m:<id>) → il cron lo ripete; "✖️ Annulla" (mx:<id>) → dati cancellati.
// Finché non si tocca ✅ il controllo non è monitorato. Per tenere tutto com'è basta ✅ subito.
import type { Client } from "@libsql/client";
import { dateAnticipate, ErroreUtente, giroSito, strutture, type Zona } from "./controllo.js";
import {
  aggiornaControllo,
  cancellaControllo,
  leggiControlli,
  presidiDi,
  zoneDi,
  type ControlloAnticipa,
} from "./db.js";
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
/** Ogni zona è una ricerca in più a ogni giro del cron. */
export const MAX_ZONE_ANTICIPA = 4;

export type ContestoAnticipa = {
  db: Client;
  chiave: Buffer;
  tg: Pick<Telegram, "manda" | "modifica" | "rispondiPulsante">;
  giro?: GiroSito;
};

const nomiZone = (zone: Zona[]) => zone.map((z) => html(nomeZona(z))).join(", ") || "la provincia dell'appuntamento";

/** Testo e pulsanti della scelta delle strutture (con le date anticipate e i 📅 per prenotarle). */
export function schermataAnticipa(c: ControlloAnticipa): { testo: string; tastiera: Tastiera } {
  const k = c.contesto;
  if (k.zoneInScelta) return schermataZone(c);
  const scelte = presidiDi(k);
  const anticipate = dateAnticipate(k.appuntamento, k.dateZona ?? k.anticipate, scelte);
  // Le strutture con date, più quelle scelte (anche senza date, per poterle togliere).
  const sceltePresidi = k.presidi && k.presidi.length > 0 ? k.presidi : [k.appuntamento.presidio];
  const elenco = strutture(k.dateZona ?? [], sceltePresidi);
  const righe = [
    `⏪ <b>Anticipare l'appuntamento</b> (controllo #${c.id})`,
    "",
    descriviAppuntamento(k.appuntamento),
    "",
    anticipate.length > 0
      ? `Date libere prima della tua nelle strutture scelte (${anticipate.length}):\n${elencoDate(anticipate, k.appuntamento)}`
      : "Per ora nessuna data libera prima della tua nelle strutture scelte.",
    "",
    `📍 Province: ${nomiZone(zoneDi(k))}`,
    `🏥 <b>In quali strutture?</b> Quelle con date in queste province${elenco.length > MAX_STRUTTURE_MOSTRATE ? ` (le prime ${MAX_STRUTTURE_MOSTRATE})` : ""}: toccale per sceglierle o toglierle (al massimo ${MAX_STRUTTURE_ANTICIPA}). Per cercare altrove: <b>📍 Cambia provincia</b>.`,
    `Per tenere ${scelte.length === 1 ? "la struttura scelta" : "le strutture scelte"} tocca subito <b>✅ Avvia il controllo</b>: da lì ricontrollo ogni 15 minuti di giorno (ogni ora di notte) e ti avviso quando si libera una data prima della tua.`,
    "Con 📅 prenoti subito una delle date qui sopra (ti chiedo conferma).",
  ];
  const tastiera: Tastiera = [
    ...tastieraPrenota(c.id, anticipate),
    ...tastieraStrutture(elenco, scelte, (codice) => `a:${c.id}:${codice}`),
    [{ text: "📍 Cambia provincia", callback_data: `az:${c.id}` }],
    [{ text: "✅ Avvia il controllo", callback_data: `m:${c.id}` }],
    [{ text: "✖️ Annulla", callback_data: `mx:${c.id}` }],
  ];
  return { testo: righe.join("\n"), tastiera };
}

/** La scelta delle province (zone del sito). */
function schermataZone(c: ControlloAnticipa): { testo: string; tastiera: Tastiera } {
  const k = c.contesto;
  const scelte = k.zoneInScelta ?? [];
  const pulsanti = (k.zoneSito ?? []).map((z) => ({
    text: `${scelte.includes(String(z.codice)) ? "✅ " : ""}${nomeZona(z)}`,
    callback_data: `azz:${c.id}:${z.codice}`,
  }));
  const tastiera: Tastiera = [];
  for (let i = 0; i < pulsanti.length; i += 2) tastiera.push(pulsanti.slice(i, i + 2));
  tastiera.push([{ text: `🔎 Cerca qui (${scelte.length}/${MAX_ZONE_ANTICIPA})`, callback_data: `azok:${c.id}` }]);
  tastiera.push([{ text: "↩️ Indietro", callback_data: `azx:${c.id}` }]);
  return {
    testo: [
      `⏪ <b>Anticipare l'appuntamento</b> (controllo #${c.id})`,
      "",
      descriviAppuntamento(k.appuntamento),
      "",
      `📍 <b>In quali province cerco?</b> Tocca le zone (al massimo ${MAX_ZONE_ANTICIPA}; Milano città e Milano provincia sono diverse), poi <b>🔎 Cerca qui</b>: cerco le date e ti mostro le strutture. Ogni zona in più rende ogni giro un po' più lungo.`,
    ].join("\n"),
    tastiera,
  };
}

async function controlloDi(utenteId: string, id: number, ctx: ContestoAnticipa): Promise<ControlloAnticipa | null> {
  const c = (await leggiControlli(ctx.db, ctx.chiave, utenteId)).find((x) => x.id === id);
  return c && c.modalita === "anticipa" ? c : null;
}

async function salvaEMostra(c: ControlloAnticipa, chatId: string, messaggio: number, ctx: ContestoAnticipa) {
  await aggiornaControllo(ctx.db, ctx.chiave, c);
  const s = schermataAnticipa(c);
  await ctx.tg.modifica(chatId, messaggio, s.testo, s.tastiera);
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
    if (scelte.length === 1)
      return ctx.tg.rispondiPulsante(q.id, "È l'unica scelta: tocca prima un'altra struttura, oppure 📍 Cambia provincia");
    scelte = scelte.filter((x) => x !== codice);
  } else {
    if (scelte.length >= MAX_STRUTTURE_ANTICIPA) return ctx.tg.rispondiPulsante(q.id, `Al massimo ${MAX_STRUTTURE_ANTICIPA} strutture`);
    scelte = [...scelte, codice];
  }
  const noti = strutture(k.dateZona ?? [], [k.appuntamento.presidio, ...(k.presidi ?? [])]).map((s) => s.presidio);
  const presidi = scelte.map((x) => noti.find((p) => p.codice === x)).filter((p): p is NonNullable<typeof p> => !!p);
  const anticipate = dateAnticipate(k.appuntamento, k.dateZona ?? k.anticipate, presidi.map((p) => p.codice));
  await ctx.tg.rispondiPulsante(q.id);
  await salvaEMostra({ ...c, contesto: { ...k, presidi, anticipate } }, chatId, messaggio, ctx);
}

/**
 * "📍 Cambia provincia" (az:), una zona (azz:<id>:<zona>), "🔎 Cerca qui" (azok:), "↩️ Indietro" (azx:).
 */
export async function gestisciZone(q: any, utenteId: string, ctx: ContestoAnticipa) {
  const [azione, n, codice] = String(q.data ?? "").split(":");
  const chatId = String(q.message?.chat?.id ?? "");
  const messaggio = Number(q.message?.message_id ?? 0);
  const c = await controlloDi(utenteId, Number(n), ctx);
  if (!c) return ctx.tg.rispondiPulsante(q.id, "Questo controllo non c'è più: rifai /anticipa");
  const k = c.contesto;

  if (azione === "az") {
    if (!k.zoneSito || k.zoneSito.length === 0) {
      // Controllo senza l'elenco delle zone (per esempio di una versione precedente): lo si legge con un giro.
      await ctx.tg.rispondiPulsante(q.id, "Leggo le province dal sito…");
      const r = await giro(c, ctx, chatId, { elencoZone: true });
      if (!r) return;
      return salvaEMostra({ ...r, contesto: { ...r.contesto, zoneInScelta: zoneDi(r.contesto).map((z) => String(z.codice)) } }, chatId, messaggio, ctx);
    }
    await ctx.tg.rispondiPulsante(q.id);
    return salvaEMostra({ ...c, contesto: { ...k, zoneInScelta: zoneDi(k).map((z) => String(z.codice)) } }, chatId, messaggio, ctx);
  }
  if (azione === "azx") {
    await ctx.tg.rispondiPulsante(q.id);
    return salvaEMostra({ ...c, contesto: { ...k, zoneInScelta: undefined } }, chatId, messaggio, ctx);
  }
  if (!k.zoneInScelta) return ctx.tg.rispondiPulsante(q.id);
  if (azione === "azz") {
    let scelte = k.zoneInScelta;
    if (scelte.includes(codice)) scelte = scelte.filter((x) => x !== codice);
    else if (scelte.length >= MAX_ZONE_ANTICIPA) return ctx.tg.rispondiPulsante(q.id, `Al massimo ${MAX_ZONE_ANTICIPA} province`);
    else if ((k.zoneSito ?? []).some((z) => z.codice === codice)) scelte = [...scelte, codice];
    await ctx.tg.rispondiPulsante(q.id);
    return salvaEMostra({ ...c, contesto: { ...k, zoneInScelta: scelte } }, chatId, messaggio, ctx);
  }
  if (azione === "azok") {
    const zone = k.zoneInScelta.map((x) => (k.zoneSito ?? []).find((z) => z.codice === x)).filter((z): z is Zona => !!z);
    if (zone.length === 0) return ctx.tg.rispondiPulsante(q.id, "Scegli almeno una provincia");
    await ctx.tg.rispondiPulsante(q.id);
    await ctx.tg.modifica(chatId, messaggio, `⏳ Cerco le date in ${nomiZone(zone)} (qualche secondo per zona)…`);
    const r = await giro({ ...c, contesto: { ...k, zone } }, ctx, chatId);
    if (!r) {
      // Rimane la scelta delle province, per riprovare.
      return salvaEMostra(c, chatId, messaggio, ctx);
    }
    // Le strutture scelte prima restano solo se hanno date nelle province nuove (se non ne resta nessuna vale
    // quella dell'appuntamento, che si toglie scegliendone un'altra).
    const date = r.contesto.dateZona ?? [];
    const presidi = (r.contesto.presidi ?? []).filter((p) => date.some((d) => d.presidio.codice === p.codice));
    const k2 = { ...r.contesto, presidi, zoneInScelta: undefined };
    const anticipate = dateAnticipate(k2.appuntamento, date, presidiDi(k2));
    return salvaEMostra({ ...r, contesto: { ...k2, anticipate } }, chatId, messaggio, ctx);
  }
  await ctx.tg.rispondiPulsante(q.id);
}

/** Un giro per il controllo (nelle sue zone): aggiorna appuntamento, date, strutture; null se non è andato. */
async function giro(
  c: ControlloAnticipa,
  ctx: ContestoAnticipa,
  chatId: string,
  opz: { elencoZone?: boolean } = {},
): Promise<ControlloAnticipa | null> {
  let r;
  try {
    r = await (ctx.giro ?? giroSito)(c.dati, { tipo: c.tipo, zona: c.contesto.zona, zone: c.contesto.zone, elencoZone: opz.elencoZone ?? !c.contesto.zoneSito });
  } catch (e) {
    const testo =
      e instanceof ErroreUtente ? e.message : e instanceof InCoda ? "Il sito ha la sala d'attesa attiva, riprova tra qualche minuto." : "Il sito non ha risposto come previsto, riprova tra qualche minuto.";
    if (!(e instanceof ErroreUtente || e instanceof InCoda)) console.error(JSON.stringify({ anticipa: (e as Error).message.slice(0, 200) }));
    await ctx.tg.manda(chatId, `❌ ${html(testo)}`);
    return null;
  }
  if (!r.appuntamento) {
    await cancellaControllo(ctx.db, c.id);
    await ctx.tg.manda(chatId, "ℹ️ La ricetta non ha più un appuntamento futuro. Ho cancellato i dati del controllo.");
    return null;
  }
  const k = {
    ...c.contesto,
    appuntamento: r.appuntamento,
    zona: r.zona,
    dateZona: r.date,
    zoneSito: r.zoneSito ?? c.contesto.zoneSito,
  };
  const anticipate = dateAnticipate(r.appuntamento, r.date, presidiDi(k));
  return { ...c, tipo: r.tipo, contesto: { ...k, anticipate, proposte: salvaProposte(r.proposte, r.date) } };
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
  const nuovo = await giro(c, ctx, chatId, { elencoZone: true });
  if (!nuovo) return;
  await aggiornaControllo(ctx.db, ctx.chiave, nuovo);
  const s = schermataAnticipa(nuovo);
  await ctx.tg.manda(chatId, s.testo, s.tastiera);
}
