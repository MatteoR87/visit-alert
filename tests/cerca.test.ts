// La ricerca nuova: lettura dei filtri, ricerca su più zone, procedura guidata, notifiche e migrazione.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { gestisciAggiornamento } from "../lib/bot.js";
import { MAX_ZONE } from "../lib/cerca.js";
import {
  cercaNuova,
  fasceDi,
  fasceSito,
  rispettaFiltri,
  type DataLibera,
  type EsitoRicerca,
  type Filtri,
} from "../lib/controllo.js";
import { leggiFasce, leggiOrario, leggiPeriodo, piuGiorni } from "../lib/dati.js";
import { descriviFiltri } from "../lib/messaggi.js";
import { leggiControlli, preparaDb } from "../lib/db.js";
import { controllaUno, giroDiControllo, nuoveDaNotificare, type CercaSito } from "../lib/monitor.js";
import {
  appuntamentoSito,
  CF,
  CHIAVE,
  CIFRE,
  dbFinto,
  disponibilitaSito,
  NRE,
  PRESIDIO,
  ricettaSito,
  sitoFinto,
  TelegramFinto,
} from "./finti.js";

const UTENTE = "111";
const ORA = new Date("2026-11-24T10:00:00Z");
const OGGI = "20261124";

const luogo = (codice: string, descrizione = `Ospedale ${codice}`) => ({ codice, descrizione });
const libera = (data: string, presidio = "P1"): DataLibera => ({
  data,
  presidio: luogo(presidio),
  agenda: luogo("A1"),
  unita: null,
});
const ZONE = [
  { codice: "012%", codiceProvincia: "012", codiceComune: "%", descrizione: "VARESE" },
  { codice: "015%", codiceProvincia: "015", codiceComune: "%", descrizione: "MILANO PROVINCIA" },
  { codice: "015146", codiceProvincia: "015", codiceComune: "146", descrizione: "MILANO CITTA'" },
  { codice: "013%", codiceProvincia: "013", codiceComune: "%", descrizione: "COMO" },
  { codice: "097%", codiceProvincia: "097", codiceComune: "%", descrizione: "LECCO" },
];

// ---- filtri --------------------------------------------------------------------------------------

test("periodo scritto a mano: con e senza anno, un solo giorno, errori", () => {
  assert.deepEqual(leggiPeriodo("01/12/2026-31/01/2027", OGGI), { dal: "20261201", al: "20270131" });
  assert.deepEqual(leggiPeriodo("1/12-31/1", OGGI), { dal: "20261201", al: "20270131" });
  assert.deepEqual(leggiPeriodo("15/1 - 28/2", OGGI), { dal: "20270115", al: "20270228" }); // gennaio già passato → 2027
  assert.deepEqual(leggiPeriodo("dal 10/12/2026 al 20/12/2026", OGGI), { dal: "20261210", al: "20261220" });
  assert.deepEqual(leggiPeriodo("01/12/2026", OGGI), { dal: "20261201", al: null });
  assert.equal(leggiPeriodo("31/02/2027", OGGI), null);
  assert.equal(leggiPeriodo("10/01/2027-01/01/2027", OGGI), null);
  assert.equal(leggiPeriodo("domani", OGGI), null);
  assert.equal(piuGiorni(OGGI, 30), "20261224");
  assert.equal(piuGiorni("20261215", 30), "20270114");
});

test("orario scritto a mano", () => {
  assert.deepEqual(leggiOrario("8-12"), { oraDa: 480, oraA: 720 });
  assert.deepEqual(leggiOrario("14:30 - 18"), { oraDa: 870, oraA: 1080 });
  assert.deepEqual(leggiOrario("08.15-24"), { oraDa: 495, oraA: 1440 });
  assert.equal(leggiOrario("12-8"), null);
  assert.equal(leggiOrario("25-26"), null);
  assert.equal(leggiOrario("mattina"), null);
});

