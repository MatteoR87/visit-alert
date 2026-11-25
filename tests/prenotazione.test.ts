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
  const ar = q.disponibilita[0].appuntamento.ricetta;
  assert.equal(ar.iup, "IUP1");
  assert.equal(ar.iurp ?? null, null); // assente nel grezzo: fuori dal JSON, come nel sito
  assert.deepEqual(ar.modulo, { id: NRE, tipo: null });
  assert.deepEqual(ar.prestazioni, []);
  assert.deepEqual(ar.appuntamentiUnificati, []);
  // Solo i campi del modello Appuntamento del sito, gli assenti a null.
  const ap = q.disponibilita[0].appuntamento;
  assert.equal(ap.ipCup ?? null, null);
  assert.deepEqual(ap.cicli, []);
  assert.equal(Object.keys(ap).length, 37);
  // Come la richiesta del sito: prestazioni della disponibilità piene, cittadino e info* oggetti.
  assert.equal(q.disponibilita[0].prestazioni.length, 1);
  assert.equal(q.disponibilita[0].prestazioni[0].descrizione, "ECO");
  assert.equal(q.disponibilita[0].prestazioni[0], ap.prestazione);
  assert.equal(ap.cittadino.codiceFiscale, null);
  assert.deepEqual(ap.infoMezzi, { testo: null, link: null });
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
  const err = console.error;
  const righe: string[] = [];
  console.error = (x: unknown) => void righe.push(String(x));
  try {
    await assert.rejects(prenotaData(dati, "O", [ZONA], BERSAGLIO, { fetch: f, reale: true }), /rifiutato.*DISPONIBILITA\.OCCUPATA/);
  } finally {
    console.error = err;
  }
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
  const log = righe.find((r) => r.includes("conferma_rifiutata"))!;
  assert.ok(log);
  assert.ok(!log.includes(CF) && !log.includes(NRE)); // nessun dato personale nei log
});

