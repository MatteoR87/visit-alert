import assert from "node:assert/strict";
import { test } from "node:test";
import { autorizzato } from "../lib/ambiente.js";
import { diagnosi } from "../lib/diagnosi.js";
import { BASE, ErrorePrenota, InCoda, SessionePrenota } from "../lib/prenota.js";

const ATTESA = "https://attesa.servizirl.it/?c=lutech&e=pspronlprod";
const b64 = (s: string) => Buffer.from(s).toString("base64");

type Chiamata = { url: string; init: RequestInit };

/** Sito finto: Queue-it in safetynet (o coda attiva), F5 con cookie, jsonBroker. */
function sitoFinto(opz: { coda?: boolean; eccezione?: string } = {}) {
  const chiamate: Chiamata[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    chiamate.push({ url, init });
    const h = new Headers();
    if (url === BASE && !chiamate.some((c) => c.url.includes("queueittoken"))) {
      h.append("set-cookie", "TS01=abc; Path=/");
      h.set("location", ATTESA);
      return new Response(null, { status: 302, headers: h });
    }
    if (url.startsWith("https://attesa.servizirl.it")) {
      if (opz.coda) return new Response("<html>sei in coda</html>", { status: 200 });
      h.append("set-cookie", "Queue-it-visitorsession=q1; Domain=.servizirl.it; Path=/");
      h.set("location", `${BASE}?queueittoken=e_x~q_1`);
      return new Response(null, { status: 302, headers: h });
    }
    if (url.includes("queueittoken")) {
      h.append("set-cookie", "QueueITAccepted-SDFrts345E-V3_pspronlprod=ok; Path=/prenotaonline");
      h.set("location", BASE);
      return new Response(null, { status: 302, headers: h });
    }
    if (url === BASE) return new Response("<html>app</html>", { status: 200 });
    if (url === `${BASE}jsonBroker`) {
      const corpo = String(init.body);
      const dest = JSON.parse(decodeURIComponent(corpo.split("&jsonBusinessArg0=")[0].slice("metadata=".length))).destination;
      if (opz.eccezione && dest === "pgpcitt_ricerca_ats")
        return Response.json({ result: null, exception: { code: opz.eccezione } });
      const result =
        dest === "pgpcitt_genera_token"
          ? "tok-123"
          : dest === "pgpcitt_ricerca_parametro"
            ? JSON.stringify([
                { nome: "release.version", valore: b64("04.20.29") },
                { nome: "token.separator", valore: b64(" | ") },
              ])
            : JSON.stringify([{ codice: "030321" }, { codice: "030322" }]);
      return Response.json({ uuid: "u", result, exception: null });
    }
    return new Response("non trovato", { status: 404 });
  }) as typeof fetch;
  return { f, chiamate };
}

test("passa dalla sala d'attesa tenendo i cookie e chiama jsonBroker col token", async () => {
  const { f, chiamate } = sitoFinto();
  const s = new SessionePrenota({ fetch: f });
  await s.apri();
  const p = await s.parametri();
  assert.equal(p["release.version"], "04.20.29");
  const ats = await s.chiama<unknown[]>("pgpcitt_ricerca_ats", {});
  assert.equal(ats.length, 2);

  const ultima = chiamate.at(-1)!;
  const h = new Headers(ultima.init.headers);
  assert.equal(h.get("x-prenota-online-token"), "tok-123");
  assert.equal(h.get("x-prenota-online-channel"), "WEB");
  assert.match(h.get("x-prenota-online-info") ?? "", /^04\.20\.29\|/);
  // I cookie del sito vanno al sito, quelli di servizirl.it no.
  assert.match(h.get("cookie") ?? "", /TS01=abc/);
  assert.match(h.get("cookie") ?? "", /QueueITAccepted/);
  assert.doesNotMatch(h.get("cookie") ?? "", /visitorsession/);
  assert.deepEqual(
    s.percorso.map((p) => p.stato),
    [302, 302, 302, 200],
  );
});

test("con la coda attiva l'apertura dà InCoda", async () => {
  const { f } = sitoFinto({ coda: true });
  await assert.rejects(new SessionePrenota({ fetch: f }).apri(), InCoda);
});

test("le eccezioni del sito diventano ErrorePrenota con il codice", async () => {
  const { f } = sitoFinto({ eccezione: "AUTH.KO" });
  const s = new SessionePrenota({ fetch: f });
  await s.apri();
  await assert.rejects(s.chiama("pgpcitt_ricerca_ats", {}), (e) => e instanceof ErrorePrenota && e.codice === "AUTH.KO");
});

test("la diagnosi riporta nomi dei cookie, mai i valori", async () => {
  const { f } = sitoFinto();
  const esito = await diagnosi({ fetch: f });
  assert.equal(esito.ok, true);
  assert.equal(esito.ats, 2);
  assert.ok(esito.cookie.includes("TS01"));
  assert.doesNotMatch(JSON.stringify(esito), /abc|tok-123/);
});

test("autorizzazione: bearer o chiave, e nessuno senza segreto", () => {
  const r = (h: Record<string, string>, q = "") => new Request(`https://x.test/api${q}`, { headers: h });
  assert.equal(autorizzato(r({ authorization: "Bearer s3gr3to" }), "s3gr3to"), true);
  assert.equal(autorizzato(r({}, "?chiave=s3gr3to"), "s3gr3to"), true);
  assert.equal(autorizzato(r({ authorization: "Bearer altro" }), "s3gr3to"), false);
  assert.equal(autorizzato(r({}, "?chiave="), null), false);
});