test("fasce scritte a mano: una o più", () => {
  assert.deepEqual(leggiFasce("8-10, 14:30-16"), [
    { da: 480, a: 600 },
    { da: 870, a: 960 },
  ]);
  assert.deepEqual(leggiFasce("8-9 e 18-19; 20-21"), [
    { da: 480, a: 540 },
    { da: 1080, a: 1140 },
    { da: 1200, a: 1260 },
  ]);
  assert.equal(leggiFasce("8-10, pomeriggio"), null);
  assert.equal(leggiFasce(""), null);
});

test("più fasce: una data vale se sta in una qualsiasi; il sito riceve mattina/pomeriggio giusti", () => {
  const f: Filtri = { zone: [], dal: null, al: null, fasce: [{ da: 480, a: 600 }, { da: 900, a: 1020 }] };
  assert.equal(rispettaFiltri(libera("20261201090000"), f, OGGI), true);
  assert.equal(rispettaFiltri(libera("20261201160000"), f, OGGI), true);
  assert.equal(rispettaFiltri(libera("20261201120000"), f, OGGI), false);
  assert.equal(rispettaFiltri(libera("20261201120000"), { ...f, fasce: [] }, OGGI), true);
  assert.deepEqual(fasceSito([{ da: 480, a: 600 }]), { mattina: true, pomeriggio: false });
  assert.deepEqual(fasceSito([{ da: 900, a: 1020 }]), { mattina: false, pomeriggio: true });
  assert.deepEqual(fasceSito(f.fasce!), { mattina: true, pomeriggio: true });
  assert.deepEqual(fasceSito([]), { mattina: true, pomeriggio: true });
});

test("ricerche salvate dalla prima versione (oraDa/oraA) si leggono ancora", () => {
  assert.deepEqual(fasceDi({ zone: [], dal: null, al: null, oraDa: 480, oraA: 720 }), [{ da: 480, a: 720 }]);
  assert.deepEqual(fasceDi({ zone: [], dal: null, al: null, oraDa: 0, oraA: 1440 }), []);
  assert.match(descriviFiltri({ zone: [], dal: null, al: null, oraDa: 480, oraA: 720 }), /Orario: 08:00–12:00/);
});

test("filtri: periodo incluso agli estremi e orario esatto", () => {
  const f: Filtri = { zone: [], dal: "20261201", al: "20261231", oraDa: 8 * 60, oraA: 12 * 60 };
  assert.equal(rispettaFiltri(libera("20261201080000"), f, OGGI), true);
  assert.equal(rispettaFiltri(libera("20261231120000"), f, OGGI), true);
  assert.equal(rispettaFiltri(libera("20261231120100"), f, OGGI), false);
  assert.equal(rispettaFiltri(libera("20261130100000"), f, OGGI), false);
  assert.equal(rispettaFiltri(libera("20270101100000"), f, OGGI), false);
  assert.equal(rispettaFiltri(libera("20261215075900"), f, OGGI), false);
});

// ---- ricerca sul sito ----------------------------------------------------------------------------

test("ricerca su più zone: vincoli al sito, filtri, ordine, zone in errore, sblocco", async () => {
  const { f, chiamate } = sitoFinto({
    pgpcitt_ricerca_ricetta: () => ricettaSito([]),
    pgpcitt_ricerca_disponibilita: (a) => {
      if (a.zona.codice === "013%") return { eccezione: "ES0001" };
      const altro = { ...PRESIDIO, codice: "999", descrizione: "OSPEDALE DI LEGNANO" };
      return a.zona.codice === "015%"
        ? disponibilitaSito(["20261210", "20261205"], undefined, altro) // 11:30
        : disponibilitaSito(["20261203", "20270115"]);
    },
  });
  const filtri: Filtri = { zone: [ZONE[0], ZONE[1], ZONE[3]], dal: null, al: "20261231", oraDa: 8 * 60, oraA: 12 * 60 };
  const r = await cercaNuova({ codiceFiscale: CF, cifre: CIFRE, nre: NRE }, "O", filtri, { fetch: f, ora: ORA });
  assert.deepEqual(
    r.date.map((d) => `${d.data.slice(0, 8)} ${d.presidio.codice}`),
    ["20261203 002591", "20261205 999", "20261210 999"],
  );
  assert.deepEqual(r.zoneInErrore, ["COMO"]);
  assert.equal(r.appuntamento, null);

  const ricerche = chiamate.filter((c) => c.destinazione === "pgpcitt_ricerca_disponibilita");
  assert.equal(ricerche.length, 3);
  const v = ricerche[0].arg.vincoliTemporali;
  assert.equal(v.dal, "20261124000000");
  assert.equal(v.al, "20261231235959");
  assert.equal(v.mattina, "S");
  assert.equal(v.pomeriggio, "N"); // 8-12: niente pomeriggio
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
});

