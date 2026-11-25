// Disdetta: richiesta come il sito, prova senza invio, reale senza sblocco dopo, e i pulsanti del bot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gestisciAggiornamento } from "../lib/bot.js";
import { leggiControlli, nuovoControllo } from "../lib/db.js";
import { daDisdire, disdiciAppuntamento } from "../lib/disdetta.js";
import type { Disdici } from "../lib/disdetta-bot.js";
import { AGENDA, appuntamentoSito, CF, CHIAVE, CIFRE, dbFinto, NRE, PRESIDIO, ricettaSito, sitoFinto, TelegramFinto } from "./finti.js";

const dati = { codiceFiscale: CF, cifre: CIFRE, nre: NRE };
const ORA = new Date("2026-11-25T10:00:00Z");
const destinazioni = (c: { destinazione: string }[]) => c.map((x) => x.destinazione);

function sito(extra: Record<string, (a: any) => unknown> = {}) {
  return sitoFinto({
    pgpcitt_ricerca_ricetta: () =>
      ricettaSito([{ ...appuntamentoSito("20270101"), annullatoIl: "20261120" }, { ...appuntamentoSito("20270429"), cittadino: { codiceFiscale: CF } }]),
    ...extra,
  });
}

test("prova: prepara la richiesta come il sito, non la invia e sblocca la ricetta", async () => {
  const { f, chiamate } = sito();
  const r = await disdiciAppuntamento(dati, "20270429083000", { fetch: f, reale: false, ora: ORA });
  assert.equal(r.esito, "prova");
  assert.ok(!destinazioni(chiamate).includes("pgpcitt_annulla_appuntamento"));
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
  if (r.esito !== "prova") return;
  const q = r.richiesta as any;
  assert.equal(q.codiceFiscale, CF);
  assert.deepEqual(q.appuntamentiAnnullati, []);
  assert.equal(q.appuntamenti.length, 1);
  assert.equal(q.appuntamenti[0].data, "20270429083000");
  assert.equal(q.appuntamenti[0].cittadino.codiceFiscale, CF);
  assert.equal(q.appuntamenti[0].differita, null);
  assert.deepEqual(q.appuntamenti[0].infoMezzi, { testo: null, link: null });
});

test("reale: chiama la disdetta e dopo NON sblocca la ricetta", async () => {
  const { f, chiamate } = sito({ pgpcitt_annulla_appuntamento: () => ({}) });
  const r = await disdiciAppuntamento(dati, "20270429083000", { fetch: f, reale: true, ora: ORA });
  assert.equal(r.esito, "disdetto");
  const seq = destinazioni(chiamate);
  assert.equal(seq.at(-1), "pgpcitt_annulla_appuntamento");
  assert.ok(!seq.includes("pgpcitt_sblocca_ricetta_elettronica"));
});

test("appuntamento non trovato (data diversa o annullato): nulla, ricetta sbloccata", async () => {
  const { f, chiamate } = sito({ pgpcitt_annulla_appuntamento: () => ({}) });
  assert.equal((await disdiciAppuntamento(dati, "20270101083000", { fetch: f, reale: true, ora: ORA })).esito, "non-trovato");
  assert.ok(!destinazioni(chiamate).includes("pgpcitt_annulla_appuntamento"));
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
});

test("disdetta rifiutata: errore e ricetta sbloccata", async () => {
  const { f, chiamate } = sito({ pgpcitt_annulla_appuntamento: () => ({ eccezione: "X" }) });
  const err = console.error;
  console.error = () => {};
  try {
    await assert.rejects(disdiciAppuntamento(dati, "20270429083000", { fetch: f, reale: true, ora: ORA }), /rifiutato la disdetta \(X\)/);
  } finally {
    console.error = err;
  }
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
});

test("appuntamenti associati si disdicono insieme", () => {
  const r = {
    appuntamenti: {
      singoli: [
        { data: "20270429083000", associazione: "A" },
        { data: "20270429090000", associazione: "A" },
        { data: "20270501083000", associazione: "B" },
      ],
    },
  };
  assert.equal(daDisdire(r, "20270429083000", "20261125000000").length, 2);
  assert.equal(daDisdire(r, "20270501083000", "20261125000000").length, 1);
  assert.equal(daDisdire(r, "20270429083000", "20280101000000").length, 0); // passato
});

// ---- il bot ---------------------------------------------------------------------------------------

const UTENTE = "111";
const attuale = {
  data: "20270429083000",
  prestazione: "ECO",
  presidio: { codice: PRESIDIO.codice, descrizione: "OSPEDALE DEL PONTE" },
  agenda: { codice: AGENDA.codice, descrizione: "" },
  unita: null,
};

