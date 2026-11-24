// GET o POST /api/controlla: un giro su tutti i controlli, chiamato da cron-job.org con
// `Authorization: Bearer <CRON_SEGRETO>`. Risponde subito (cron-job.org aspetta al massimo ~30 s, un giro sul sito
// può durarne di più) e lavora dopo con waitUntil; con `?attendi=1` aspetta e restituisce il riepilogo.
import { waitUntil } from "@vercel/functions";
import { autorizzato, ConfigurazioneMancante, leggiAmbiente, type Ambiente } from "../lib/ambiente.js";
import { apriDb, scriviStato } from "../lib/db.js";
import { giroDiControllo } from "../lib/monitor.js";
import { Telegram } from "../lib/telegram.js";

/** La funzione ha 120 s e un giro sul sito può durarne ~60: oltre i 50 non se ne comincia un altro. */
const TEMPO_MS = 50_000;

async function giro(amb: Ambiente, inizio: number) {
  const db = await apriDb(amb);
  try {
    const esito = await giroDiControllo({ db, chiave: amb.chiave, tg: new Telegram(amb.botToken), limite: inizio + TEMPO_MS });
    const riepilogo = { ...esito, ms: Date.now() - inizio };
    await scriviStato(db, "ultimo_giro", riepilogo);
    console.log(JSON.stringify({ controllo: riepilogo }));
    return riepilogo;
  } catch (e) {
    const messaggio = (e as Error).message.slice(0, 300);
    console.error(JSON.stringify({ controllo: { errore: messaggio } }));
    await scriviStato(db, "ultimo_errore", { messaggio }).catch(() => null);
    return { errore: messaggio };
  }
}

async function controlla(request: Request) {
  const inizio = Date.now();
  let amb;
  try {
    amb = leggiAmbiente();
  } catch (e) {
    return Response.json({ errore: (e as Error).message }, { status: e instanceof ConfigurazioneMancante ? 503 : 500 });
  }
  if (!autorizzato(request, amb.segreto)) return Response.json({ errore: "Non autorizzato" }, { status: 401 });

  const lavoro = giro(amb, inizio);
  const intestazioni = { "Cache-Control": "no-store" };
  if (new URL(request.url).searchParams.get("attendi") === "1") {
    const r = await lavoro;
    return Response.json(r, { status: "errore" in r ? 500 : 200, headers: intestazioni });
  }
  waitUntil(lavoro);
  return Response.json({ avviato: true }, { status: 202, headers: intestazioni });
}

export const GET = controlla;
export const POST = controlla;
