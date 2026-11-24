// POST /api/telegram: il webhook del bot. Risponde subito a Telegram e lavora dopo (waitUntil):
// /avvia e /date aspettano PrenotaSalute anche per decine di secondi.
import { waitUntil } from "@vercel/functions";
import { ConfigurazioneMancante, leggiAmbiente, webhookAutentico } from "../lib/ambiente.js";
import { gestisciAggiornamento } from "../lib/bot.js";
import { apriDb } from "../lib/db.js";
import { Telegram } from "../lib/telegram.js";

export async function POST(request: Request) {
  let amb;
  try {
    amb = leggiAmbiente();
  } catch (e) {
    return Response.json({ errore: (e as Error).message }, { status: e instanceof ConfigurazioneMancante ? 503 : 500 });
  }
  if (!webhookAutentico(request, amb)) return Response.json({ errore: "Non autorizzato" }, { status: 401 });

  const update = await request.json().catch(() => null);
  const lavoro = (async () => {
    const db = await apriDb(amb);
    await gestisciAggiornamento(update, { db, chiave: amb.chiave, utenti: amb.utenti, tg: new Telegram(amb.botToken) });
  })().catch((e) => console.error(JSON.stringify({ telegram: (e as Error).message.slice(0, 300) })));
  waitUntil(lavoro);
  return Response.json({ ok: true });
}
