// GET o POST /api/controlla: un giro su tutti i controlli, chiamato da cron-job.org con
// `Authorization: Bearer <CRON_SEGRETO>`.
import { autorizzato, ConfigurazioneMancante, leggiAmbiente } from "../lib/ambiente.js";
import { apriDb, scriviStato } from "../lib/db.js";
import { giroDiControllo } from "../lib/monitor.js";
import { Telegram } from "../lib/telegram.js";

/** La funzione ha 120 s e un giro sul sito può durarne ~60: oltre i 50 non se ne comincia un altro. */
const TEMPO_MS = 50_000;

async function controlla(request: Request) {
  const inizio = Date.now();
  let amb;
  try {
    amb = leggiAmbiente();
  } catch (e) {
    return Response.json({ errore: (e as Error).message }, { status: e instanceof ConfigurazioneMancante ? 503 : 500 });
  }
  if (!autorizzato(request, amb.segreto)) return Response.json({ errore: "Non autorizzato" }, { status: 401 });

  const db = await apriDb(amb);
  try {
    const esito = await giroDiControllo({
      db,
      chiave: amb.chiave,
      tg: new Telegram(amb.botToken),
      limite: inizio + TEMPO_MS,
    });
    const riepilogo = { ...esito, ms: Date.now() - inizio };
    await scriviStato(db, "ultimo_giro", riepilogo);
    console.log(JSON.stringify({ controllo: riepilogo }));
    return Response.json(riepilogo, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const messaggio = (e as Error).message.slice(0, 300);
    console.error(JSON.stringify({ controllo: { errore: messaggio } }));
    await scriviStato(db, "ultimo_errore", { messaggio }).catch(() => null);
    return Response.json({ errore: messaggio }, { status: 500 });
  }
}

export const GET = controlla;
export const POST = controlla;
