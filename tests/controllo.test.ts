import assert from "node:assert/strict";
import { test } from "node:test";
import { cifra, decifra } from "../lib/cifratura.js";
import { dateAnticipate, ErroreUtente, giroSito, mezzanotteRomaIso, tipoDaRicetta } from "../lib/controllo.js";
import { formatoData } from "../lib/messaggi.js";
import {
  AGENDA,
  appuntamentoSito,
  CF,
  CHIAVE,
  CIFRE,
  disponibilitaSito,
  NRE,
  PRESIDIO,
  ricettaSito,
  sitoFinto,
} from "./finti.js";

const dati = { codiceFiscale: CF, cifre: CIFRE, nre: NRE };
const ORA = new Date("2026-11-24T10:00:00Z");

test("cifratura: andata e ritorno, e una manomissione si nota", () => {
  const c = cifra("segreto", CHIAVE);
  assert.doesNotMatch(c, /segreto/);
  assert.equal(decifra(c, CHIAVE), "segreto");
  const [v, iv, tag, corpo] = c.split(":");
  const rotto = [v, iv, tag, Buffer.from("altro").toString("base64")].join(":");
  assert.throws(() => decifra(rotto, CHIAVE));
  assert.throws(() => decifra(c, Buffer.alloc(32, 1)));
  assert.notEqual(cifra("segreto", CHIAVE), c, "IV casuale: due cifrature diverse");
  void corpo;
});

test("date: mezzanotte italiana in ISO (ora solare e legale) e formato leggibile", () => {
  assert.equal(mezzanotteRomaIso("20261118"), "2026-11-17T23:00:00.000Z");
  assert.equal(mezzanotteRomaIso("20270615"), "2027-06-14T22:00:00.000Z");
  assert.equal(mezzanotteRomaIso(null), null);
  assert.equal(formatoData("20270505113000"), "mer 05/05/2027 11:30");
});

test("tipo dalla ricetta come il sito, null quando il sito chiederebbe", () => {
  assert.equal(tipoDaRicetta({ tipoPrestazione: "Z" }), "Z");
  assert.equal(tipoDaRicetta({ priorita: "U", prestazioni: [] }), "U");
  assert.equal(tipoDaRicetta({ prestazioni: [{ descrizione: "VISITA CARDIOLOGICA (PRIMA VISITA)" }] }), "O");
  assert.equal(tipoDaRicetta({ prestazioni: [{ descrizione: "VISITA (CONTROLLO)" }] }), "Z");
  assert.equal(tipoDaRicetta({ flagEsenzionePatologia: "S", prestazioni: [{ descrizione: "ECO" }] }), "Z");
  assert.equal(tipoDaRicetta({ prestazioni: [{ descrizione: "ECOCOLORDOPPLERGRAFIA" }] }), null);
});

test("giro: accesso, ricetta, zona, disponibilità con la ricetta nel formato del sito, sblocco", async () => {
  const { f, chiamate } = sitoFinto({
    pgpcitt_ricerca_ricetta: () => ricettaSito([appuntamentoSito("20270429")]),
    pgpcitt_ricerca_disponibilita: () => disponibilitaSito(["20270415", "20270505"]),
  });
  const r = await giroSito(dati, { fetch: f, ora: ORA });
  assert.equal(r.appuntamento?.data, "20270429083000");
  assert.equal(r.tipo, "O");
  assert.deepEqual(r.zona, { descrizione: "VARESE", codiceProvincia: "012", codiceComune: "%", codice: "012%" });
  assert.deepEqual(
    dateAnticipate(r.appuntamento!, r.date).map((d) => d.data),
    ["20270415113000"],
  );

  const sequenza = chiamate.map((c) => c.destinazione);
  assert.deepEqual(sequenza, [
    "pgpcitt_genera_token",
    "pgpcitt_ricerca_parametro",
    "pgpcitt_login_gp_prv",
    "pgpcitt_ricerca_ricetta",
    "pgpcitt_ricerca_zona",
    "pgpcitt_ricerca_disponibilita",
    "pgpcitt_sblocca_ricetta_elettronica",
  ]);
  const disp = chiamate.find((c) => c.destinazione === "pgpcitt_ricerca_disponibilita")!.arg;
  assert.equal(disp.ricetta.emessaIl, "20261118"); // come il sito: la stringa resta com'è
  assert.equal(disp.ricetta.prestazioniPrenotate.length, 1);
  assert.equal(disp.ricetta.appuntamentiUnificati, null);
  assert.equal(disp.vincoliTemporali.dal, "20261124000000");
  assert.equal(disp.tipoPrestazione, "O");
  assert.deepEqual(chiamate.at(-1)!.arg, { codiceFiscale: CF, nre: NRE });
  assert.equal(chiamate.at(-1)!.token, `tok | ${CF} | ${CIFRE}`);
});

