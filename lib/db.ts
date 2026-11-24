// Database su Turso (SQLite ospitato), via HTTP: adatto alle funzioni serverless.
// Le tabelle si creano da sole al primo uso. In chiaro solo ID, tipo, orari e contatori: dati sanitari,
// appuntamento e date già notificate sono cifrati con CHIAVE_CIFRATURA.
import type { Client } from "@libsql/client";
import { cifraJson, decifraJson } from "./cifratura.js";
import type { Appuntamento, DataLibera, DatiRicetta, Tipo, Zona } from "./controllo.js";

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
];

/** Quello che serve tra un giro e l'altro (cifrato). */
export type Contesto = {
  appuntamento: Appuntamento;
  zona: Zona | null;
  /** Chiavi delle date anticipate già mandate (chiaveData). */
  notificate: string[];
  /** Le date anticipate dell'ultimo giro, per /date. */
  anticipate: DataLibera[];
  /** Prima data libera nella struttura all'ultimo giro (anche se dopo l'appuntamento). */
  primaData: DataLibera | null;
};

export type Controllo = {
  id: number;
  chatId: string;
  utenteId: string;
  dati: DatiRicetta;
  contesto: Contesto;
  tipo: Tipo;
  creato: string;
  ultimoControllo: string | null;
  ultimoEsito: string | null;
  errori: number;
};

const pronti = new WeakSet<Client>();

export async function preparaDb(db: Client) {
  if (pronti.has(db)) return db;
  for (const s of SCHEMA) await db.execute(s);
  pronti.add(db);
  return db;
}

export async function apriDb(amb: { tursoUrl: string; tursoToken: string }): Promise<Client> {
  const { createClient } = await import("@libsql/client/web");
  return preparaDb(createClient({ url: amb.tursoUrl, authToken: amb.tursoToken }));
}

const adesso = () => new Date().toISOString();

function daRiga(r: any, chiave: Buffer): Controllo {
  return {
    id: Number(r.id),
    chatId: String(r.chat_id),
    utenteId: String(r.utente_id),
    dati: decifraJson<DatiRicetta>(String(r.dati), chiave),
    contesto: decifraJson<Contesto>(String(r.contesto), chiave),
    tipo: String(r.tipo) as Tipo,
    creato: String(r.creato),
    ultimoControllo: r.ultimo_controllo === null ? null : String(r.ultimo_controllo),
    ultimoEsito: r.ultimo_esito === null ? null : String(r.ultimo_esito),
    errori: Number(r.errori ?? 0),
  };
}

export async function nuovoControllo(
  db: Client,
  chiave: Buffer,
  c: Pick<Controllo, "chatId" | "utenteId" | "dati" | "contesto" | "tipo">,
): Promise<number> {
  const r = await db.execute({
    sql: `INSERT INTO controlli (chat_id, utente_id, dati, contesto, tipo, creato, ultimo_controllo, ultimo_esito)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ok')`,
    args: [c.chatId, c.utenteId, cifraJson(c.dati, chiave), cifraJson(c.contesto, chiave), c.tipo, adesso(), adesso()],
  });
  return Number(r.lastInsertRowid);
}

export async function aggiornaControllo(
  db: Client,
  chiave: Buffer,
  c: Pick<Controllo, "id" | "contesto" | "tipo" | "ultimoEsito" | "errori">,
) {
  await db.execute({
    sql: `UPDATE controlli SET contesto = ?, tipo = ?, ultimo_controllo = ?, ultimo_esito = ?, errori = ? WHERE id = ?`,
    args: [cifraJson(c.contesto, chiave), c.tipo, adesso(), c.ultimoEsito, c.errori, c.id],
  });
}

/** Tutti i controlli, i meno recenti per primi; con `utenteId` solo quelli di quell'utente. */
export async function leggiControlli(db: Client, chiave: Buffer, utenteId?: string): Promise<Controllo[]> {
  const r = utenteId
    ? await db.execute({ sql: `SELECT * FROM controlli WHERE utente_id = ? ORDER BY id`, args: [utenteId] })
    : await db.execute(`SELECT * FROM controlli ORDER BY COALESCE(ultimo_controllo, '') ASC, id ASC`);
  return r.rows.map((x) => daRiga(x, chiave));
}

export async function cancellaControllo(db: Client, id: number) {
  await db.execute({ sql: `DELETE FROM controlli WHERE id = ?`, args: [id] });
}

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
