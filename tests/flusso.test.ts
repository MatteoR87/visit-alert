// Bot e giro periodico insieme, con sito (giroSito) finto, Telegram finto e database in memoria.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gestisciAggiornamento, leggiAvvia, sogliaCron } from "../lib/bot.js";
import type { DataLibera, EsitoSito } from "../lib/controllo.js";
import { leggiControlli } from "../lib/db.js";
import { controllaUno, ERRORI_PER_AVVISO, giroDiControllo, type GiroSito } from "../lib/monitor.js";
import { InCoda } from "../lib/prenota.js";
import { CF, CHIAVE, CIFRE, dbFinto, NRE, TelegramFinto } from "./finti.js";

const UTENTE = "111";
const CHAT = "111";

const luogo = (codice: string) => ({ codice, descrizione: `Luogo ${codice}` });
const appuntamento = (data = "20270429083000", presidio = "P1") => ({
  data,
  prestazione: "ECOCOLORDOPPLERGRAFIA",
  presidio: luogo(presidio),
  agenda: luogo("A1"),
  unita: null,
});
const libera = (data: string, presidio = "P1"): DataLibera => ({ data, presidio: luogo(presidio), agenda: luogo("A1"), unita: null });

/** Un sito finto che risponde con quello che c'è in `stato` al momento della chiamata. */
function sitoProgrammabile() {
  const stato: { esito: EsitoSito | Error } = {
    esito: { appuntamento: appuntamento(), date: [libera("20270505113000")], tipo: "O", zona: { codice: "012%" } },
  };
  const chiamate: { tipo: unknown }[] = [];
  const giro: GiroSito = async (_dati, opz) => {
    chiamate.push({ tipo: opz.tipo });
    if (stato.esito instanceof Error) throw stato.esito;
    return structuredClone(stato.esito);
  };
  return { stato, giro, chiamate };
}

async function ambiente() {
  const db = await dbFinto();
  const tg = new TelegramFinto();
  const sito = sitoProgrammabile();
  const ctx = { db, chiave: CHIAVE, utenti: new Set([UTENTE]), tg, giro: sito.giro };
  const scrivi = (text: string, from = UTENTE, message_id = 1) =>
    gestisciAggiornamento({ message: { message_id, text, chat: { id: Number(CHAT) }, from: { id: Number(from) } } }, ctx);
  return { db, tg, sito, ctx, scrivi };
}

test("leggiAvvia: valida e normalizza i dati", () => {
  assert.deepEqual(leggiAvvia([CF.toLowerCase(), CIFRE, "030a-0123-4567890"]), {
    ok: true,
    codiceFiscale: CF,
    cifre: CIFRE,
    nre: NRE,
    tipo: null,
  });
  assert.equal(leggiAvvia([CF, "1234", NRE]).ok, false);
  assert.equal(leggiAvvia([CF, CIFRE, NRE, "X"]).ok, false);
  assert.equal(leggiAvvia([CF, CIFRE]).ok, false);
});

