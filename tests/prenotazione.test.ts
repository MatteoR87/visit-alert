// Prenotazione: richiesta come il sito, prova senza invio, reale senza sblocco dopo, e i pulsanti del bot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gestisciAggiornamento } from "../lib/bot.js";
import { leggiControlli, nuovoControllo } from "../lib/db.js";
import type { Prenota } from "../lib/prenota-bot.js";
import { prenotaData, strutturaMascherata } from "../lib/prenotazione.js";
import { AGENDA, appuntamentoSito, CF, CHIAVE, CIFRE, dbFinto, NRE, PRESIDIO, ricettaSito, sitoFinto, TelegramFinto } from "./finti.js";

const dati = { codiceFiscale: CF, cifre: CIFRE, nre: NRE };
const ZONA = { codice: "012%", codiceProvincia: "012", codiceComune: "%", descrizione: "VARESE" };
const BERSAGLIO = { data: "20270410083000", presidio: PRESIDIO.codice, agenda: AGENDA.codice };

function singola(data: string, richiesta: string) {
  return {
    appuntamento: {
      data,
      modulo: NRE,
      iup: "IUP1",
      unitaErogante: { presidio: PRESIDIO, descrizione: "Cardiologia" },
      agenda: AGENDA,
      prestazione: { descrizione: "ECO" },
    },
    richiesta,
    migliore: "S",
    primaDataProposta: data,
  };
}

function sito(extra: Record<string, (a: any) => unknown> = {}) {
  return sitoFinto({
    pgpcitt_ricerca_ricetta: () => ricettaSito([appuntamentoSito("20270429")]),
    pgpcitt_ricerca_disponibilita: () => ({
      singole: [singola("20270405083000", "R0"), singola("20270410083000", "R1")],
      combinate: [],
      associate: [],
      presidi: [],
    }),
    ...extra,
  });
}

const destinazioni = (c: { destinazione: string }[]) => c.map((x) => x.destinazione);

test("prova: prepara la richiesta come il sito e non la invia; la ricetta si sblocca", async () => {
  const { f, chiamate } = sito();
  const r = await prenotaData(dati, "O", [ZONA], BERSAGLIO, { fetch: f, reale: false });
  assert.equal(r.esito, "prova");
  assert.ok(!destinazioni(chiamate).includes("pgpcitt_conferma_disponibilita"));
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
  if (r.esito !== "prova") return;
  const q = r.richiesta as any;
  assert.equal(q.codiceFiscale, CF);
  assert.equal(q.tipoPrestazione, "O");
  assert.deepEqual(q.appuntamenti, []);
  assert.equal(q.disponibilita.length, 1);
  assert.equal(q.disponibilita[0].richiesta, "R1");
  assert.equal(q.disponibilita[0].selezionabile, true);
  assert.equal(q.disponibilita[0].appuntamento.data, "20270410083000");
  assert.deepEqual(q.disponibilita[0].appuntamento.ricetta, { iup: "IUP1", iurp: null, modulo: { id: NRE } });
  assert.equal(q.ricetta.emessaIl, "20261118");
  assert.equal(q.ricetta.appuntamenti, null);
  assert.equal(q.ricetta.prestazioniPrenotate.length, 1);
  assert.deepEqual(q.recapiti, { telefono: "000", cellulare: null, email: "x@y.z" });
});

test("reale: chiama la conferma e dopo NON sblocca la ricetta", async () => {
  const { f, chiamate } = sito({
    pgpcitt_conferma_disponibilita: () => ({
      disponibilita: [{ appuntamento: { ...appuntamentoSito("20270410"), ipCup: "CUP123" } }],
      importo: "0,00",
    }),
  });
  const r = await prenotaData(dati, "O", [ZONA], BERSAGLIO, { fetch: f, reale: true });
  assert.equal(r.esito, "prenotato");
  if (r.esito !== "prenotato") return;
  assert.equal(r.appuntamenti[0].data, "20270410083000");
  assert.deepEqual(r.codici, ["CUP123"]);
  assert.equal(r.importo, "0,00");
  const seq = destinazioni(chiamate);
  assert.equal(seq.at(-1), "pgpcitt_conferma_disponibilita");
  assert.ok(!seq.includes("pgpcitt_sblocca_ricetta_elettronica"));
  assert.equal(chiamate.at(-1)!.arg.disponibilita[0].richiesta, "R1");
});

