// GET /api/configura?chiave=<CRON_SEGRETO>: collega il webhook del bot a questo indirizzo (con il segreto che
// Telegram rimanda a ogni aggiornamento) e imposta il menu dei comandi. Da aprire sull'indirizzo di produzione.
import { autorizzato, ConfigurazioneMancante, leggiAmbiente, segretoWebhook } from "../lib/ambiente.js";
import { COMANDI } from "../lib/bot.js";
import { apriDb } from "../lib/db.js";
import { Telegram } from "../lib/telegram.js";

export async function GET(request: Request) {
  let amb;
  try {
    amb = leggiAmbiente();
  } catch (e) {
    return Response.json({ errore: (e as Error).message }, { status: e instanceof ConfigurazioneMancante ? 503 : 500 });
  }
  if (!autorizzato(request, amb.segreto)) return Response.json({ errore: "Non autorizzato" }, { status: 401 });

  const tg = new Telegram(amb.botToken);
  const webhook = `${new URL(request.url).origin}/api/telegram`;
  try {
    await tg.chiama("setWebhook", {
      url: webhook,
      secret_token: segretoWebhook(amb),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    await tg.chiama("setMyCommands", { commands: COMANDI });
    const bot = await tg.chiama("getMe", {});
    await apriDb(amb); // crea le tabelle e verifica Turso
    return Response.json({
      ok: true,
      bot: `@${bot.username}`,
      webhook,
      utenti: amb.utenti.size,
      database: "ok",
      prenotazione: amb.prenotazioneReale ? "reale" : "prova",
    });
  } catch (e) {
    return Response.json({ ok: false, errore: (e as Error).message.slice(0, 300) }, { status: 502 });
  }
}
