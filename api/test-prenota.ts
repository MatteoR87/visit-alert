// GET /api/test-prenota?chiave=<CRON_SEGRETO>: PrenotaSalute risponde a Vercel?
// Passa dalla sala d'attesa, chiede il token e un servizio pubblico. Nessun dato personale.
import { autorizzato, leggiSegreto } from "../lib/ambiente.js";
import { diagnosi } from "../lib/diagnosi.js";

export async function GET(request: Request) {
  if (!autorizzato(request, leggiSegreto())) return Response.json({ errore: "Non autorizzato" }, { status: 401 });
  const esito = await diagnosi();
  console.log(JSON.stringify({ test: { ok: esito.ok, fase: esito.fase, inCoda: esito.inCoda, ms: esito.ms } }));
  return Response.json(
    { ...esito, regione: process.env.VERCEL_REGION ?? "locale" },
    { status: esito.ok ? 200 : 502, headers: { "Cache-Control": "no-store" } },
  );
}
