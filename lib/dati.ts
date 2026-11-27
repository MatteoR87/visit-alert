// Lettura e controllo dei dati della ricetta scritti al bot (/anticipa, /cerca), e dei filtri scritti a mano.
import { normalizzaNre, type Tipo } from "./controllo.js";

const RE_CF = /^[A-Z0-9]{16}$/;
const RE_CIFRE = /^\d{5}$/;
const RE_NRE = /^[0-9A-Z]{15}$/;

export type DatiLetti =
  | { ok: true; codiceFiscale: string; cifre: string; nre: string; tipo: Tipo | null }
  | { ok: false; errore: string };

/** CODICEFISCALE CIFRE NRE [O|Z] */
export function leggiDatiRicetta(argomenti: string[]): DatiLetti {
  if (argomenti.length < 3 || argomenti.length > 4)
    return { ok: false, errore: "Servono codice fiscale, ultime 5 cifre della tessera e numero di ricetta (NRE)." };
  const codiceFiscale = argomenti[0].toUpperCase();
  const cifre = argomenti[1];
  const nre = normalizzaNre(argomenti[2]);
  const tipo = argomenti[3]?.toUpperCase() ?? null;
  if (!RE_CF.test(codiceFiscale)) return { ok: false, errore: "Il codice fiscale deve avere 16 caratteri." };
  if (!RE_CIFRE.test(cifre)) return { ok: false, errore: "Le cifre della tessera devono essere le ultime 5, solo numeri." };
  if (!RE_NRE.test(nre)) return { ok: false, errore: "Il numero di ricetta (NRE) deve avere 15 caratteri, per esempio 030A01234567890." };
  if (tipo !== null && tipo !== "O" && tipo !== "Z") return { ok: false, errore: "In fondo si può aggiungere solo O (prima visita) o Z (controllo)." };
  return { ok: true, codiceFiscale, cifre, nre, tipo: tipo as Tipo | null };
}

const due = (n: number) => String(n).padStart(2, "0");

function giornoValido(y: number, m: number, d: number) {
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
}

/** "GG/MM[/AAAA]" → AAAAMMGG; senza anno: il primo non prima di `minimo` (AAAAMMGG). */
function leggiGiorno(t: string, minimo: string): string | null {
  const m = t.trim().match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mese = Number(m[2]);
  let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(minimo.slice(0, 4));
  let s = `${y}${due(mese)}${due(d)}`;
  if (!m[3] && s < minimo) {
    y += 1;
    s = `${y}${due(mese)}${due(d)}`;
  }
  return giornoValido(y, mese, d) ? s : null;
}

/**
 * Periodo scritto a mano: "01/12/2026-31/01/2027", "1/12-31/1" (anno sottinteso: il prossimo utile),
 * "01/12/2026" (da quel giorno, senza limite). `oggi` AAAAMMGG.
 */
export function leggiPeriodo(testo: string, oggi: string): { dal: string; al: string | null } | null {
  const pezzi = testo
    .trim()
    .replace(/^dal\s+/i, "")
    .split(/\s*(?:-|–|\bal\b)\s*/i)
    .filter(Boolean);
  if (pezzi.length < 1 || pezzi.length > 2) return null;
  const dal = leggiGiorno(pezzi[0], oggi);
  if (!dal) return null;
  if (pezzi.length === 1) return { dal, al: null };
  const al = leggiGiorno(pezzi[1], dal);
  if (!al || al < dal || al < oggi) return null;
  return { dal, al };
}

function leggiOra(t: string): number | null {
  const m = t.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** Fascia oraria scritta a mano: "8-12", "8:30-12", "14.00-18.30". Minuti dalla mezzanotte. */
export function leggiOrario(testo: string): { oraDa: number; oraA: number } | null {
  const pezzi = testo.trim().split(/\s*[-–]\s*/);
  if (pezzi.length !== 2) return null;
  const oraDa = leggiOra(pezzi[0]);
  const oraA = leggiOra(pezzi[1]);
  if (oraDa === null || oraA === null || oraDa >= oraA) return null;
  return { oraDa, oraA };
}

/** Una o più fasce scritte a mano, separate da virgola, punto e virgola o "e": "8-10, 14:30-16". */
export function leggiFasce(testo: string): { da: number; a: number }[] | null {
  const pezzi = testo
    .split(/\s*(?:,|;|\be\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (pezzi.length === 0) return null;
  const fasce = [];
  for (const p of pezzi) {
    const o = leggiOrario(p);
    if (!o) return null;
    fasce.push({ da: o.oraDa, a: o.oraA });
  }
  return fasce;
}

/** Ordina e toglie i doppioni. */
export function ordinaFasce<T extends { da: number; a: number }>(fasce: T[]): T[] {
  const viste = new Set<string>();
  return [...fasce]
    .sort((x, y) => x.da - y.da || x.a - y.a)
    .filter((f) => (viste.has(`${f.da}-${f.a}`) ? false : (viste.add(`${f.da}-${f.a}`), true)));
}

export function formatoOra(minuti: number) {
  return `${due(Math.floor(minuti / 60))}:${due(minuti % 60)}`;
}

/** AAAAMMGG → GG/MM/AAAA */
export function formatoGiorno(g: string) {
  return `${g.slice(6, 8)}/${g.slice(4, 6)}/${g.slice(0, 4)}`;
}

/** AAAAMMGG di `giorni` giorni dopo `oggi`. */
export function piuGiorni(oggi: string, giorni: number) {
  const d = new Date(Date.UTC(Number(oggi.slice(0, 4)), Number(oggi.slice(4, 6)) - 1, Number(oggi.slice(6, 8)) + giorni));
  return `${d.getUTCFullYear()}${due(d.getUTCMonth() + 1)}${due(d.getUTCDate())}`;
}
