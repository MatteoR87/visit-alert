// Client HTTP delle API interne di PrenotaSalute (Regione Lombardia), senza browser.
//
// Il sito è un'app Angular: tutte le operazioni passano da POST /prenotaonline/jsonBroker con
//   metadata={"destination":"<servizio>","method":"handle","argumentTypes":["java.lang.String"]}
//   jsonBusinessArg0=<argomento JSON, url-encoded>
// e le intestazioni X-Prenota-Online-Channel / -Token / -Info. La risposta è
//   { uuid, result: <stringa JSON>, warning, error, exception: { code, message } | null }.
//
// Davanti c'è la sala d'attesa Queue-it (attesa.servizirl.it): con poco traffico è in modalità "safetynet" e
// rimanda subito al sito con i cookie di accesso; con la coda attiva si resta sulla pagina d'attesa e il giro
// si salta (errore InCoda). Il firewall F5 aggiunge i suoi cookie (TS…, BIGipServer…).

export const BASE = "https://prenotasalute.regione.lombardia.it/prenotaonline/";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export class InCoda extends Error {
  constructor() {
    super("La sala d'attesa di PrenotaSalute è attiva: si riprova al prossimo giro");
  }
}

/** Errore applicativo restituito dal sito (campo `exception`), per esempio credenziali sbagliate. */
export class ErrorePrenota extends Error {
  constructor(
    readonly destinazione: string,
    readonly codice: string,
    /** Il testo dell'eccezione del sito, ripulito da possibili dati personali (vedi `ripulisci`). */
    readonly dettaglio: string | null = null,
  ) {
    super(`${destinazione}: ${codice}`);
  }
}

/**
 * Un testo del sito da poter mettere nei log: niente email, codici fiscali, codici lunghi o numeri di 5+ cifre
 * (NRE, tessera, telefoni), al massimo 300 caratteri.
 */
export function ripulisci(testo: unknown): string | null {
  if (testo == null || testo === "") return null;
  return String(testo)
    .replace(/\S+@\S+/g, "<email>")
    .replace(/\b[A-Za-z0-9]{11,}\b/g, (x) => (/\d/.test(x) && /[A-Za-z]/.test(x) ? "<codice>" : /^\d+$/.test(x) ? "<numero>" : x))
    .replace(/\d{5,}/g, "<numero>")
    .slice(0, 300);
}

type Cookie = { dominio: string; valore: string };

/** Barattolo di cookie minimo: per dominio, senza scadenze (la sessione dura un giro). */
export class Cookies {
  private readonly cookie = new Map<string, Cookie>();

  salva(url: string, intestazioni: Headers) {
    const host = new URL(url).hostname;
    for (const riga of intestazioni.getSetCookie()) {
      const [coppia, ...attributi] = riga.split(";");
      const i = coppia.indexOf("=");
      if (i < 1) continue;
      const nome = coppia.slice(0, i).trim();
      const valore = coppia.slice(i + 1).trim();
      const attrDominio = attributi.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
      const dominio = attrDominio ? attrDominio.slice(7).replace(/^\./, "").toLowerCase() : host;
      this.cookie.set(`${dominio}|${nome}`, { dominio, valore });
    }
  }

  per(url: string): string {
    const host = new URL(url).hostname;
    const coppie: string[] = [];
    for (const [chiave, c] of this.cookie) {
      if (host === c.dominio || host.endsWith(`.${c.dominio}`)) coppie.push(`${chiave.split("|")[1]}=${c.valore}`);
    }
    return coppie.join("; ");
  }

  /** Solo i nomi: i valori non si stampano mai. */
  nomi(): string[] {
    return [...this.cookie.keys()].map((k) => k.split("|")[1]);
  }
}

export type OpzioniSessione = {
  fetch?: typeof fetch;
  /** Millisecondi massimi per ogni richiesta. */
  timeoutMs?: number;
};

export class SessionePrenota {
  readonly cookies = new Cookies();
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private token: string | null = null;
  private versione = "";
  /** Separatore del token dopo il login ("token | CF | cifre"), dal parametro token.separator. */
  separatore = " | ";
  /** Redirect seguiti all'apertura (solo host e stato, per la diagnosi). */
  readonly percorso: { host: string; stato: number }[] = [];