test("ripulisci: il testo del sito senza dati personali", async () => {
  const { ripulisci } = await import("../lib/prenota.js");
  assert.equal(ripulisci(null), null);
  assert.equal(
    ripulisci(`NullPointerException per ${CF} ricetta ${NRE} tel 3331234567 a@b.it`),
    "NullPointerException per <codice> ricetta <codice> tel <numero> <email>",
  );
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

test("data trattenuta dall'ultima ricerca: con una proposta recente si conferma quella, se vecchia no", async () => {
  const proposta = singola("20270402083000", "R-VECCHIA");
  const ora = new Date("2026-11-25T10:00:00Z");
  const bersaglio = { data: "20270402083000", presidio: PRESIDIO.codice, agenda: AGENDA.codice };

  const recente = sito({ pgpcitt_conferma_disponibilita: () => ({ disponibilita: [{ appuntamento: appuntamentoSito("20270402") }] }) });
  const r = await prenotaData(dati, "O", [ZONA], bersaglio, {
    fetch: recente.f,
    reale: true,
    ora,
    riserva: { singola: proposta, quando: "2026-11-25T09:50:00Z" },
  });
  assert.equal(r.esito, "prenotato");
  assert.equal(r.esito === "prenotato" && r.trattenuta, true);
  assert.equal(recente.chiamate.at(-1)!.arg.disponibilita[0].richiesta, "R-VECCHIA");

  const vecchia = sito();
  const v = await prenotaData(dati, "O", [ZONA], bersaglio, {
    fetch: vecchia.f,
    reale: true,
    ora,
    riserva: { singola: proposta, quando: "2026-11-25T09:30:00Z" },
  });
  assert.equal(v.esito, "non-disponibile");
  assert.ok(!destinazioni(vecchia.chiamate).includes("pgpcitt_conferma_disponibilita"));

  // Una proposta di un'altra data non vale.
  const altra = sito();
  const a = await prenotaData(dati, "O", [ZONA], bersaglio, {
    fetch: altra.f,
    reale: false,
    ora,
    riserva: { singola: singola("20270403083000", "R9"), quando: "2026-11-25T09:55:00Z" },
  });
  assert.equal(a.esito, "non-disponibile");
});

test("il giro salva (cifrate) le proposte delle prime date, con l'ora", async () => {
  const { leggiProposte, proposteDi } = await import("../lib/controllo.js");
  const { salvaProposte } = await import("../lib/monitor.js");
  const r = { singole: [singola("20270405083000", "R0"), singola("20270410083000", "R1"), { appuntamento: { data: "x" } }] };
  const p = leggiProposte(r);
  assert.deepEqual(Object.keys(p), [`20270405083000|${PRESIDIO.codice}|${AGENDA.codice}`, `20270410083000|${PRESIDIO.codice}|${AGENDA.codice}`]);
  const una = [{ data: "20270410083000", presidio: { codice: PRESIDIO.codice, descrizione: "" }, agenda: { codice: AGENDA.codice, descrizione: "" }, unita: null }];
  assert.deepEqual(Object.keys(proposteDi(p, una)), [`20270410083000|${PRESIDIO.codice}|${AGENDA.codice}`]);
  const s = salvaProposte(p, una)!;
  assert.ok(Date.now() - Date.parse(s.quando) < 5000);
  assert.equal((s.singole as any)[`20270410083000|${PRESIDIO.codice}|${AGENDA.codice}`].richiesta, "R1");
});

test("conferma: oggetti come i modelli del sito (forma di una conferma riuscita dal sito)", async () => {
  const { richiestaConferma } = await import("../lib/prenotazione.js");
  // Disponibilità grezza come la restituisce la ricerca (valori finti), con i campi che il sito scarta o trasforma.
  const grezza = {
    appuntamento: {
      uuid: "U1",
      data: "20270211110500",
      prestazione: { codice: "P1", descrizione: "VISITA", id: null, descrizioneBreve: null, flagExAsl: "N" },
      azienda: { codice: "A1", descrizione: "AZ", id: null, flag: null, infoPrenotazione: null },
      unitaErogante: {
        dataRiferimento: null,
        idAppuntamento: null,
        codice: "DER",
        puntoIndirizzo: null,
        unitaPrenotante: { codice: "430", azienda: null, flag: { inibizioneNre: "N", cupUnico: "S" } },
        presidio: {
          codice: "002202",
          id: "1",
          puntoIndirizzo: {
            localita: { codice: "018177", descrizione: "X", cap: "1", siglaProvincia: "PV" },
            indirizzo: { toponimo: null, descrizione: "VIA", civico: "1", frazione: null, x: "8.86", y: "45.30" },
          },
          azienda: { codice: "A1", flag: { prioritaB: "N", listaAttesa: null }, infoPrenotazione: { telefono: null, orari: [] } },
        },
      },
      agenda: { codice: "AG", descrizione: "D", note: "n" },
      infoLuogoPresentazione: { testo: "Piano", link: null },
      quesitoDiagnostico: { codice: "Q", descrizione: "D", id: "x", operatoreLogico: null },
      regimeErogazione: "1",
      risorsa: { codice: "R", nome: "N", cognome: "C" },
      tariffaLp: "0,00",
    },
    richiesta: "123",
    primaDataProposta: "20270211110500",
  };
  const ricetta = {
    data: "20261125000000",
    iup: "IUP",
    cittadino: { codiceFiscale: CF },
    emessaIl: "20261125",
    modulo: { id: NRE, tipo: "09" },
    stato: { codice: "01", descrizione: "PRESCRITTO", data: null },
    quesitoDiagnostico: { codice: null, descrizione: "q", id: null, operatoreLogico: null },
    prestazioni: [{ codice: "P1", stato: { codice: "01" }, distretti: null, metodiche: null }],
    appuntamenti: { singoli: [] },
  };
  const q: any = JSON.parse(
    JSON.stringify(
      richiestaConferma({ codiceFiscale: CF, zona: ZONA, ricetta, tipo: "Z", recapiti: { telefono: null, email: null }, singola: grezza }),
    ),
  );
  const d = q.disponibilita[0];
  const a = d.appuntamento;
  const ue = a.unitaErogante;
  assert.deepEqual(ue.presidio.puntoIndirizzo.indirizzo, {
    toponimo: null,
    descrizione: "VIA",
    civico: "1",
    frazione: null,
    coordinate: { latitude: "45.30", longitude: "8.86" },
  });
  assert.deepEqual(ue.puntoIndirizzo, { localita: null, indirizzo: null });
  assert.equal(ue.presidio.distanza, null);
  assert.ok(!("dataRiferimento" in ue) && !("idAppuntamento" in ue));
  assert.deepEqual(ue.unitaPrenotante.flag, { inibizioneNre: "N" });
  assert.deepEqual(ue.unitaPrenotante.azienda, { id: null, codice: null, descrizione: null, area: null, email: null, sito: null, flag: null, infoPrenotazione: null });
  assert.deepEqual(a.azienda.infoPrenotazione, { telefono: null, orari: null });
  assert.ok(!("id" in a.prestazione) && !("descrizioneBreve" in a.prestazione));
  assert.deepEqual(a.quesitoDiagnostico, { codice: "Q", descrizione: "D" });
  assert.deepEqual(a.infoLuogoPresentazione, { testo: "Piano", link: null });
  assert.deepEqual(a.risorsa, { codice: "R", nome: "N", cognome: "C", agende: [], descrizione: "N C" });
  assert.deepEqual(d.prestazioni, [a.prestazione]);
  assert.ok(!("data" in q.ricetta));
  assert.deepEqual(q.ricetta.quesitoDiagnostico, { codice: null, descrizione: "q" });
  assert.deepEqual(q.ricetta.prestazioni[0].agende, []);
  assert.ok(!("distretti" in q.ricetta.prestazioni[0]));
  assert.equal(q.ricetta.appuntamenti, null);
  assert.equal(q.ricetta.appuntamentiUnificati, null);
  assert.equal(q.zona.codice, "012%");
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
        ? { esito: "prenotato", appuntamenti: [{ ...attuale, data: "20270410083000" }], codici: ["CUP123"], importo: "0,00", trattenuta: false }
        : { esito: "prova", appuntamento: { ...attuale, data: "20270410083000" }, richiesta: {}, trattenuta: false };
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
