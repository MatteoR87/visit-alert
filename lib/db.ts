// Database su Turso (SQLite ospitato), via HTTP: adatto alle funzioni serverless.
// Le tabelle si creano (e si aggiornano) da sole al primo uso. In chiaro solo ID, modalità, tipo, orari e
// contatori: dati sanitari, appuntamento, filtri e date sono cifrati con CHIAVE_CIFRATURA.
import type { Client } from "@libsql/client";
import { cifraJson, decifraJson } from "./cifratura.js";
import type { Appuntamento, DataLibera, DatiRicetta, Filtri, Proposte, Tipo, Zona } from "./controllo.js";

/** Le disponibilità grezze delle date mostrate (le prime 10), con l'ora della ricerca che le ha trovate. */
export type ProposteSalvate = { quando: string; singole: Proposte };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS controlli (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    utente_id TEXT NOT NULL,
    dati TEXT NOT NULL,
    contesto TEXT NOT NULL,
    tipo TEXT NOT NULL,
    creato TEXT NOT NULL,
    ultimo_controllo TEXT,
    ultimo_esito TEXT,
    errori INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS stato (
    chiave TEXT PRIMARY KEY,
    valore TEXT NOT NULL,
    aggiornato TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bozze (
    utente_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    contenuto TEXT NOT NULL,
    aggiornato TEXT NOT NULL
  )`,
];

/** Colonne aggiunte dopo la prima versione: si aggiungono alle tabelle che non le hanno. */
const COLONNE_NUOVE = [{ tabella: "controlli", colonna: "modalita", definizione: "TEXT NOT NULL DEFAULT 'anticipa'" }];

/** Anticipare un appuntamento già prenotato (quello che serve tra un giro e l'altro, cifrato). */
export type ContestoAnticipa = {
  appuntamento: Appuntamento;
  zona: Zona | null;
  /** Chiavi delle date anticipate già mandate (chiaveData). */
  notificate: string[];
  /** Le date anticipate dell'ultimo giro, per /date. */
  anticipate: DataLibera[];
  /** Prima data libera nella struttura all'ultimo giro (anche se dopo l'appuntamento). */
  primaData: DataLibera | null;
  proposte?: ProposteSalvate;
};

/** Ricerca nuova con filtri. */
export type ContestoCerca = {
  prestazione: string;
  filtri: Filtri;
  /** Data dell'appuntamento che la ricetta aveva già all'avvio (se no, una prenotazione nuova ferma la ricerca). */
  appuntamentoIniziale: string | null;
  /** Le prime date dell'ultimo giro. */
  risultati: DataLibera[];
  /** Chiavi dei risultati già mandati. */
  notificate: string[];
  proposte?: ProposteSalvate;
  /**
   * false: ricerca fatta una volta sola, il cron non la ripete e dopo DURATA_RICERCA_SINGOLA_MS si cancella
   * (finché non si tocca 🔔). Assente (ricerche della prima versione) vale true.
   */
  monitora?: boolean;
};

/** Quanto resta salvata una ricerca senza monitoraggio (per poter prenotare dai suoi pulsanti). */
export const DURATA_RICERCA_SINGOLA_MS = 60 * 60_000;

/** Se il cron deve ripetere questo controllo. */
export const monitorato = (c: Controllo) => c.modalita !== "cerca" || c.contesto.monitora !== false;

type Comune = {
  id: number;
  chatId: string;
  utenteId: string;
  dati: DatiRicetta;
  tipo: Tipo;
  creato: string;
  ultimoControllo: string | null;
  ultimoEsito: string | null;
  errori: number;
};
export type ControlloAnticipa = Comune & { modalita: "anticipa"; contesto: ContestoAnticipa };
export type ControlloCerca = Comune & { modalita: "cerca"; contesto: ContestoCerca };
export type Controllo = ControlloAnticipa | ControlloCerca;

const pronti = new WeakSet<Client>();

export async function preparaDb(db: Client) {
  if (pronti.has(db)) return db;
  for (const s of SCHEMA) await db.execute(s);
  for (const c of COLONNE_NUOVE) {
    const info = await db.execute(`PRAGMA table_info(${c.tabella})`);
    if (!info.rows.some((r) => r.name === c.colonna))
      await db.execute(`ALTER TABLE ${c.tabella} ADD COLUMN ${c.colonna} ${c.definizione}`);
  }
  pronti.add(db);
  return db;
}

export async function apriDb(amb: { tursoUrl: string; tursoToken: string }): Promise<Client> {
  const { createClient } = await import("@libsql/client/web");
  return preparaDb(createClient({ url: amb.tursoUrl, authToken: amb.tursoToken }));
}

const adesso = () => new Date().toISOString();

function daRiga(r: any, chiave: Buffer): Controllo {
  const comune: Comune = {
    id: Number(r.id),
    chatId: String(r.chat_id),
    utenteId: String(r.utente_id),
    dati: decifraJson<DatiRicetta>(String(r.dati), chiave),
    tipo: String(r.tipo) as Tipo,
    creato: String(r.creato),
    ultimoControllo: r.ultimo_controllo === null ? null : String(r.ultimo_controllo),
    ultimoEsito: r.ultimo_esito === null ? null : String(r.ultimo_esito),
    errori: Number(r.errori ?? 0),
  };
  return r.modalita === "cerca"
    ? { ...comune, modalita: "cerca", contesto: decifraJson<ContestoCerca>(String(r.contesto), chiave) }
    : { ...comune, modalita: "anticipa", contesto: decifraJson<ContestoAnticipa>(String(r.contesto), chiave) };
}

export async function nuovoControllo(
  db: Client,
  chiave: Buffer,
  c:
    | Pick<ControlloAnticipa, "chatId" | "utenteId" | "dati" | "contesto" | "tipo" | "modalita">
    | Pick<ControlloCerca, "chatId" | "utenteId" | "dati" | "contesto" | "tipo" | "modalita">,
): Promise<number> {
  const r = await db.execute({
    sql: `INSERT INTO controlli (chat_id, utente_id, dati, contesto, tipo, modalita, creato, ultimo_controllo, ultimo_esito)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
    args: [
      c.chatId,
      c.utenteId,
      cifraJson(c.dati, chiave),
      cifraJson(c.contesto, chiave),
      c.tipo,
      c.modalita,
      adesso(),
      adesso(),
    ],
  });
  return Number(r.lastInsertRowid);
}