  constructor(opzioni: OpzioniSessione = {}) {
    this.fetch = opzioni.fetch ?? fetch;
    this.timeoutMs = opzioni.timeoutMs ?? 20_000;
  }

  private async richiesta(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    headers.set("Accept-Language", "it-IT,it;q=0.9");
    const cookie = this.cookies.per(url);
    if (cookie) headers.set("Cookie", cookie);
    const r = await this.fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
    this.cookies.salva(url, r.headers);
    return r;
  }

  /** Passa dalla sala d'attesa seguendo i redirect a mano (per tenere i cookie di ogni passaggio). */
  async apri(): Promise<void> {
    let url = BASE;
    for (let salto = 0; salto < 10; salto++) {
      const r = await this.richiesta(url, { method: "GET", headers: { Accept: "text/html" } });
      this.percorso.push({ host: new URL(url).hostname, stato: r.status });
      const dove = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && dove) {
        await r.body?.cancel();
        url = new URL(dove, url).toString();
        continue;
      }
      await r.body?.cancel();
      if (new URL(url).hostname !== new URL(BASE).hostname) throw new InCoda();
      if (!r.ok) throw new Error(`Apertura del sito: HTTP ${r.status}`);
      this.token = await this.chiama<string>("pgpcitt_genera_token", {});
      return;
    }
    throw new Error("Apertura del sito: troppi redirect");
  }

  /** Chiama un servizio di jsonBroker e restituisce `result` già decodificato. */
  async chiama<T = unknown>(destinazione: string, argomento: unknown): Promise<T> {
    const metadata = JSON.stringify({ destination: destinazione, method: "handle", argumentTypes: ["java.lang.String"] });
    // Come il sito: il JSON dell'argomento con & → &amp;, poi url-encoded.
    const arg = JSON.stringify(argomento ?? {}).replace(/&/g, "&amp;");
    const corpo = `metadata=${metadata}&jsonBusinessArg0=${encodeURIComponent(arg)}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "application/json, text/plain, */*",
      "X-Prenota-Online-Channel": "WEB",
    };
    if (this.token) headers["X-Prenota-Online-Token"] = this.token;
    if (this.versione) headers["X-Prenota-Online-Info"] = `${this.versione}|Windows|10|Chrome 130.0.0.0`;

    const r = await this.richiesta(`${BASE}jsonBroker`, { method: "POST", headers, body: corpo });
    if (r.status >= 300 && r.status < 400) throw new InCoda();
    if (!r.ok) throw new Error(`${destinazione}: HTTP ${r.status}`);
    const j: any = await r.json();
    if (j.exception)
      throw new ErrorePrenota(destinazione, String(j.exception.code ?? "ERRORE"), ripulisci(j.exception.message));
    if (typeof j.result === "string") {
      try {
        return JSON.parse(j.result) as T;
      } catch {
        return j.result as T;
      }
    }
    return j.result as T;
  }

  /** Parametri pubblici del sito (valori in base64), come fa l'app all'avvio. */
  async parametri(): Promise<Record<string, string>> {
    const lista = await this.chiama<{ nome: string; valore: string }[]>("pgpcitt_ricerca_parametro", { formato: "CRIPTATO" });
    const out: Record<string, string> = {};
    for (const p of lista ?? []) out[p.nome] = Buffer.from(p.valore ?? "", "base64").toString("utf8");
    if (out["release.version"]) this.versione = out["release.version"];
    if (out["token.separator"]) this.separatore = out["token.separator"];
    return out;
  }

  /**
   * Accesso "con tessera sanitaria" (come il riquadro "Prenota con ricetta" del sito): codice fiscale e ultime
   * 5 cifre della tessera. Dopo l'accesso il token diventa `token | codice fiscale | cifre`.
   */
  async accedi(codiceFiscale: string, cifre: string): Promise<unknown> {
    if (!this.token) throw new Error("Sessione non aperta");
    const base = this.token.split(this.separatore)[0];
    this.token = base;
    const esito = await this.chiama("pgpcitt_login_gp_prv", {
      codiceFiscale,
      crs: cifre,
      dataScadenza: "",
      flagIncludiCrsNonAttive: "N",
    });
    this.token = [base, codiceFiscale, cifre].join(this.separatore);
    return esito;
  }

  get haToken() {
    return this.token !== null;
  }
}