test("data non più libera: nessuna conferma, ricetta sbloccata", async () => {
  const { f, chiamate } = sito();
  const r = await prenotaData(dati, "O", [ZONA], { ...BERSAGLIO, data: "20270411083000" }, { fetch: f, reale: true });
  assert.equal(r.esito, "non-disponibile");
  assert.ok(!destinazioni(chiamate).includes("pgpcitt_conferma_disponibilita"));
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
});

test("conferma rifiutata dal sito: errore e ricetta sbloccata", async () => {
  const { f, chiamate } = sito({ pgpcitt_conferma_disponibilita: () => ({ eccezione: "DISPONIBILITA.OCCUPATA" }) });
  await assert.rejects(prenotaData(dati, "O", [ZONA], BERSAGLIO, { fetch: f, reale: true }), /rifiutato.*DISPONIBILITA\.OCCUPATA/);
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
});

test("conferma senza risposta (rete): errore che invita a controllare, e niente sblocco", async () => {
  const { f, chiamate } = sito({
    pgpcitt_conferma_disponibilita: () => {
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(prenotaData(dati, "O", [ZONA], BERSAGLIO, { fetch: f, reale: true }), /controlla su PrenotaSalute/);
  assert.ok(!destinazioni(chiamate).includes("pgpcitt_sblocca_ricetta_elettronica"));
});

test("log della prova: valori mascherati salvo codici e date", () => {
  const m = strutturaMascherata({ codiceFiscale: CF, tipoPrestazione: "O", x: { data: "20270410083000", nome: "Mario" }, n: 3 });
  assert.deepEqual(m, { codiceFiscale: "<s:16>", tipoPrestazione: "O", x: { data: "20270410083000", nome: "<s:5>" }, n: 3 });
});

// ---- i pulsanti del bot --------------------------------------------------------------------------

const UTENTE = "111";
const libera = { data: "20270410083000", presidio: { codice: PRESIDIO.codice, descrizione: "OSPEDALE DEL PONTE" }, agenda: { codice: AGENDA.codice, descrizione: "" }, unita: "Cardiologia" };
const attuale = { data: "20270429083000", prestazione: "ECO", presidio: libera.presidio, agenda: libera.agenda, unita: null };

async function ambiente(opz: { reale: boolean; modalita?: "anticipa" | "cerca"; prenota?: Prenota }) {
  const db = await dbFinto();
  const tg = new TelegramFinto();
  const chiamate: any[] = [];
  const prenota: Prenota =
    opz.prenota ??
    (async (...a) => {
      chiamate.push(a);
      return a[4].reale
        ? { esito: "prenotato", appuntamenti: [{ ...attuale, data: "20270410083000" }], codici: ["CUP123"], importo: "0,00" }
        : { esito: "prova", appuntamento: { ...attuale, data: "20270410083000" }, richiesta: {} };
    });
  const id =
    opz.modalita === "cerca"
      ? await nuovoControllo(db, CHIAVE, {
          modalita: "cerca",
          chatId: UTENTE,
          utenteId: UTENTE,
          dati,
          tipo: "O",
          contesto: {
            prestazione: "ECO",
            filtri: { zone: [ZONA], dal: null, al: null, fasce: [] },
            appuntamentoIniziale: null,
            risultati: [libera],
            notificate: [],
          },
        })
      : await nuovoControllo(db, CHIAVE, {
          modalita: "anticipa",
          chatId: UTENTE,
          utenteId: UTENTE,
          dati,
          tipo: "O",
          contesto: { appuntamento: attuale, zona: ZONA, notificate: [], anticipate: [libera], primaData: libera },
        });
  const ctx = { db, chiave: CHIAVE, utenti: new Set([UTENTE]), tg, prenotazioneReale: opz.reale, prenota };
  let n = 0;
  const tocca = (data: string, messaggio = 1, quando = Date.now() / 1000) =>
    gestisciAggiornamento(
      {
        callback_query: {
          id: `q${++n}`,
          data,
          from: { id: Number(UTENTE) },
          message: { message_id: messaggio, chat: { id: Number(UTENTE) }, date: Math.floor(quando) },
        },
      },
      ctx,
    );
  return { db, tg, id, tocca, chiamate };
}

test("📅 chiede conferma con le avvertenze; in prova il pulsante è 🧪 e non si prenota nulla", async () => {
  const { tg, id, tocca, chiamate, db } = await ambiente({ reale: false });
  await tocca(`p:${id}:20270410083000:${PRESIDIO.codice}`);
  const conferma = tg.conPulsanti!;
  assert.match(conferma.testo, /Prenoto questa data/);
  assert.match(conferma.testo, /sab 10\/04\/2027 08:30/);
  assert.match(conferma.testo, /OSPEDALE DEL PONTE/);
  assert.match(conferma.testo, /gio 29\/04\/2027 08:30.*annullato automaticamente/s);
  assert.match(conferma.testo, /Modalità prova/);
  assert.equal(conferma.tastiera![0][0].text, "🧪 Prova");

  await tocca(conferma.tastiera![0][0].callback_data, conferma.id);
  assert.equal(chiamate.length, 1);
  assert.equal(chiamate[0][4].reale, false);
  assert.deepEqual(chiamate[0][3], { data: "20270410083000", presidio: PRESIDIO.codice, agenda: AGENDA.codice });
  assert.match(tg.messaggi.find((m) => m.id === conferma.id)!.testo, /Prova riuscita.*Non ho prenotato nulla/s);
  const [c] = await leggiControlli(db, CHIAVE);
  assert.equal(c.modalita === "anticipa" && c.contesto.appuntamento.data, "20270429083000"); // invariato
});

test("reale (anticipa): prenota, mostra il nuovo appuntamento e il controllo continua da lì", async () => {
  const { tg, id, tocca, db } = await ambiente({ reale: true });
  await tocca(`p:${id}:20270410083000:${PRESIDIO.codice}`);
  const conferma = tg.conPulsanti!;
  assert.equal(conferma.tastiera![0][0].text, "✅ Prenota");
  await tocca(conferma.tastiera![0][0].callback_data, conferma.id);
  const esito = tg.messaggi.find((m) => m.id === conferma.id)!.testo;
  assert.match(esito, /Prenotato!/);
  assert.match(esito, /CUP123/);
  assert.match(esito, /precedente \(gio 29\/04\/2027 08:30\) è stato annullato/);
  const [c] = await leggiControlli(db, CHIAVE);
  assert.equal(c.modalita === "anticipa" && c.contesto.appuntamento.data, "20270410083000");
});

test("reale (cerca): dopo la prenotazione la ricerca finisce", async () => {
  const { tg, id, tocca, db } = await ambiente({ reale: true, modalita: "cerca" });
  await tocca(`p:${id}:20270410083000:${PRESIDIO.codice}`);
  const conferma = tg.conPulsanti!;
  assert.doesNotMatch(conferma.testo, /annullato automaticamente/); // non c'era un appuntamento
  await tocca(conferma.tastiera![0][0].callback_data, conferma.id);
  assert.match(tg.messaggi.find((m) => m.id === conferma.id)!.testo, /ricerca #\d+ è finita/);
  assert.equal((await leggiControlli(db, CHIAVE)).length, 0);
});

test("conferma scaduta, ❌ No, data sparita e doppio tocco", async () => {
  let attesa: (() => void) | null = null;
  const lenta: Prenota = () =>
    new Promise((ok) => {
      attesa = () => ok({ esito: "non-disponibile" });
    });
  const { tg, id, tocca } = await ambiente({ reale: true, prenota: lenta });
  const dato = `pc:${id}:20270410083000:${PRESIDIO.codice}`;

  await tocca(dato, 5, Date.now() / 1000 - 11 * 60);
  assert.match(tg.risposte.at(-1)!.testo ?? "", /scaduta/);

  await tocca(`p:${id}:20270410083000:${PRESIDIO.codice}`);
  const conferma = tg.conPulsanti!;
  await tocca("px", conferma.id);
  assert.match(tg.messaggi.find((m) => m.id === conferma.id)!.testo, /non prenoto nulla/);

  const primo = tocca(dato, conferma.id);
  await new Promise((r) => setTimeout(r, 20));
  await tocca(dato, conferma.id); // mentre la prima è in corso
  assert.match(tg.risposte.at(-1)!.testo ?? "", /Sto già prenotando/);
  attesa!();
  await primo;
  assert.match(tg.messaggi.find((m) => m.id === conferma.id)!.testo, /non è più disponibile/);
});
