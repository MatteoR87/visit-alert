// Servizi finti per i test: sito PrenotaSalute, Telegram e database in memoria.
import { createClient, type Client } from "@libsql/client";
import { preparaDb } from "../lib/db.js";
import { BASE } from "../lib/prenota.js";

export const CHIAVE = Buffer.alloc(32, 7);
export const CF = "RSSMRA80A01F205X";
export const CIFRE = "12345";
export const NRE = "030A01234567890";

export async function dbFinto(): Promise<Client> {
  return preparaDb(createClient({ url: ":memory:" }));
}

export class TelegramFinto {
  messaggi: { chatId: string; testo: string }[] = [];
  cancellati: number[] = [];
  async manda(chatId: string | number, testo: string) {
    this.messaggi.push({ chatId: String(chatId), testo });
  }
  async cancella(_chatId: string | number, messageId: number) {
    this.cancellati.push(messageId);
    return true;
  }
  get ultimo() {
    return this.messaggi.at(-1)?.testo ?? "";
  }
}

export function data(giorno: string, ora = "083000") {
  return `${giorno}${ora}`;
}

export const PRESIDIO = {
  codice: "002591",
  descrizione: "OSPEDALE F. DEL PONTE - Varese",
  puntoIndirizzo: { localita: { codice: "012133" } },
};
export const AGENDA = { codice: "05114^1", descrizione: "ECOCARDIOGRAMMA PEDI" };

export function appuntamentoSito(giorno = "20270429", presidio = PRESIDIO) {
  return {
    data: data(giorno),
    annullatoIl: null,
    prestazione: { descrizione: "ECOCOLORDOPPLERGRAFIA CARDIACA A RIPOSO" },
    unitaErogante: { presidio, descrizione: "Cardiologia pediatrica" },
    agenda: AGENDA,
    regimeErogazione: "1",
  };
}

export function disponibilitaSito(giorni: string[], agenda = AGENDA, presidio = PRESIDIO) {
  return {
    singole: giorni.map((g) => ({
      appuntamento: { data: data(g, "113000"), unitaErogante: { presidio, descrizione: "Cardiologia pediatrica" }, agenda },
    })),
    combinate: [],
    associate: [],
    presidi: [],
  };
}

type Risposta = unknown | { eccezione: string };
export type Gestori = Record<string, (arg: any) => Risposta>;

/** Il sito finto: Queue-it in safetynet e jsonBroker con un gestore per servizio. Registra le chiamate. */
export function sitoFinto(gestori: Gestori) {
  const chiamate: { destinazione: string; arg: any; token: string | null }[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url === BASE) return new Response("<html>app</html>", { status: 200 });
    if (url !== `${BASE}jsonBroker`) return new Response("no", { status: 404 });
    const corpo = String(init.body);
    const [meta, arg] = corpo.split("&jsonBusinessArg0=");
    const destinazione = JSON.parse(meta.slice("metadata=".length)).destination;
    const argomento = JSON.parse(decodeURIComponent(arg).replace(/&amp;/g, "&"));
    chiamate.push({ destinazione, arg: argomento, token: new Headers(init.headers).get("x-prenota-online-token") });
    const base: Gestori = {
      pgpcitt_genera_token: () => "tok",
      pgpcitt_ricerca_parametro: () => [],
      pgpcitt_login_gp_prv: () => ({ cittadino: { telefono: "000", email: "x@y.z" } }),
      pgpcitt_ricerca_zona: () => [{ descrizione: "VARESE", codiceProvincia: "012", codiceComune: "%" }],
      pgpcitt_sblocca_ricetta_elettronica: () => ({}),
    };
    const g = gestori[destinazione] ?? base[destinazione];
    if (!g) return Response.json({ result: null, exception: { code: `NON.PREVISTO.${destinazione}` } });
    const r = g(argomento) as any;
    if (r && typeof r === "object" && "eccezione" in r) return Response.json({ result: null, exception: { code: r.eccezione } });
    return Response.json({ uuid: "u", result: JSON.stringify(r), exception: null });
  }) as typeof fetch;
  return { f, chiamate };
}

export function ricettaSito(appuntamenti: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ricette: [
      {
        emessaIl: "20261118",
        scadenzaIl: null,
        priorita: "P",
        tipoPrestazione: null,
        flagEsenzionePatologia: null,
        prestazioni: [{ descrizione: "ECOCOLORDOPPLERGRAFIA CARDIACA A RIPOSO", stato: { codice: "03" } }],
        appuntamenti: { singoli: appuntamenti },
        ...extra,
      },
    ],
  };
}