test("ricerca: se fallisce in tutte le zone è un errore (e la ricetta si sblocca)", async () => {
  const { f, chiamate } = sitoFinto({
    pgpcitt_ricerca_ricetta: () => ricettaSito([]),
    pgpcitt_ricerca_disponibilita: () => ({ eccezione: "ES0001" }),
  });
  const filtri: Filtri = { zone: [ZONE[0]], dal: null, al: null, oraDa: 0, oraA: 1440 };
  await assert.rejects(cercaNuova({ codiceFiscale: CF, cifre: CIFRE, nre: NRE }, "O", filtri, { fetch: f, ora: ORA }));
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
});

test("ricerca con la ricetta già prenotata: cerca comunque e restituisce l'appuntamento", async () => {
  const { f } = sitoFinto({
    pgpcitt_ricerca_ricetta: () => ricettaSito([appuntamentoSito("20270429")]),
    pgpcitt_ricerca_disponibilita: () => disponibilitaSito(["20270107"]),
  });
  const filtri: Filtri = { zone: [ZONE[1]], dal: null, al: null, oraDa: 0, oraA: 1440 };
  const r = await cercaNuova({ codiceFiscale: CF, cifre: CIFRE, nre: NRE }, "O", filtri, { fetch: f, ora: ORA });
  assert.equal(r.appuntamento?.data, "20270429083000");
  assert.equal(r.date.length, 1);
});

// ---- notifiche -----------------------------------------------------------------------------------

test("nuove da notificare: mai mandate e, con l'elenco pieno, migliori dell'ultima", () => {
  const dieci = Array.from({ length: 10 }, (_, i) => libera(`2027010${i}100000`.slice(0, 14)));
  const k = (d: DataLibera) => `${d.data}|${d.presidio.codice}|${d.agenda.codice}`;
  // Elenco pieno: una data prima dell'ultima è nuova, una dopo no.
  const meglio = libera("20270101090000");
  const peggio = libera("20270201100000");
  assert.deepEqual([...nuoveDaNotificare([meglio, ...dieci.slice(0, 9)], dieci, dieci.map(k))], [k(meglio)]);
  assert.equal(nuoveDaNotificare([...dieci.slice(0, 9), peggio], dieci, dieci.map(k)).size, 0);
  // Elenco non pieno: ogni data nuova conta.
  assert.equal(nuoveDaNotificare([dieci[0], peggio], [dieci[0]], [k(dieci[0])]).size, 1);
});

// ---- procedura guidata ---------------------------------------------------------------------------

async function ambiente(opz: { tipo?: "O" | "Z" | null; prenotata?: boolean } = {}) {
  const db = await dbFinto();
  const tg = new TelegramFinto();
  const ricerche: { tipo: string; filtri: Filtri }[] = [];
  let risultato: EsitoRicerca = {
    appuntamento: null,
    date: Array.from({ length: 14 }, (_, i) => libera(`202612${String(i + 1).padStart(2, "0")}090000`)),
    zoneInErrore: [],
  };
  const cerca: CercaSito = async (_dati, tipo, filtri) => {
    ricerche.push({ tipo, filtri });
    return structuredClone(risultato);
  };
  const ctx = {
    db,
    chiave: CHIAVE,
    utenti: new Set([UTENTE]),
    tg,
    cerca,
    prenotazioneReale: false,
    ora: () => ORA,
    anteprima: async () => ({
      prestazione: "VISITA CARDIOLOGICA",
      tipo: opz.tipo === undefined ? null : opz.tipo,
      appuntamento: opz.prenotata
        ? { data: "20270429083000", prestazione: "X", presidio: luogo("P9", "OSPEDALE DEL PONTE"), agenda: luogo("A"), unita: null }
        : null,
      zone: ZONE,
    }),
  };
  let n = 0;
  const scrivi = (text: string, message_id = ++n) =>
    gestisciAggiornamento({ message: { message_id, text, chat: { id: Number(UTENTE) }, from: { id: Number(UTENTE) } } }, ctx);
  const tocca = (data: string, message_id = tg.conPulsanti!.id) =>
    gestisciAggiornamento(
      { callback_query: { id: `q${++n}`, data, from: { id: Number(UTENTE) }, message: { message_id, chat: { id: Number(UTENTE) } } } },
      ctx,
    );
  return {
    db,
    tg,
    ctx,
    scrivi,
    tocca,
    ricerche,
    imposta: (r: EsitoRicerca) => {
      risultato = r;
    },
  };
}

