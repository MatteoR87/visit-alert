// La disdetta dal bot. Mai in automatico:
//   /disdici [N]  o  "🗑 Disdici" (d:<id>)  o  /disdici CF CIFRE NRE
//     → riepilogo e avvertenze, con "🗑 Sì, disdici" (dc:<id>:<data>) e "❌ No" (dx)
//   "🗑 Sì, disdici" → disdiciAppuntamento (o, in modalità prova, solo la preparazione) → esito.
import type { Client } from "@libsql/client";
import { anteprimaRicetta, ErroreUtente, type Anteprima, type DatiRicetta } from "./controllo.js";
import { leggiDatiRicetta } from "./dati.js";
import { cancellaControllo, leggiControlli, leggiStato, nuovoControllo, scriviStato, type ControlloAnticipa } from "./db.js";
import { disdiciAppuntamento } from "./disdetta.js";
import { descriviAppuntamento, formatoData } from "./messaggi.js";
import { InCoda } from "./prenota.js";
import { html, type Telegram } from "./telegram.js";

export type Disdici = typeof disdiciAppuntamento;

export type ContestoDisdetta = {
  db: Client;
  chiave: Buffer;
  tg: Pick<Telegram, "manda" | "modifica" | "rispondiPulsante">;
  /** false = modalità prova (PRENOTAZIONE_REALE non è "1"): vale anche per le disdette. */
  prenotazioneReale: boolean;
  disdici?: Disdici;
  anteprima?: (dati: DatiRicetta, opz: object) => Promise<Anteprima>;
};

/** Dopo quanto un "🗑 Sì, disdici" non vale più. */
const DURATA_CONFERMA_S = 10 * 60;
const DURATA_BLOCCO_MS = 3 * 60_000;

async function controlloAnticipa(utenteId: string, id: number, ctx: ContestoDisdetta): Promise<ControlloAnticipa | null> {
  const c = (await leggiControlli(ctx.db, ctx.chiave, utenteId)).find((x) => x.id === id);
  return c && c.modalita === "anticipa" ? c : null;
}

/** Il messaggio di conferma per disdire l'appuntamento del controllo. */
async function chiedi(c: ControlloAnticipa, chatId: string, ctx: ContestoDisdetta) {
  const a = c.contesto.appuntamento;
  const righe = [
    "🗑 <b>Disdico questo appuntamento?</b>",
    "",
    descriviAppuntamento(a),
    "",
    "⚠️ La disdetta <b>non si può annullare</b>: la data torna libera per tutti.",
    "Se mancano meno di 2 giorni lavorativi il ticket potrebbe essere dovuto lo stesso.",
  ];
  if (!ctx.prenotazioneReale) righe.push("", "🧪 <b>Modalità prova</b>: preparo tutto ma <b>non</b> invio la disdetta.");
  await ctx.tg.manda(chatId, righe.join("\n"), [
    [
      { text: ctx.prenotazioneReale ? "🗑 Sì, disdici" : "🧪 Prova", callback_data: `dc:${c.id}:${a.data}` },
      { text: "❌ No", callback_data: "dx" },
    ],
  ]);
}

/** "🗑 Disdici" (d:<id>) sotto l'esito di una prenotazione. */
export async function chiediDisdetta(q: any, utenteId: string, ctx: ContestoDisdetta) {
  const [, n] = String(q.data ?? "").split(":");
  const c = await controlloAnticipa(utenteId, Number(n), ctx);
  if (!c) return ctx.tg.rispondiPulsante(q.id, "Questo controllo non c'è più: usa /disdici");
  await ctx.tg.rispondiPulsante(q.id);
  await chiedi(c, String(q.message?.chat?.id ?? ""), ctx);
}

/**
 * /disdici [N]: l'appuntamento di un controllo (/avvia o dopo una prenotazione).
 * /disdici CF CIFRE NRE: legge la ricetta, salva i dati come controllo non monitorato (si cancella da solo dopo
 * un'ora) e chiede conferma.
 */
export async function comandoDisdici(argomenti: string[], chatId: string, utenteId: string, ctx: ContestoDisdetta) {
  if (argomenti.length >= 3) {
    const a = leggiDatiRicetta(argomenti);
    if (!a.ok) {
      await ctx.tg.manda(chatId, `❌ ${a.errore}\nHo cancellato il messaggio. Riprova: <code>/disdici CODICEFISCALE CIFRE NRE</code>`);
      return;
    }
    await ctx.tg.manda(chatId, "🔒 Ho cancellato il messaggio con i tuoi dati. ⏳ Leggo la ricetta su PrenotaSalute…");
    const dati = { codiceFiscale: a.codiceFiscale, cifre: a.cifre, nre: a.nre };
    let ant: Anteprima;
    try {
      ant = await (ctx.anteprima ?? anteprimaRicetta)(dati, {});
    } catch (e) {
      const testo =
        e instanceof ErroreUtente ? e.message : e instanceof InCoda ? "Il sito ha la sala d'attesa attiva, riprova tra qualche minuto." : "Il sito non ha risposto come previsto, riprova tra qualche minuto.";
      await ctx.tg.manda(chatId, `❌ ${html(testo)}\nNon ho salvato nulla.`);
      return;
    }
    if (!ant.appuntamento) {
      await ctx.tg.manda(chatId, "❌ Questa ricetta non ha un appuntamento futuro da disdire. Non ho salvato nulla.");
      return;
    }
    const id = await nuovoControllo(ctx.db, ctx.chiave, {
      modalita: "anticipa",
      chatId,
      utenteId,
      dati,
      tipo: a.tipo ?? ant.tipo ?? "O",
      contesto: { appuntamento: ant.appuntamento, zona: null, notificate: [], anticipate: [], primaData: null, monitora: false },
    });
    const c = await controlloAnticipa(utenteId, id, ctx);
    if (c) await chiedi(c, chatId, ctx);
    return;
  }

  const controlli = (await leggiControlli(ctx.db, ctx.chiave, utenteId)).filter((c): c is ControlloAnticipa => c.modalita === "anticipa");
  const n = Number(String(argomenti[0] ?? "").replace("#", ""));
  const c = argomenti[0] === undefined && controlli.length === 1 ? controlli[0] : controlli.find((x) => x.id === n);
  if (!c) {
    await ctx.tg.manda(
      chatId,
      controlli.length === 0
        ? "Nessun appuntamento salvato. Usa <code>/disdici CODICEFISCALE CIFRE NRE</code>."
        : `Quale? <code>/disdici N</code> con N tra: ${controlli.map((x) => `#${x.id} (${formatoData(x.contesto.appuntamento.data)})`).join(", ")}`,
    );
    return;
  }
  await chiedi(c, chatId, ctx);
}

