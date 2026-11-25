// /cerca: ricerca di una visita nuova, con procedura guidata a pulsanti.
//   /cerca CF CIFRE NRE [O|Z] → (tipo, se non si capisce) → zone → periodo → orario → riepilogo → ✅ Avvia
// La bozza (dati sanitari compresi) sta nel database cifrata e scade dopo un'ora; all'avvio diventa un
// controllo in modalità "cerca", ricontrollato dal cron.
import type { Client } from "@libsql/client";
import {
  anteprimaRicetta,
  cercaNuova,
  chiaveData,
  ErroreUtente,
  oggiRoma,
  type DatiRicetta,
  type Filtri,
  type Tipo,
  type Zona,
} from "./controllo.js";
import { leggiDatiRicetta, leggiOrario, leggiPeriodo, piuGiorni } from "./dati.js";
import { cancellaBozza, leggiBozza, nuovoControllo, scriviBozza } from "./db.js";
import { descriviFiltri, formatoData, formatoTipo, messaggioRisultati, nomeZona, PRIMI_RISULTATI } from "./messaggi.js";
import type { AnteprimaSito, CercaSito } from "./monitor.js";
import { InCoda } from "./prenota.js";
import { html, type Tastiera, type Telegram } from "./telegram.js";

/** Ogni zona è una ricerca sul sito (5-10 secondi): oltre non si va, per il tempo del giro e per il sito. */
export const MAX_ZONE = 4;
const GIORNO_INTERO = { oraDa: 0, oraA: 24 * 60 };

export type ContestoCerca = {
  db: Client;
  chiave: Buffer;
  tg: Pick<Telegram, "manda" | "cancella" | "modifica" | "rispondiPulsante">;
  anteprima?: AnteprimaSito;
  cerca?: CercaSito;
  /** "Adesso", per i test. */
  ora?: () => Date;
};

type Passo = "tipo" | "zone" | "periodo" | "orario" | "conferma";

export type Bozza = {
  dati: DatiRicetta;
  prestazione: string;
  tipo: Tipo | null;
  /** Data dell'appuntamento che la ricetta ha già, se è prenotata. */
  appuntamento: string | null;
  appuntamentoDove: string | null;
  zoneDisponibili: Zona[];
  zone: string[];
  dal: string | null;
  al: string | null;
  oraDa: number;
  oraA: number;
  passo: Passo;
  /** Il messaggio con i pulsanti del passo corrente. */
  messaggio: number;
};

const oggi = (ctx: ContestoCerca) => oggiRoma(ctx.ora?.() ?? new Date());

function erroreSito(e: unknown) {
  if (e instanceof ErroreUtente) return e.message;
  if (e instanceof InCoda) return "Il sito ha la sala d'attesa attiva, riprova tra qualche minuto.";
  console.error(JSON.stringify({ cerca: (e as Error).message.slice(0, 200) }));
  return "Il sito non ha risposto come previsto, riprova tra qualche minuto.";
}

function filtriDi(b: Bozza): Filtri {
  return {
    zone: b.zone.map((c) => b.zoneDisponibili.find((z) => z.codice === c)).filter((z): z is Zona => !!z),
    dal: b.dal,
    al: b.al,
    oraDa: b.oraDa,
    oraA: b.oraA,
  };
}

function intestazione(b: Bozza) {
  const righe = [`🔎 <b>Nuova ricerca</b>: ${html(b.prestazione)}`];
  if (b.tipo) righe.push(`Tipo: ${formatoTipo(b.tipo)}`);
  if (b.appuntamento)
    righe.push(
      `ℹ️ Questa ricetta è già prenotata: ${formatoData(b.appuntamento)}${b.appuntamentoDove ? `, ${html(b.appuntamentoDove)}` : ""}. Cerco comunque, per trovare di meglio.`,
    );
  return righe.join("\n");
}

