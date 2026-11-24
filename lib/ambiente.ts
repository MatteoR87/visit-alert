// Configurazione del servizio, dalle variabili d'ambiente del progetto Vercel (vedi README).
// I dati sanitari (codice fiscale, tessera, ricetta) NON stanno qui: arrivano dai comandi del bot.

import { createHash, timingSafeEqual } from "node:crypto";

export type Ambiente = {
  /** Token del bot, da @BotFather. */
  botToken: string;
  /** ID Telegram di chi può usare il bot (da /id). */
  utenti: Set<string>;
  tursoUrl: string;
  tursoToken: string;
  /** Chiave AES-256 (32 byte) con cui si cifrano i dati sanitari nel database. */
  chiave: Buffer;
  /** Segreto di /api/controlla, /api/configura e /api/test-prenota. */
  segreto: string;
};

export class ConfigurazioneMancante extends Error {}

function richiesta(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome]?.trim();
  if (!v) throw new ConfigurazioneMancante(`Manca la variabile ${nome}`);
  return v;
}

export function leggiChiave(valore: string): Buffer {
  const chiave = Buffer.from(valore, "base64");
  if (chiave.length !== 32) throw new ConfigurazioneMancante("CHIAVE_CIFRATURA deve essere di 32 byte in base64");
  return chiave;
}

export function leggiAmbiente(env: NodeJS.ProcessEnv = process.env): Ambiente {
  return {
    botToken: richiesta(env, "TELEGRAM_BOT_TOKEN"),
    utenti: new Set(
      (env.TELEGRAM_UTENTI ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    tursoUrl: richiesta(env, "TURSO_DATABASE_URL"),
    tursoToken: richiesta(env, "TURSO_AUTH_TOKEN"),
    chiave: leggiChiave(richiesta(env, "CHIAVE_CIFRATURA")),
    segreto: richiesta(env, "CRON_SEGRETO"),
  };
}

/** Segreto delle chiamate di servizio (anche senza il resto della configurazione, per /api/test-prenota). */
export function leggiSegreto(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CRON_SEGRETO?.trim() || null;
}

function uguali(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `Authorization: Bearer <segreto>` oppure `?chiave=<segreto>`. Senza segreto configurato non passa nessuno. */
export function autorizzato(request: Request, segreto: string | null): boolean {
  if (!segreto) return false;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const dato = bearer ?? new URL(request.url).searchParams.get("chiave") ?? "";
  return uguali(dato, segreto);
}

/** Segreto che Telegram rimanda nell'intestazione X-Telegram-Bot-Api-Secret-Token del webhook. */
export function segretoWebhook(amb: Pick<Ambiente, "botToken" | "segreto">): string {
  return createHash("sha256").update(`webhook|${amb.segreto}|${amb.botToken}`).digest("hex");
}

export function webhookAutentico(request: Request, amb: Pick<Ambiente, "botToken" | "segreto">): boolean {
  return uguali(request.headers.get("x-telegram-bot-api-secret-token") ?? "", segretoWebhook(amb));
}
