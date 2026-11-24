// Cifratura dei dati sanitari salvati nel database: AES-256-GCM con la chiave di CHIAVE_CIFRATURA.
// Formato: "v1:<iv>:<tag>:<testo cifrato>" (base64). Il tag GCM rende evidente qualsiasi manomissione.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function cifra(testo: string, chiave: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chiave, iv);
  const corpo = Buffer.concat([c.update(testo, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), corpo].map((x) => (typeof x === "string" ? x : x.toString("base64"))).join(":");
}

export function decifra(cifrato: string, chiave: Buffer): string {
  const [versione, iv, tag, corpo] = cifrato.split(":");
  if (versione !== "v1" || !iv || !tag || corpo === undefined) throw new Error("Dato cifrato non valido");
  const d = createDecipheriv("aes-256-gcm", chiave, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(corpo, "base64")), d.final()]).toString("utf8");
}

export function cifraJson(valore: unknown, chiave: Buffer): string {
  return cifra(JSON.stringify(valore), chiave);
}

export function decifraJson<T>(cifrato: string, chiave: Buffer): T {
  return JSON.parse(decifra(cifrato, chiave)) as T;
}