/** Testo e pulsanti del passo corrente. */
export function schermata(b: Bozza): { testo: string; tastiera: Tastiera } {
  const annulla = { text: "❌ Annulla", callback_data: "c:no" };
  switch (b.passo) {
    case "tipo":
      return {
        testo: `${intestazione(b)}\n\nDalla ricetta non si capisce se è una <b>prima visita</b> o un <b>controllo</b> (il sito lo chiede). Quale?`,
        tastiera: [
          [
            { text: "Prima visita", callback_data: "c:t:O" },
            { text: "Controllo", callback_data: "c:t:Z" },
          ],
          [annulla],
        ],
      };
    case "zone": {
      const pulsanti = b.zoneDisponibili.map((z) => ({
        text: `${b.zone.includes(String(z.codice)) ? "✅ " : ""}${nomeZona(z)}`,
        callback_data: `c:z:${z.codice}`,
      }));
      const righe: Tastiera = [];
      for (let i = 0; i < pulsanti.length; i += 2) righe.push(pulsanti.slice(i, i + 2));
      righe.push([{ text: `Avanti ▶ (${b.zone.length}/${MAX_ZONE})`, callback_data: "c:z:ok" }, annulla]);
      return {
        testo: `${intestazione(b)}\n\n📍 <b>Dove cerco?</b> Tocca le zone (al massimo ${MAX_ZONE}), poi Avanti. Milano città e Milano provincia sono zone diverse.`,
        tastiera: righe,
      };
    }
    case "periodo":
      return {
        testo: `${intestazione(b)}\n\n📆 <b>In che periodo?</b> Scegli, oppure scrivi le date, per esempio <code>01/12/2026-31/01/2027</code> o <code>15/1-28/2</code>.`,
        tastiera: [
          [{ text: "Da subito, senza limite", callback_data: "c:d:0" }],
          [
            { text: "Entro 30 giorni", callback_data: "c:d:30" },
            { text: "Entro 60 giorni", callback_data: "c:d:60" },
          ],
          [
            { text: "Entro 90 giorni", callback_data: "c:d:90" },
            { text: "Entro 6 mesi", callback_data: "c:d:182" },
          ],
          [annulla],
        ],
      };
    case "orario":
      return {
        testo: `${intestazione(b)}\n\n🕘 <b>A che ora?</b> Scegli, oppure scrivi una fascia, per esempio <code>8-12</code> o <code>14:30-18</code>.`,
        tastiera: [
          [{ text: "Tutto il giorno", callback_data: "c:o:tutto" }],
          [
            { text: "Mattina (fino alle 13)", callback_data: "c:o:mattina" },
            { text: "Pomeriggio (dalle 13)", callback_data: "c:o:pomeriggio" },
          ],
          [annulla],
        ],
      };
    case "conferma":
      return {
        testo: `${intestazione(b)}\n\n${descriviFiltri(filtriDi(b))}\n\nTi mostro le prime ${PRIMI_RISULTATI} date e poi ricontrollo ogni 15 minuti di giorno (ogni ora di notte), avvisandoti quando ne compaiono di migliori.`,
        tastiera: [
          [
            { text: "✅ Avvia la ricerca", callback_data: "c:ok" },
            { text: "❌ Annulla", callback_data: "c:no" },
          ],
        ],
      };
  }
}

async function salvaEMostra(b: Bozza, utenteId: string, chatId: string, ctx: ContestoCerca, nuovoMessaggio: boolean) {
  const { testo, tastiera } = schermata(b);
  if (nuovoMessaggio) {
    // Si toglie la tastiera dal messaggio di prima, così non si tocca un passo vecchio.
    if (b.messaggio) await ctx.tg.modifica(chatId, b.messaggio, testo.split("\n")[0]).catch(() => null);
    b.messaggio = await ctx.tg.manda(chatId, testo, tastiera);
  } else {
    await ctx.tg.modifica(chatId, b.messaggio, testo, tastiera);
  }
  await scriviBozza(ctx.db, ctx.chiave, utenteId, chatId, b);
}