/** "❌ No". */
export async function annullaDisdetta(q: any, ctx: ContestoDisdetta) {
  await ctx.tg.rispondiPulsante(q.id);
  await ctx.tg.modifica(String(q.message?.chat?.id ?? ""), Number(q.message?.message_id ?? 0), "Va bene, non disdico nulla.");
}

/** "🗑 Sì, disdici" (dc:<id>:<data>). */
export async function eseguiDisdetta(q: any, utenteId: string, ctx: ContestoDisdetta) {
  const [, n, data] = String(q.data ?? "").split(":");
  const chatId = String(q.message?.chat?.id ?? "");
  const messaggio = Number(q.message?.message_id ?? 0);
  if (!/^\d+$/.test(n ?? "") || !/^\d{14}$/.test(data ?? "")) return ctx.tg.rispondiPulsante(q.id);

  if (Date.now() / 1000 - Number(q.message?.date ?? 0) > DURATA_CONFERMA_S) {
    await ctx.tg.rispondiPulsante(q.id, "Conferma scaduta");
    await ctx.tg.modifica(chatId, messaggio, "⌛ Conferma scaduta: rifai /disdici.");
    return;
  }
  const c = await controlloAnticipa(utenteId, Number(n), ctx);
  if (!c) return ctx.tg.rispondiPulsante(q.id, "Questo controllo non c'è più: usa /disdici");
  if (c.contesto.appuntamento.data !== data) {
    await ctx.tg.rispondiPulsante(q.id);
    await ctx.tg.modifica(chatId, messaggio, "L'appuntamento del controllo è cambiato: rifai /disdici.");
    return;
  }

  const blocco = `prenotazione:${c.id}`; // lo stesso blocco della prenotazione: mai due operazioni insieme
  const prima = await leggiStato(ctx.db, blocco);
  if (prima?.valore?.inCorso && Date.now() - Date.parse(prima.aggiornato) < DURATA_BLOCCO_MS) {
    await ctx.tg.rispondiPulsante(q.id, "Operazione già in corso, attendi");
    return;
  }
  await scriviStato(ctx.db, blocco, { inCorso: true });
  await ctx.tg.rispondiPulsante(q.id);
  await ctx.tg.modifica(chatId, messaggio, `⏳ ${ctx.prenotazioneReale ? "Disdico" : "Prova di disdetta per"} ${formatoData(data)}…`);

  let r;
  try {
    r = await (ctx.disdici ?? disdiciAppuntamento)(c.dati, data, { reale: ctx.prenotazioneReale });
  } catch (e) {
    const testo =
      e instanceof InCoda ? "Il sito ha la sala d'attesa attiva, riprova tra qualche minuto." : (e as Error).message.slice(0, 300);
    console.error(JSON.stringify({ disdetta: { controllo: c.id, errore: testo } }));
    await ctx.tg.modifica(chatId, messaggio, `❌ Disdetta non riuscita: ${html(testo)}`);
    await scriviStato(ctx.db, blocco, { inCorso: false });
    return;
  }
  console.log(JSON.stringify({ disdetta: { controllo: c.id, esito: r.esito, reale: ctx.prenotazioneReale } }));
  await scriviStato(ctx.db, blocco, { inCorso: false });

  if (r.esito === "non-trovato") {
    await cancellaControllo(ctx.db, c.id);
    await ctx.tg.modifica(
      chatId,
      messaggio,
      `L'appuntamento del ${formatoData(data)} non c'è più sulla ricetta (già disdetto o spostato). Non ho fatto nulla e ho cancellato i dati del controllo #${c.id}.`,
    );
    return;
  }
  if (r.esito === "prova") {
    await ctx.tg.modifica(
      chatId,
      messaggio,
      ["🧪 <b>Prova riuscita</b>: la richiesta di disdetta è pronta.", "", descriviAppuntamento(r.appuntamenti[0]), "", "<b>Non ho disdetto nulla</b> (modalità prova)."].join("\n"),
    );
    return;
  }
  await cancellaControllo(ctx.db, c.id);
  await ctx.tg.modifica(
    chatId,
    messaggio,
    [
      "✅ <b>Disdetto.</b>",
      "",
      descriviAppuntamento(r.appuntamenti[0]).replace("Appuntamento attuale", "Appuntamento disdetto"),
      "",
      `Ho cancellato i dati del controllo #${c.id}. Controlla su PrenotaSalute o nell'email. Per prenotare un'altra data: /cerca.`,
    ].join("\n"),
  );
}
