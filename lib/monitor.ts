// Il giro periodico: per ogni controllo interroga il sito e avvisa delle novità.
// - anticipa: date nuove prima dell'appuntamento, nello stesso presidio;
// - cerca: date nuove tra le prime 10 che rispettano i filtri, migliori della peggiore già mandata.
import type { Client } from "@libsql/client";
import {
  anteprimaRicetta,
  cercaNuova,
  chiaveData,
  dateAnticipate,
  ErroreUtente,
  giroSito,
  type DataLibera,
  type DatiRicetta,
  type EsitoRicerca,
  type EsitoSito,
  type Filtri,
  type OpzioniGiro,
  type Tipo,
} from "./controllo.js";
import {
  aggiornaControllo,
  cancellaControllo,
  leggiControlli,
  pulisciBozze,
  type Controllo,
  type ControlloAnticipa,
  type ControlloCerca,
} from "./db.js";
import { descriviAppuntamento, formatoData, messaggioAnticipate, messaggioRisultati, PRIMI_RISULTATI } from "./messaggi.js";
import { InCoda } from "./prenota.js";
import { html, type Telegram } from "./telegram.js";

/** Dopo quanti errori di fila si avvisa (e poi si riavvisa quando torna a funzionare). */
export const ERRORI_PER_AVVISO = 3;

export type GiroSito = (dati: DatiRicetta, opz: OpzioniGiro) => Promise<EsitoSito>;
export type CercaSito = (dati: DatiRicetta, tipo: Tipo, filtri: Filtri) => Promise<EsitoRicerca>;
export type AnteprimaSito = typeof anteprimaRicetta;

export type Contesto = {
  db: Client;
  chiave: Buffer;
  tg: Pick<Telegram, "manda">;
  /** Sostituibili nei test. */
  giro?: GiroSito;
  cerca?: CercaSito;
  anteprima?: AnteprimaSito;
};

export type Esito = "ok" | "notificato" | "coda" | "errore" | "finito";

const nome = (c: Controllo) => (c.modalita === "cerca" ? `La ricerca #${c.id}` : `Il controllo #${c.id}`);

/** Gli errori di un giro: la coda si salta senza contarla, il resto si conta e dopo 3 di fila si avvisa. */
async function errore(c: Controllo, e: unknown, ctx: Contesto): Promise<Esito> {
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
      `⚠️ ${nome(c)} non riesce a leggere PrenotaSalute (${errori} volte di fila): ${html(messaggio)}\nRiprovo ai prossimi giri.`,
    );
  }
  return "errore";
}

async function ritorno(c: Controllo, ctx: Contesto) {
  if (c.errori >= ERRORI_PER_AVVISO) await ctx.tg.manda(c.chatId, `✅ ${nome(c)} funziona di nuovo.`);
}

export async function controllaUno(c: Controllo, ctx: Contesto): Promise<Esito> {
  return c.modalita === "cerca" ? controllaCerca(c, ctx) : controllaAnticipa(c, ctx);
}

async function controllaAnticipa(c: ControlloAnticipa, ctx: Contesto): Promise<Esito> {
  let r: EsitoSito;
  try {
    r = await (ctx.giro ?? giroSito)(c.dati, { tipo: c.tipo, zona: c.contesto.zona });
  } catch (e) {
    return errore(c, e, ctx);
  }
  await ritorno(c, ctx);

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

/**
 * Le date da notificare tra i primi risultati: mai mandate prima e, se l'elenco di prima era pieno, migliori
 * della sua ultima (così una data che "sale" in classifica perché ne è sparita una prima non disturba).
 */
export function nuoveDaNotificare(primi: DataLibera[], prima: DataLibera[], notificate: string[]): Set<string> {
  const gia = new Set(notificate);
  const peggiore = prima.length >= PRIMI_RISULTATI ? prima[PRIMI_RISULTATI - 1].data : null;
  return new Set(
    primi.filter((d) => !gia.has(chiaveData(d)) && (peggiore === null || d.data < peggiore)).map(chiaveData),
  );
}

async function controllaCerca(c: ControlloCerca, ctx: Contesto): Promise<Esito> {
  let r: EsitoRicerca;
  try {
    r = await (ctx.cerca ?? cercaNuova)(c.dati, c.tipo, c.contesto.filtri);
  } catch (e) {
    return errore(c, e, ctx);
  }
  await ritorno(c, ctx);

  // Prenotata dopo l'avvio della ricerca (probabilmente grazie a lei): la ricerca ha finito.
  if (r.appuntamento && c.contesto.appuntamentoIniziale === null) {
    await ctx.tg.manda(
      c.chatId,
      [
        `✅ La ricetta della ricerca #${c.id} ora è prenotata:`,
        "",
        descriviAppuntamento(r.appuntamento),
        "",
        "Ho fermato la ricerca e cancellato i dati. Se vuoi che ti avvisi quando si libera una data prima, usa /avvia.",
      ].join("\n"),
    );
    await cancellaControllo(ctx.db, c.id);
    return "finito";
  }

  const primi = r.date.slice(0, PRIMI_RISULTATI);
  const nuove = nuoveDaNotificare(primi, c.contesto.risultati, c.contesto.notificate);
  if (nuove.size > 0)
    await ctx.tg.manda(c.chatId, messaggioRisultati(c.id, c.contesto.prestazione, c.contesto.filtri, primi, nuove));

  await aggiornaControllo(ctx.db, ctx.chiave, {
    id: c.id,
    tipo: c.tipo,
    errori: 0,
    ultimoEsito: r.zoneInErrore.length > 0 ? `ok, ma errore in: ${r.zoneInErrore.join(", ")}` : "ok",
    contesto: {
      ...c.contesto,
      appuntamentoIniziale: r.appuntamento?.data ?? c.contesto.appuntamentoIniziale,
      risultati: primi,
      notificate: primi.map(chiaveData),
    },
  });
  return nuove.size > 0 ? "notificato" : "ok";
}

/** Un giro su tutti i controlli, dal meno recente, finché c'è tempo. */
export async function giroDiControllo(ctx: Contesto & { limite: number }) {
  await pulisciBozze(ctx.db).catch((e) => console.warn(JSON.stringify({ bozze: (e as Error).message })));
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