/** /cerca CF CIFRE NRE [O|Z] */
export async function avviaCerca(argomenti: string[], chatId: string, utenteId: string, ctx: ContestoCerca) {
  const a = leggiDatiRicetta(argomenti);
  if (!a.ok) {
    await ctx.tg.manda(chatId, `❌ ${a.errore}\nHo cancellato il messaggio. Riprova: <code>/cerca CODICEFISCALE CIFRE NRE</code>`);
    return;
  }
  await ctx.tg.manda(chatId, "🔒 Ho cancellato il messaggio con i tuoi dati. ⏳ Leggo la ricetta su PrenotaSalute…");
  const dati = { codiceFiscale: a.codiceFiscale, cifre: a.cifre, nre: a.nre };
  let ant;
  try {
    ant = await (ctx.anteprima ?? anteprimaRicetta)(dati, {});
  } catch (e) {
    await ctx.tg.manda(chatId, `❌ ${html(erroreSito(e))}\nNon ho salvato nulla.`);
    return;
  }
  const tipo = a.tipo ?? ant.tipo;
  const b: Bozza = {
    dati,
    prestazione: ant.prestazione || "visita",
    tipo,
    appuntamento: ant.appuntamento?.data ?? null,
    appuntamentoDove: ant.appuntamento?.presidio.descrizione ?? null,
    zoneDisponibili: ant.zone,
    zone: [],
    dal: null,
    al: null,
    ...GIORNO_INTERO,
    passo: tipo ? "zone" : "tipo",
    messaggio: 0,
  };
  await salvaEMostra(b, utenteId, chatId, ctx, true);
}

/** Un pulsante della procedura (callback_data "c:…"). */
export async function gestisciPulsante(q: any, utenteId: string, ctx: ContestoCerca) {
  const dato = String(q.data ?? "");
  const chatId = String(q.message?.chat?.id ?? "");
  const messaggio = Number(q.message?.message_id ?? 0);
  const b = await leggiBozza<Bozza>(ctx.db, ctx.chiave, utenteId);
  if (!b || b.messaggio !== messaggio) {
    await ctx.tg.rispondiPulsante(q.id, "Questa procedura è scaduta: ricomincia con /cerca");
    await ctx.tg.modifica(chatId, messaggio, "⌛ Procedura scaduta: ricomincia con /cerca.").catch(() => null);
    return;
  }
  const [, azione, valore] = dato.split(":");

  if (azione === "no") {
    await cancellaBozza(ctx.db, utenteId);
    await ctx.tg.rispondiPulsante(q.id);
    await ctx.tg.modifica(chatId, messaggio, "❌ Ricerca annullata. Ho cancellato i dati.");
    return;
  }
  if (azione === "t" && b.passo === "tipo" && (valore === "O" || valore === "Z")) {
    b.tipo = valore;
    b.passo = "zone";
  } else if (azione === "z" && b.passo === "zone") {
    if (valore === "ok") {
      if (b.zone.length === 0) {
        await ctx.tg.rispondiPulsante(q.id, "Scegli almeno una zona");
        return;
      }
      b.passo = "periodo";
    } else if (b.zone.includes(valore)) {
      b.zone = b.zone.filter((z) => z !== valore);
    } else if (b.zone.length >= MAX_ZONE) {
      await ctx.tg.rispondiPulsante(q.id, `Al massimo ${MAX_ZONE} zone`);
      return;
    } else if (b.zoneDisponibili.some((z) => z.codice === valore)) {
      b.zone.push(valore);
    }
  } else if (azione === "d" && b.passo === "periodo") {
    const giorni = Number(valore);
    b.dal = null;
    b.al = giorni > 0 ? piuGiorni(oggi(ctx), giorni) : null;
    b.passo = "orario";
  } else if (azione === "o" && b.passo === "orario") {
    const fasce: Record<string, { oraDa: number; oraA: number }> = {
      tutto: GIORNO_INTERO,
      mattina: { oraDa: 0, oraA: 13 * 60 },
      pomeriggio: { oraDa: 13 * 60, oraA: 24 * 60 },
    };
    Object.assign(b, fasce[valore] ?? GIORNO_INTERO);
    b.passo = "conferma";
  } else if (azione === "ok" && b.passo === "conferma") {
    await ctx.tg.rispondiPulsante(q.id);
    await avvia(b, utenteId, chatId, ctx);
    return;
  } else {
    await ctx.tg.rispondiPulsante(q.id);
    return;
  }
  await ctx.tg.rispondiPulsante(q.id);
  await salvaEMostra(b, utenteId, chatId, ctx, false);
}