test("tipo non deducibile: se con O le date non sono nella stessa agenda si prova Z", async () => {
  const { f, chiamate } = sitoFinto({
    pgpcitt_ricerca_ricetta: () => ricettaSito([appuntamentoSito()]),
    pgpcitt_ricerca_disponibilita: (a) =>
      a.tipoPrestazione === "Z"
        ? disponibilitaSito(["20270410"])
        : disponibilitaSito(["20270401"], { codice: "ALTRA", descrizione: "adulti" }),
  });
  const r = await giroSito(dati, { fetch: f, ora: ORA });
  assert.equal(r.tipo, "Z");
  assert.equal(r.date[0].agenda.codice, AGENDA.codice);
  assert.equal(chiamate.filter((c) => c.destinazione === "pgpcitt_ricerca_disponibilita").length, 2);
});

test("con il tipo e la zona già noti si fa una sola ricerca e niente zona", async () => {
  const { f, chiamate } = sitoFinto({
    pgpcitt_ricerca_ricetta: () => ricettaSito([appuntamentoSito()]),
    pgpcitt_ricerca_disponibilita: () => disponibilitaSito([]),
  });
  await giroSito(dati, { fetch: f, ora: ORA, tipo: "O", zona: { codice: "012%" } });
  assert.ok(!chiamate.some((c) => c.destinazione === "pgpcitt_ricerca_zona"));
  assert.equal(chiamate.filter((c) => c.destinazione === "pgpcitt_ricerca_disponibilita").length, 1);
});

test("la ricetta si sblocca anche se la ricerca delle disponibilità fallisce", async () => {
  const { f, chiamate } = sitoFinto({
    pgpcitt_ricerca_ricetta: () => ricettaSito([appuntamentoSito()]),
    pgpcitt_ricerca_disponibilita: () => ({ eccezione: "ES0001" }),
  });
  await assert.rejects(giroSito(dati, { fetch: f, ora: ORA, tipo: "O" }));
  assert.equal(chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
});

test("errori comprensibili: accesso rifiutato e ricetta non trovata", async () => {
  const login = sitoFinto({ pgpcitt_login_gp_prv: () => ({ eccezione: "LOGIN.KO" }) });
  await assert.rejects(giroSito(dati, { fetch: login.f }), (e) => e instanceof ErroreUtente && /Accesso rifiutato/.test(e.message));
  assert.ok(!login.chiamate.some((c) => c.destinazione === "pgpcitt_sblocca_ricetta_elettronica"));

  const ricetta = sitoFinto({ pgpcitt_ricerca_ricetta: () => ({ eccezione: "RICETTA.RICERCA.KO" }) });
  await assert.rejects(giroSito(dati, { fetch: ricetta.f }), (e) => e instanceof ErroreUtente && /NRE/.test(e.message));
  assert.equal(ricetta.chiamate.at(-1)!.destinazione, "pgpcitt_sblocca_ricetta_elettronica");
});

test("appuntamenti passati o annullati non contano", async () => {
  const { f } = sitoFinto({
    pgpcitt_ricerca_ricetta: () =>
      ricettaSito([appuntamentoSito("20260101"), { ...appuntamentoSito("20270429"), annullatoIl: "20261120" }]),
  });
  const r = await giroSito(dati, { fetch: f, ora: ORA });
  assert.equal(r.appuntamento, null);
});

test("anticipate: solo stesso presidio e prima dell'appuntamento", () => {
  const app = {
    data: "20270429083000",
    prestazione: "ECO",
    presidio: { codice: PRESIDIO.codice, descrizione: "" },
    agenda: { codice: AGENDA.codice, descrizione: "" },
    unita: null,
  };
  const d = (data: string, presidio = PRESIDIO.codice) => ({
    data,
    presidio: { codice: presidio, descrizione: "" },
    agenda: { codice: AGENDA.codice, descrizione: "" },
    unita: null,
  });
  const r = dateAnticipate(app, [d("20270401083000"), d("20270402083000", "ALTRO"), d("20270429083000"), d("20270430083000")]);
  assert.deepEqual(
    r.map((x) => x.data),
    ["20270401083000"],
  );
});