export async function aggiornaControllo(
  db: Client,
  chiave: Buffer,
  c: { id: number; contesto: ContestoAnticipa | ContestoCerca; tipo: Tipo; ultimoEsito: string | null; errori: number },
) {
  await db.execute({
    sql: `UPDATE controlli SET contesto = ?, tipo = ?, ultimo_controllo = ?, ultimo_esito = ?, errori = ? WHERE id = ?`,
    args: [cifraJson(c.contesto, chiave), c.tipo, adesso(), c.ultimoEsito, c.errori, c.id],
  });
}

/** Tutti i controlli, i meno recenti per primi; con `utenteId` solo quelli di quell'utente, in ordine di ID. */
export async function leggiControlli(db: Client, chiave: Buffer, utenteId?: string): Promise<Controllo[]> {
  const r = utenteId
    ? await db.execute({ sql: `SELECT * FROM controlli WHERE utente_id = ? ORDER BY id`, args: [utenteId] })
    : await db.execute(`SELECT * FROM controlli ORDER BY COALESCE(ultimo_controllo, '') ASC, id ASC`);
  return r.rows.map((x) => daRiga(x, chiave));
}

export async function cancellaControllo(db: Client, id: number) {
  await db.execute({ sql: `DELETE FROM controlli WHERE id = ?`, args: [id] });
}

// ---- bozze della procedura guidata (/cerca) ------------------------------------------------------

/** Dopo quanto una bozza abbandonata non vale più. */
export const DURATA_BOZZA_MS = 60 * 60_000;

export async function scriviBozza<T>(db: Client, chiave: Buffer, utenteId: string, chatId: string, contenuto: T) {
  await db.execute({
    sql: `INSERT INTO bozze (utente_id, chat_id, contenuto, aggiornato) VALUES (?, ?, ?, ?)
          ON CONFLICT(utente_id) DO UPDATE SET chat_id = excluded.chat_id, contenuto = excluded.contenuto,
          aggiornato = excluded.aggiornato`,
    args: [utenteId, chatId, cifraJson(contenuto, chiave), adesso()],
  });
}

/** La bozza dell'utente, se non è scaduta (quelle scadute si cancellano). */
export async function leggiBozza<T>(db: Client, chiave: Buffer, utenteId: string): Promise<T | null> {
  const r = await db.execute({ sql: `SELECT contenuto, aggiornato FROM bozze WHERE utente_id = ?`, args: [utenteId] });
  const x = r.rows[0];
  if (!x) return null;
  if (Date.now() - Date.parse(String(x.aggiornato)) > DURATA_BOZZA_MS) {
    await cancellaBozza(db, utenteId);
    return null;
  }
  return decifraJson<T>(String(x.contenuto), chiave);
}

export async function cancellaBozza(db: Client, utenteId: string) {
  await db.execute({ sql: `DELETE FROM bozze WHERE utente_id = ?`, args: [utenteId] });
}

/** Le bozze abbandonate contengono dati sanitari: si cancellano a ogni giro del cron. */
export async function pulisciBozze(db: Client) {
  await db.execute({
    sql: `DELETE FROM bozze WHERE aggiornato < ?`,
    args: [new Date(Date.now() - DURATA_BOZZA_MS).toISOString()],
  });
}

// ---- stato del servizio --------------------------------------------------------------------------

export async function scriviStato(db: Client, chiave: string, valore: unknown) {
  await db.execute({
    sql: `INSERT INTO stato (chiave, valore, aggiornato) VALUES (?, ?, ?)
          ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore, aggiornato = excluded.aggiornato`,
    args: [chiave, JSON.stringify(valore), adesso()],
  });
}

export async function leggiStato(db: Client, chiave: string): Promise<{ valore: any; aggiornato: string } | null> {
  const r = await db.execute({ sql: `SELECT valore, aggiornato FROM stato WHERE chiave = ?`, args: [chiave] });
  const x = r.rows[0];
  return x ? { valore: JSON.parse(String(x.valore)), aggiornato: String(x.aggiornato) } : null;
}