/** Testo scritto durante la procedura (periodo o orario a mano). true se era per la procedura. */
export async function gestisciTesto(testo: string, chatId: string, utenteId: string, ctx: ContestoCerca): Promise<boolean> {
  const b = await leggiBozza<Bozza>(ctx.db, ctx.chiave, utenteId);
  if (!b || (b.passo !== "periodo" && b.passo !== "orario")) return false;
  if (b.passo === "periodo") {
    const p = leggiPeriodo(testo, oggi(ctx));
    if (!p) {
      await ctx.tg.manda(chatId, "Non ho capito il periodo. Scrivi per esempio <code>01/12/2026-31/01/2027</code>, <code>15/1-28/2</code> o solo <code>01/12/2026</code> (da quel giorno).");
      return true;
    }
    b.dal = p.dal;
    b.al = p.al;
    b.passo = "orario";
  } else {
    const o = leggiOrario(testo);
    if (!o) {
      await ctx.tg.manda(chatId, "Non ho capito l'orario. Scrivi per esempio <code>8-12</code> o <code>14:30-18</code>.");
      return true;
    }
    b.oraDa = o.oraDa;
    b.oraA = o.oraA;
    b.passo = "conferma";
  }
  await salvaEMostra(b, utenteId, chatId, ctx, true);
  return true;
}

async function avvia(b: Bozza, utenteId: string, chatId: string, ctx: ContestoCerca) {
  const filtri = filtriDi(b);
  const tipo = b.tipo ?? "O";
  await ctx.tg.modifica(chatId, b.messaggio, `${intestazione(b)}\n\n${descriviFiltri(filtri)}\n\n⏳ Cerco in ${filtri.zone.length} ${filtri.zone.length === 1 ? "zona" : "zone"} (qualche secondo per zona)…`);
  let r;
  try {
    r = await (ctx.cerca ?? cercaNuova)(b.dati, tipo, filtri);
  } catch (e) {
    // La bozza resta: si può riprovare con lo stesso pulsante.
    await ctx.tg.manda(chatId, `❌ ${html(erroreSito(e))}`);
    await ctx.tg.modifica(chatId, b.messaggio, schermata(b).testo, schermata(b).tastiera);
    return;
  }
  const primi = r.date.slice(0, PRIMI_RISULTATI);
  const id = await nuovoControllo(ctx.db, ctx.chiave, {
    modalita: "cerca",
    chatId,
    utenteId,
    dati: b.dati,
    tipo,
    contesto: {
      prestazione: b.prestazione,
      filtri,
      appuntamentoIniziale: r.appuntamento?.data ?? null,
      risultati: primi,
      notificate: primi.map(chiaveData),
    },
  });
  await cancellaBozza(ctx.db, utenteId);
  await ctx.tg.modifica(chatId, b.messaggio, `✅ <b>Ricerca #${id} avviata</b>`);
  await ctx.tg.manda(chatId, messaggioRisultati(id, b.prestazione, filtri, primi, new Set(), r.zoneInErrore));
}