async function ambiente(reale: boolean) {
  const db = await dbFinto();
  const tg = new TelegramFinto();
  const chiamate: Parameters<Disdici>[] = [];
  const disdici: Disdici = async (...a) => {
    chiamate.push(a);
    return a[2].reale ? { esito: "disdetto", appuntamenti: [attuale] } : { esito: "prova", appuntamenti: [attuale], richiesta: {} };
  };
  const id = await nuovoControllo(db, CHIAVE, {
    modalita: "anticipa",
    chatId: UTENTE,
    utenteId: UTENTE,
    dati,
    tipo: "O",
    contesto: { appuntamento: attuale, zona: null, notificate: [], anticipate: [], primaData: null },
  });
  const ctx = { db, chiave: CHIAVE, utenti: new Set([UTENTE]), tg, prenotazioneReale: reale, disdici };
  let n = 0;
  const scrivi = (text: string) =>
    gestisciAggiornamento({ message: { message_id: ++n, text, chat: { id: Number(UTENTE) }, from: { id: Number(UTENTE) } } }, ctx);
  const tocca = (data: string, messaggio: number) =>
    gestisciAggiornamento(
      {
        callback_query: {
          id: `q${++n}`,
          data,
          from: { id: Number(UTENTE) },
          message: { message_id: messaggio, chat: { id: Number(UTENTE) }, date: Math.floor(Date.now() / 1000) },
        },
      },
      ctx,
    );
  return { db, tg, id, scrivi, tocca, chiamate };
}

test("/disdici: conferma con avvertenze; in prova non disdice e il controllo resta", async () => {
  const { tg, scrivi, tocca, chiamate, db } = await ambiente(false);
  await scrivi("/disdici");
  const conferma = tg.conPulsanti!;
  assert.match(conferma.testo, /Disdico questo appuntamento/);
  assert.match(conferma.testo, /gio 29\/04\/2027 08:30/);
  assert.match(conferma.testo, /non si può annullare/);
  assert.equal(conferma.tastiera![0][0].text, "🧪 Prova");
  await tocca(conferma.tastiera![0][0].callback_data, conferma.id);
  assert.equal(chiamate.length, 1);
  assert.equal(chiamate[0][1], "20270429083000");
  assert.match(tg.messaggi.find((m) => m.id === conferma.id)!.testo, /Non ho disdetto nulla/);
  assert.equal((await leggiControlli(db, CHIAVE)).length, 1);
});

test("/disdici reale: disdice dopo 🗑 Sì e cancella il controllo; ❌ No non fa nulla", async () => {
  const { tg, id, scrivi, tocca, chiamate, db } = await ambiente(true);
  await scrivi(`/disdici ${id}`);
  let conferma = tg.conPulsanti!;
  await tocca("dx", conferma.id);
  assert.match(tg.messaggi.find((m) => m.id === conferma.id)!.testo, /non disdico nulla/);
  assert.equal(chiamate.length, 0);

  await tocca(`d:${id}`, 1); // il pulsante 🗑 Disdici sotto l'esito di una prenotazione
  conferma = tg.conPulsanti!;
  assert.equal(conferma.tastiera![0][0].text, "🗑 Sì, disdici");
  await tocca(conferma.tastiera![0][0].callback_data, conferma.id);
  assert.equal(chiamate.length, 1);
  assert.match(tg.messaggi.find((m) => m.id === conferma.id)!.testo, /Disdetto/);
  assert.equal((await leggiControlli(db, CHIAVE)).length, 0);
});

test("/disdici CF CIFRE NRE: messaggio cancellato, dati salvati non monitorati e conferma", async () => {
  const db = await dbFinto();
  const tg = new TelegramFinto();
  const anteprima = async () => ({ prestazione: "ECO", tipo: "O" as const, appuntamento: attuale, zone: [] });
  await gestisciAggiornamento(
    { message: { message_id: 77, text: `/disdici ${CF} ${CIFRE} ${NRE}`, chat: { id: Number(UTENTE) }, from: { id: Number(UTENTE) } } },
    { db, chiave: CHIAVE, utenti: new Set([UTENTE]), tg, prenotazioneReale: true, anteprima },
  );
  assert.deepEqual(tg.cancellati, [77]);
  const [c] = await leggiControlli(db, CHIAVE);
  assert.equal(c.modalita === "anticipa" && c.contesto.monitora, false);
  assert.match(tg.conPulsanti!.testo, /Disdico questo appuntamento/);
  const grezzo = JSON.stringify((await db.execute("SELECT * FROM controlli")).rows);
  assert.ok(!grezzo.includes(CF) && !grezzo.includes(NRE)); // cifrati
});
