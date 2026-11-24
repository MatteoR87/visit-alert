// Configurazione del servizio, dalle variabili d'ambiente del progetto Vercel (vedi README).
// I dati sanitari (codice fiscale, tessera, ricetta) NON stanno qui: arrivano dai comandi del bot.

import { timingSafeEqual } from "node:crypto";

/** Segreto delle chiamate di servizio (cron e prove). */
export function leggiSegreto(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CRON_SEGRETO?.trim() || null;
}

/** `Authorization: Bearer <segreto>` oppure `?chiave=<segreto>`. Senza segreto configurato non passa nessuno. */
export function autorizzato(request: Request, segreto: string | null): boolean {
  if (!segreto) return false;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const dato = bearer ?? new URL(request.url).searchParams.get("chiave") ?? "";
  const a = Buffer.from(dato);
  const b = Buffer.from(segreto);
  return a.length === b.length && timingSafeEqual(a, b);
}