test("/cerca: procedura completa a pulsanti e testo, salvataggio cifrato e prime 10 date", async () => {
  const { db, tg, scrivi, tocca, ricerche } = await ambiente();
  await scrivi(`/cerca ${CF} ${CIFRE} ${NRE}`, 50);
  assert.deepEqual(tg.cancellati, [50]);
  assert.match(tg.conPulsanti!.testo, /prima visita.*controllo/s);

  await tocca("c:t:Z");
  assert.match(tg.conPulsanti!.testo, /Dove cerco/);
  await tocca("c:z:ok");
  assert.match(tg.risposte.at(-1)!.testo ?? "", /almeno una zona/);
  await tocca("c:z:012%");
  await tocca("c:z:015146");
  assert.match(JSON.stringify(tg.conPulsanti!.tastiera), /✅ VARESE/);
  await tocca("c:z:015146"); // tolta
  await tocca("c:z:015%");
  await tocca("c:z:ok");
  assert.match(tg.conPulsanti!.testo, /In che periodo/);

  await scrivi("non so");
  assert.match(tg.ultimo, /Non ho capito il periodo/);
  await scrivi("1/12-31/1");
  assert.match(tg.conPulsanti!.testo, /A che ora/);
  await scrivi("boh");
  assert.match(tg.ultimo, /Non ho capito l'orario/);
  await scrivi("8:30-12, 18-19");
  assert.match(tg.conPulsanti!.testo, /Scelte: 08:30–12:00, 18:00–19:00/);
  await tocca("c:o:900-1020"); // 15-17, proposta
  assert.match(JSON.stringify(tg.conPulsanti!.tastiera), /✅ 15:00–17:00/);
  assert.match(JSON.stringify(tg.conPulsanti!.tastiera), /✅ 08:30–12:00/); // quella scritta, come pulsante
  await tocca("c:o:1080-1140"); // toglie 18-19
  await tocca("c:o:ok");
  assert.match(tg.conPulsanti!.testo, /VARESE, MILANO PROVINCIA/);
  assert.match(tg.conPulsanti!.testo, /dal 01\/12\/2026 al 31\/01\/2027/);
  assert.match(tg.conPulsanti!.testo, /Orario: 08:30–12:00, 15:00–17:00/);

  await tocca("c:ok");
  assert.equal(ricerche.length, 1);
  assert.equal(ricerche[0].tipo, "Z");
  assert.deepEqual(
    ricerche[0].filtri.zone.map((z) => z.codice),
    ["012%", "015%"],
  );
  assert.deepEqual(ricerche[0].filtri.fasce, [
    { da: 510, a: 720 },
    { da: 900, a: 1020 },
  ]);
  assert.match(tg.ultimo, /Ricerca #1/);
  assert.match(tg.ultimo, /Le prime 10 date libere/);
  assert.equal((tg.ultimo.match(/^\d+\. /gm) ?? []).length, 10);
  assert.equal(tg.messaggi.at(-1)!.tastiera!.flat().length, 12); // 📅 1 … 📅 10, 🔔, 🗑
  assert.match(tg.ultimo, /Non ripeto questa ricerca/);

  const [c] = await leggiControlli(db, CHIAVE, UTENTE);
  assert.equal(c.modalita, "cerca");
  const grezzo = JSON.stringify((await db.execute("SELECT * FROM controlli")).rows);
  for (const s of [CF, NRE, "VISITA CARDIOLOGICA", "VARESE"]) assert.ok(!grezzo.includes(s), s);
  assert.equal((await db.execute("SELECT * FROM bozze")).rows.length, 0);
});

test("/cerca: tipo dalla ricetta salta la domanda; periodo e orario a pulsanti; ricetta già prenotata segnalata", async () => {
  const { tg, scrivi, tocca, ricerche } = await ambiente({ tipo: "O", prenotata: true });
  await scrivi(`/cerca ${CF} ${CIFRE} ${NRE}`);
  assert.match(tg.conPulsanti!.testo, /Dove cerco/);
  assert.match(tg.conPulsanti!.testo, /già prenotata: gio 29\/04\/2027 08:30, OSPEDALE DEL PONTE/);
  await tocca("c:z:012%");
  await tocca("c:z:ok");
  await tocca("c:d:30");
  await tocca("c:o:420-540");
  await tocca("c:o:tutto"); // toglie tutto
  assert.doesNotMatch(JSON.stringify(tg.conPulsanti!.tastiera), /✅/);
  await tocca("c:o:ok"); // senza fasce: tutto il giorno
  assert.match(tg.conPulsanti!.testo, /fino al 24\/12\/2026/);
  assert.match(tg.conPulsanti!.testo, /Orario: tutto il giorno/);
  await tocca("c:ok");
  assert.equal(ricerche[0].filtri.al, "20261224");
  assert.deepEqual(ricerche[0].filtri.fasce, []);
});

test(`/cerca: al massimo ${MAX_ZONE} zone; pulsanti vecchi o annullati non fanno nulla`, async () => {
  const { tg, scrivi, tocca, db } = await ambiente({ tipo: "O" });
  await scrivi(`/cerca ${CF} ${CIFRE} ${NRE}`);
  const primo = tg.conPulsanti!.id;
  for (const z of ZONE) await tocca(`c:z:${z.codice}`);
  assert.match(tg.risposte.at(-1)!.testo ?? "", /Al massimo 4/);
  assert.equal((JSON.stringify(tg.conPulsanti!.tastiera).match(/✅/g) ?? []).length, MAX_ZONE);

  await tocca("c:no");
  assert.match(tg.messaggi.find((m) => m.id === primo)!.testo, /annullata/);
  assert.equal((await db.execute("SELECT * FROM bozze")).rows.length, 0);
  await tocca("c:z:ok", primo);
  assert.match(tg.risposte.at(-1)!.testo ?? "", /scaduta/);
});

// ---- giro periodico della ricerca ----------------------------------------------------------------

test("giro della ricerca: avvisa per una data migliore, tace per una peggiore, si ferma se si prenota", async () => {
  const { db, tg, scrivi, tocca, ctx, imposta } = await ambiente({ tipo: "O" });
  await scrivi(`/cerca ${CF} ${CIFRE} ${NRE}`);
  await tocca("c:z:012%");
  await tocca("c:z:ok");
  await tocca("c:d:0");
  await tocca("c:o:ok");
  await tocca("c:ok");
  const n = tg.messaggi.length;

  const base = Array.from({ length: 14 }, (_, i) => libera(`202612${String(i + 1).padStart(2, "0")}090000`));
  // Una data più tardi della decima: niente messaggio.
  imposta({ appuntamento: null, date: [...base.slice(0, 10), libera("20261231090000")], zoneInErrore: [] });
  let [c] = await leggiControlli(db, CHIAVE);
  assert.equal(await controllaUno(c, ctx), "ok");
  assert.equal(tg.messaggi.length, n);

  // Una data prima: messaggio con 🆕.
  imposta({ appuntamento: null, date: [libera("20261125150000"), ...base], zoneInErrore: [] });
  [c] = await leggiControlli(db, CHIAVE);
  assert.equal(await controllaUno(c, ctx), "notificato");
  assert.match(tg.ultimo, /🆕 <b>mer 25\/11\/2026 15:00<\/b>/);

  // La ricetta ora è prenotata: la ricerca finisce.
  imposta({
    appuntamento: { data: "20261125150000", prestazione: "VISITA", presidio: luogo("P1"), agenda: luogo("A1"), unita: null },
    date: [],
    zoneInErrore: [],
  });
  [c] = await leggiControlli(db, CHIAVE);
  assert.equal(await controllaUno(c, ctx), "finito");
  assert.match(tg.ultimo, /ora è prenotata/);
  assert.equal((await leggiControlli(db, CHIAVE)).length, 0);
});

test("ricerca senza 🔔: il cron non la ripete e dopo un'ora la cancella; con 🔔 sì; 🗑 la chiude", async () => {
  const { db, tg, scrivi, tocca, ctx, ricerche } = await ambiente({ tipo: "O" });
  const fai = async () => {
    await scrivi(`/cerca ${CF} ${CIFRE} ${NRE}`);
    await tocca("c:z:012%");
    await tocca("c:z:ok");
    await tocca("c:d:0");
    await tocca("c:o:ok");
    await tocca("c:ok");
    return tg.conPulsanti!.id;
  };
  const giro = () => giroDiControllo({ ...ctx, limite: Date.now() + 60_000 });

  const risultati = await fai();
  assert.equal((await giro()).controlli, 0);
  assert.equal(ricerche.length, 1); // il cron non ha cercato
  assert.equal((await leggiControlli(db, CHIAVE)).length, 1); // ma resta, per i pulsanti 📅

  await tocca("m:1", risultati);
  assert.match(tg.ultimo, /🔔 Ricerca #1: la ripeto/);
  assert.equal((await giro()).controlli, 1);
  assert.equal(ricerche.length, 2);

  // Una seconda ricerca, non monitorata, vecchia di due ore: il giro la cancella.
  await fai();
  await db.execute({ sql: "UPDATE controlli SET creato = ? WHERE id = 2", args: [new Date(Date.now() - 2 * 3600_000).toISOString()] });
  await giro();
  assert.deepEqual((await leggiControlli(db, CHIAVE)).map((c) => c.id), [1]);

  // 🗑 su una terza.
  const terza = await fai();
  await tocca("mx:3", terza);
  assert.match(tg.ultimo, /Ricerca #3 chiusa/);
  assert.deepEqual((await leggiControlli(db, CHIAVE)).map((c) => c.id), [1]);
  await tocca("m:3", terza);
  assert.match(tg.risposte.at(-1)!.testo ?? "", /non c'è più/i);
});

test("/stato e /stop mostrano anche le ricerche", async () => {
  const { tg, scrivi, tocca } = await ambiente({ tipo: "O" });
  await scrivi(`/cerca ${CF} ${CIFRE} ${NRE}`);
  await tocca("c:z:012%");
  await tocca("c:z:ok");
  await tocca("c:d:0");
  await tocca("c:o:ok");
  await tocca("c:ok");
  await scrivi("/stato");
  assert.match(tg.ultimo, /<b>#1<\/b> 🔎 Ricerca: VISITA CARDIOLOGICA/);
  assert.match(tg.ultimo, /Prima data trovata: mar 01\/12\/2026 09:00/);
  await scrivi("/stop");
  assert.match(tg.ultimo, /Ricerca #1 fermata/);
});

// ---- migrazione ----------------------------------------------------------------------------------

test("migrazione: il database della prima versione prende la colonna modalita (anticipa)", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE controlli (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, utente_id TEXT NOT NULL, dati TEXT NOT NULL,
    contesto TEXT NOT NULL, tipo TEXT NOT NULL, creato TEXT NOT NULL, ultimo_controllo TEXT, ultimo_esito TEXT,
    errori INTEGER NOT NULL DEFAULT 0)`);
  await db.execute(`INSERT INTO controlli (chat_id, utente_id, dati, contesto, tipo, creato) VALUES ('1','1','x','y','O','t')`);
  await preparaDb(db);
  const r = await db.execute("SELECT modalita FROM controlli");
  assert.equal(r.rows[0].modalita, "anticipa");
});
