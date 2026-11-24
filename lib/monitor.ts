// Il giro periodico: per ogni controllo, interroga il sito e avvisa delle date anticipate nuove.
import type { Client } from "@libsql/client";
import {
  chiaveData,
  dateAnticipate,
  ErroreUtente,
  giroSito,
  type DatiRicetta,
  type EsitoSito,
  type OpzioniGiro,
} from "./controllo.js";
import { aggiornaControllo, cancellaControllo, leggiControlli, type Controllo } from "./db.js";
import { descriviAppuntamento, formatoData, messaggioAnticipate } from "./messaggi.js";
import { InCoda } from "./prenota.js";
import { html, type Telegram } from "./telegram.js";

/** Dopo quanti errori di fila si avvisa (e poi si riavvisa quando torna a funzionare). */
export const ERRORI_PER_AVVISO = 3;

export type GiroSito = (dati: DatiRicetta, opz: OpzioniGiro) => Promise<EsitoSito>;

export type Contesto = {
  db: Client;
  chiave: Buffer;
  tg: Pick<Telegram, "manda">;
  giro?: GiroSito;
};

export type Esito = "ok" | "notificato" | "coda" | "errore" | "finito";

export async function controllaUno(c: Controllo, ctx: Contesto): Promise<Esito> {
  const giro = ctx.giro ?? giroSito;
  let r: EsitoSito;
  try {
    r = await giro(c.dati, { tipo: c.tipo, zona: c.contesto.zona });
  } catch (e) {
    if (e instanceof InCoda) {
      await aggiornaControllo(ctx.db, ctx.chiave, { ...c, ultimoEsito: "coda" });
      return "coda";
    }
    const errori = c.errori + 1;
    const messaggio = (e as Error).message.slice(0, 200);
    console.error(JSON.stringify({ controllo: c.id, errore: messaggio }));
    await aggiornaControllo(ctx.db, ctx.chiave, { ...c, errori, ultimoEsito: `errore: ${messaggio}` });
    if (errori === ERRORI_PER_AVVISO || (e instanceof ErroreUtente && c.errori === 0)) {
      await ctx.tg.manda(
        c.chatId,
        `⚠️ Il controllo #${c.id} non riesce a leggere PrenotaSalute (${errori} volte di fila): ${html(messaggio)}\nRiprovo ai prossimi giri.`,
      );
    }
    return "errore";
  }

  if (c.errori >= ERRORI_PER_AVVISO) {
    await ctx.tg.manda(c.chatId, `✅ Il controllo #${c.id} funziona di nuovo.`);
  }

  if (!r.appuntamento) {
    await ctx.tg.manda(
      c.chatId,
      `ℹ️ La ricetta del controllo #${c.id} non ha più un appuntamento futuro (spostato, annullato o già passato). Ho fermato il controllo e cancellato i dati.`,
    );
    await cancellaControllo(ctx.db, c.id);
    return "finito";
  }

  const vecchio = c.contesto.appuntamento;
  const cambiato = vecchio.data !== r.appuntamento.data || vecchio.presidio.codice !== r.appuntamento.presidio.codice;
  if (cambiato) {
    await ctx.tg.manda(
      c.chatId,
      `ℹ️ Il tuo appuntamento è cambiato (prima: ${formatoData(vecchio.data)}). Da ora confronto con questo:\n\n${descriviAppuntamento(r.appuntamento)}`,
    );
  }

  const anticipate = dateAnticipate(r.appuntamento, r.date);
  const giaNotificate = new Set(cambiato ? [] : c.contesto.notificate);
  const nuove = new Set(anticipate.map(chiaveData).filter((k) => !giaNotificate.has(k)));
  if (nuove.size > 0) await ctx.tg.manda(c.chatId, messaggioAnticipate(c.id, r.appuntamento, anticipate, nuove));

  await aggiornaControllo(ctx.db, ctx.chiave, {
    id: c.id,
    tipo: r.tipo,
    errori: 0,
    ultimoEsito: "ok",
    contesto: {
      appuntamento: r.appuntamento,
      zona: r.zona,
      notificate: anticipate.map(chiaveData),
      anticipate,
      primaData: r.date.find((d) => d.presidio.codice === r.appuntamento!.presidio.codice) ?? null,
    },
  });
  return nuove.size > 0 ? "notificato" : "ok";
}

/** Un giro su tutti i controlli, dal meno recente, finché c'è tempo. */
export async function giroDiControllo(ctx: Contesto & { limite: number }) {
  const conteggi: Record<Esito, number> = { ok: 0, notificato: 0, coda: 0, errore: 0, finito: 0 };
  const controlli = await leggiControlli(ctx.db, ctx.chiave);
  let saltati = 0;
  for (const [i, c] of controlli.entries()) {
    if (Date.now() > ctx.limite) {
      saltati = controlli.length - i;
      break;
    }
    const esito = await controllaUno(c, ctx);
    conteggi[esito]++;
    if (esito === "coda") {
      // Sala d'attesa attiva: inutile insistere con gli altri in questo giro.
      saltati = controlli.length - i - 1;
      break;
    }
  }
  return { controlli: controlli.length, ...conteggi, saltati };
}