test("/avvia: cancella il messaggio, salva cifrato, risponde con l'appuntamento", async () => {
  const { db, tg, scrivi } = await ambiente();
  await scrivi(`/avvia ${CF} ${CIFRE} ${NRE}`, UTENTE, 42);
  assert.deepEqual(tg.cancellati, [42]);
  assert.match(tg.ultimo, /Controllo #1 avviato/);
  assert.match(tg.ultimo, /gio 29\/04\/2027 08:30/);
  assert.match(tg.ultimo, /mer 05\/05\/2027 11:30/); // prima libera nella struttura

  // Nel database niente dati sanitari in chiaro.
  const grezzo = JSON.stringify((await db.execute("SELECT * FROM controlli")).rows);
  for (const segreto of [CF, CIFRE, NRE, "ECOCOLORDOPPLERGRAFIA", "20270429"]) assert.ok(!grezzo.includes(segreto), segreto);
  const [c] = await leggiControlli(db, CHIAVE, UTENTE);
  assert.deepEqual(c.dati, { codiceFiscale: CF, cifre: CIFRE, nre: NRE });
  assert.equal(c.tipo, "O");
});

test("/avvia da chi non è abilitato: il messaggio si cancella comunque e non si salva nulla", async () => {
  const { db, tg, scrivi } = await ambiente();
  await scrivi(`/avvia ${CF} ${CIFRE} ${NRE}`, "999", 7);
  assert.deepEqual(tg.cancellati, [7]);
  assert.match(tg.ultimo, /Non sei abilitato/);
  assert.equal((await leggiControlli(db, CHIAVE)).length, 0);
});

test("/avvia con dati sbagliati: messaggio cancellato e spiegazione", async () => {
  const { tg, scrivi } = await ambiente();
  await scrivi(`/avvia ${CF} 12 ${NRE}`, UTENTE, 9);
  assert.deepEqual(tg.cancellati, [9]);
  assert.match(tg.ultimo, /ultime 5/);
});

test("/avvia con date già anticipate le manda subito; il giro dopo non le ripete", async () => {
  const { db, tg, sito, ctx, scrivi } = await ambiente();
  sito.stato.esito = { appuntamento: appuntamento(), date: [libera("20270410083000"), libera("20270505113000")], tipo: "O", zona: null };
  await scrivi(`/avvia ${CF} ${CIFRE} ${NRE}`);
  assert.match(tg.ultimo, /Date libere prima/);
  assert.match(tg.ultimo, /🆕 sab 10\/04\/2027 08:30/);

  const n = tg.messaggi.length;
  const [c] = await leggiControlli(db, CHIAVE);
  assert.equal(await controllaUno(c, ctx), "ok");
  assert.equal(tg.messaggi.length, n);
});

test("giro: una data anticipata nuova si notifica una volta, con tutte le altre", async () => {
  const { db, tg, sito, ctx, scrivi } = await ambiente();
  await scrivi(`/avvia ${CF} ${CIFRE} ${NRE}`);
  const n = tg.messaggi.length;

  sito.stato.esito = {
    appuntamento: appuntamento(),
    date: [libera("20270401083000"), libera("20270402083000", "ALTRO"), libera("20270505113000")],
    tipo: "O",
    zona: null,
  };
  const esito = await giroDiControllo({ ...ctx, limite: Date.now() + 10_000 });
  assert.equal(esito.notificato, 1);
  assert.equal(tg.messaggi.length, n + 1);
  assert.match(tg.ultimo, /🆕 gio 01\/04\/2027 08:30/);
  assert.doesNotMatch(tg.ultimo, /02\/04\/2027/); // altro presidio

  sito.stato.esito = { ...sito.stato.esito, date: [libera("20270401083000"), libera("20270403083000")] };
  const [c] = await leggiControlli(db, CHIAVE);
  assert.equal(await controllaUno(c, ctx), "notificato");
  assert.match(tg.ultimo, /• gio 01\/04\/2027/);
  assert.match(tg.ultimo, /🆕 sab 03\/04\/2027/);
  assert.equal(sito.chiamate.at(-1)!.tipo, "O"); // il tipo salvato si riusa
});

test("giro: appuntamento cambiato si segnala; appuntamento sparito ferma il controllo", async () => {
  const { db, tg, sito, ctx, scrivi } = await ambiente();
  await scrivi(`/avvia ${CF} ${CIFRE} ${NRE}`);

  sito.stato.esito = { appuntamento: appuntamento("20270420083000"), date: [], tipo: "O", zona: null };
  let [c] = await leggiControlli(db, CHIAVE);
  await controllaUno(c, ctx);
  assert.match(tg.ultimo, /appuntamento è cambiato/);
  [c] = await leggiControlli(db, CHIAVE);
  assert.equal(c.modalita, "anticipa");
  if (c.modalita === "anticipa") assert.equal(c.contesto.appuntamento.data, "20270420083000");

  sito.stato.esito = { appuntamento: null, date: [], tipo: "O", zona: null };
  assert.equal(await controllaUno(c, ctx), "finito");
  assert.match(tg.ultimo, /non ha più un appuntamento futuro/);
  assert.equal((await leggiControlli(db, CHIAVE)).length, 0);
});

test("giro: errori di fila avvisano una volta, poi il ritorno; la coda non conta", async () => {
  const { db, tg, sito, ctx, scrivi } = await ambiente();
  await scrivi(`/avvia ${CF} ${CIFRE} ${NRE}`);
  const n = tg.messaggi.length;

  sito.stato.esito = new InCoda();
  let [c] = await leggiControlli(db, CHIAVE);
  assert.equal(await controllaUno(c, ctx), "coda");
  [c] = await leggiControlli(db, CHIAVE);
  assert.equal(c.errori, 0);

  sito.stato.esito = new Error("HTTP 503");
  for (let i = 0; i < ERRORI_PER_AVVISO + 1; i++) {
    [c] = await leggiControlli(db, CHIAVE);
    await controllaUno(c, ctx);
  }
  assert.equal(tg.messaggi.length, n + 1);
  assert.match(tg.ultimo, /non riesce a leggere/);

  sito.stato.esito = { appuntamento: appuntamento(), date: [], tipo: "O", zona: null };
  [c] = await leggiControlli(db, CHIAVE);
  await controllaUno(c, ctx);
  assert.match(tg.ultimo, /funziona di nuovo/);
});

test("/stato, /date e /stop", async () => {
  const { db, tg, sito, scrivi } = await ambiente();
  await scrivi("/stato");
  assert.match(tg.ultimo, /Nessun controllo attivo/);

  await scrivi(`/avvia ${CF} ${CIFRE} ${NRE}`);
  await scrivi("/stato");
  assert.match(tg.ultimo, /#1/);
  assert.match(tg.ultimo, /Prima libera nella struttura: mer 05\/05\/2027/);

  await scrivi("/date");
  assert.match(tg.ultimo, /Nessuna data libera prima della tua/);
  sito.stato.esito = { appuntamento: appuntamento(), date: [libera("20270401083000")], tipo: "O", zona: null };
  await scrivi("/date");
  assert.match(tg.ultimo, /🆕 gio 01\/04\/2027/);
  await scrivi("/date 1");
  assert.match(tg.ultimo, /• gio 01\/04\/2027/); // stessa data, già notificata: la rimostra senza 🆕

  await scrivi("/stop 1");
  assert.match(tg.ultimo, /fermato/);
  assert.equal((await leggiControlli(db, CHIAVE)).length, 0);
});

test("/id risponde a tutti; gli altri comandi solo agli abilitati", async () => {
  const { tg, scrivi } = await ambiente();
  await scrivi("/id", "999");
  assert.match(tg.ultimo, /<code>999<\/code>/);
  await scrivi("/stato", "999");
  assert.match(tg.ultimo, /Non sei abilitato/);
});

test("/api/controlla?attendi=1: 500 solo per un giro fallito, non per il conteggio degli errori", async () => {
  const { giroFallito } = await import("../api/controlla.js");
  assert.equal(giroFallito({ controlli: 1, ok: 1, errore: 0 }), false);
  assert.equal(giroFallito({ controlli: 2, ok: 1, errore: 1 }), false);
  assert.equal(giroFallito({ errore: "Turso non risponde" }), true);
});

test("soglie del cron: più larghe di notte", () => {
  assert.deepEqual(sogliaCron(new Date("2026-11-24T02:00:00Z")), { giallo: 75, rosso: 130 }); // 03:00 in Italia
  assert.deepEqual(sogliaCron(new Date("2026-11-24T12:00:00Z")), { giallo: 25, rosso: 60 });
});
