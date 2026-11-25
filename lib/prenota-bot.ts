// I pulsanti per prenotare dal bot. Mai in automatico:
//   "📅 N" (p:<id>:<data>:<presidio>) → riepilogo e avvertenze, con "✅ Prenota" (pc:…) e "❌ No" (px)
//   "✅ Prenota" → prenotaData (o, in modalità prova, solo la preparazione) → esito, con "🔔 Cerca date
//   migliori" (m:<id>), "🗑 Disdici" (d:<id>) e "✖️ Chiudi" (mx:<id>) per il nuovo appuntamento.
import type { Client } from "@libsql/client";
import { chiaveData, type DataLibera } from "./controllo.js";
import { cancellaControllo, leggiControlli, leggiStato, nuovoControllo, scriviStato, type Controllo } from "./db.js";
import { descriviAppuntamento, formatoData } from "./messaggi.js";
import { InCoda } from "./prenota.js";
import { prenotaData, type Bersaglio, type EsitoPrenotazione, type Riserva } from "./prenotazione.js";
import { html, type Telegram } from "./telegram.js";

export type Prenota = typeof prenotaData;

export type ContestoPrenota = {
  db: Client;
  chiave: Buffer;
  tg: Pick<Telegram, "manda" | "modifica" | "rispondiPulsante">;
  /** false = modalità prova (PRENOTAZIONE_REALE non è "1"). */
  prenotazioneReale: boolean;
  prenota?: Prenota;
};

/** Dopo quanto un "✅ Prenota" non vale più (la data potrebbe essere cambiata): si ritocca 📅. */
export const DURATA_CONFERMA_S = 10 * 60;
/** Per quanto un secondo tocco sullo stesso controllo viene ignorato mentre si prenota. */
const DURATA_BLOCCO_MS = 3 * 60_000;

function leggiDato(dato: string): { id: number; bersaglio: Bersaglio } | null {
  const [, id, data, presidio] = dato.split(":");
  if (!/^\d+$/.test(id ?? "") || !/^\d{14}$/.test(data ?? "") || !presidio) return null;
  return { id: Number(id), bersaglio: { data, presidio } };
}

/** La data tra quelle mostrate dal controllo (per descriverla e scegliere l'agenda). */
function trovaData(c: Controllo, b: Bersaglio): DataLibera | null {
  const elenco = c.modalita === "cerca" ? c.contesto.risultati : c.contesto.anticipate;
  return elenco.find((d) => d.data === b.data && d.presidio.codice === b.presidio) ?? null;
}

/** La proposta salvata dall'ultimo giro per questa data, se c'è. */
function riservaDi(c: Controllo, b: Bersaglio, d: DataLibera | null): Riserva | null {
  const p = c.contesto.proposte;
  if (!p) return null;
  const chiave = d ? chiaveData(d) : Object.keys(p.singole).find((k) => k.startsWith(`${b.data}|${b.presidio}|`));
  const singola = chiave ? p.singole[chiave] : undefined;
  return singola ? { singola, quando: p.quando } : null;
}

/** La data dell'appuntamento che il sito annullerà prenotando, se c'è. */
function appuntamentoDaAnnullare(c: Controllo): string | null {
  return c.modalita === "anticipa" ? c.contesto.appuntamento.data : c.contesto.appuntamentoIniziale;
}

async function controlloDi(utenteId: string, id: number, ctx: ContestoPrenota) {
  return (await leggiControlli(ctx.db, ctx.chiave, utenteId)).find((c) => c.id === id) ?? null;
}

/** "📅 N": riepilogo e richiesta di conferma. */
export async function chiediConferma(q: any, utenteId: string, ctx: ContestoPrenota) {
  const letto = leggiDato(String(q.data ?? ""));
  const chatId = String(q.message?.chat?.id ?? "");
  if (!letto) return ctx.tg.rispondiPulsante(q.id);
  const c = await controlloDi(utenteId, letto.id, ctx);
  if (!c) return ctx.tg.rispondiPulsante(q.id, "Questo controllo non è più attivo");
  await ctx.tg.rispondiPulsante(q.id);

  const d = trovaData(c, letto.bersaglio);
  const prestazione = c.modalita === "cerca" ? c.contesto.prestazione : c.contesto.appuntamento.prestazione;
  const daAnnullare = appuntamentoDaAnnullare(c);
  const righe = [
    "📅 <b>Prenoto questa data?</b>",
    "",
    `🩺 ${html(prestazione)}`,
    `🗓 <b>${formatoData(letto.bersaglio.data)}</b>`,
    `🏥 ${html(d?.presidio.descrizione ?? letto.bersaglio.presidio)}${d?.unita ? `\n   ${html(d.unita)}` : ""}`,
    "",
  ];
  if (daAnnullare)
    righe.push(`⚠️ Il tuo appuntamento attuale (<b>${formatoData(daAnnullare)}</b>) verrà <b>annullato automaticamente</b> dal sito.`);
  righe.push(
    "Se poi non ti presenti senza disdire almeno 2 giorni lavorativi prima, il ticket si paga.",
    "Prima di prenotare ricontrollo che la data sia ancora libera.",
  );
  if (!ctx.prenotazioneReale) righe.push("", "🧪 <b>Modalità prova</b>: preparo tutto ma <b>non</b> invio la prenotazione.");
  await ctx.tg.manda(chatId, righe.join("\n"), [
    [
      { text: ctx.prenotazioneReale ? "✅ Prenota" : "🧪 Prova", callback_data: `pc:${letto.id}:${letto.bersaglio.data}:${letto.bersaglio.presidio}` },
      { text: "❌ No", callback_data: "px" },
    ],
  ]);
}

/** "❌ No". */
export async function annullaConferma(q: any, ctx: ContestoPrenota) {
  await ctx.tg.rispondiPulsante(q.id);
  await ctx.tg.modifica(String(q.message?.chat?.id ?? ""), Number(q.message?.message_id ?? 0), "Va bene, non prenoto nulla.");
}

/** "✅ Prenota": controlli, poi la prenotazione (o la prova) e l'esito. */
export async function eseguiPrenotazione(q: any, utenteId: string, ctx: ContestoPrenota) {
  const letto = leggiDato(String(q.data ?? ""));
  const chatId = String(q.message?.chat?.id ?? "");
  const messaggio = Number(q.message?.message_id ?? 0);
  if (!letto) return ctx.tg.rispondiPulsante(q.id);

  const eta = Date.now() / 1000 - Number(q.message?.date ?? 0);
  if (eta > DURATA_CONFERMA_S) {
    await ctx.tg.rispondiPulsante(q.id, "Conferma scaduta: tocca di nuovo 📅");
    await ctx.tg.modifica(chatId, messaggio, "⌛ Conferma scaduta: tocca di nuovo 📅 sulla data.");
    return;
  }
  const c = await controlloDi(utenteId, letto.id, ctx);
  if (!c) return ctx.tg.rispondiPulsante(q.id, "Questo controllo non è più attivo");

  // Un solo tentativo alla volta per controllo (doppio tocco, o due conferme aperte).
  const blocco = `prenotazione:${c.id}`;
  const prima = await leggiStato(ctx.db, blocco);
  if (prima?.valore?.inCorso && Date.now() - Date.parse(prima.aggiornato) < DURATA_BLOCCO_MS) {
    await ctx.tg.rispondiPulsante(q.id, "Sto già prenotando, attendi");
    return;
  }
  await scriviStato(ctx.db, blocco, { inCorso: true });
  await ctx.tg.rispondiPulsante(q.id);
  await ctx.tg.modifica(chatId, messaggio, `⏳ ${ctx.prenotazioneReale ? "Prenoto" : "Prova di prenotazione per"} ${formatoData(letto.bersaglio.data)}…`);

  const d = trovaData(c, letto.bersaglio);
  const zone =
    c.modalita === "cerca" ? c.contesto.filtri.zone : c.contesto.zona ? [c.contesto.zona] : [];
  let r: EsitoPrenotazione;
  try {
    if (zone.length === 0) throw new Error("zona del controllo sconosciuta: aspetta il prossimo giro e riprova");
    r = await (ctx.prenota ?? prenotaData)(c.dati, c.tipo, zone, { ...letto.bersaglio, agenda: d?.agenda.codice ?? null }, {
      reale: ctx.prenotazioneReale,
      riserva: riservaDi(c, letto.bersaglio, d),
    });
  } catch (e) {
    const testo =
      e instanceof InCoda ? "Il sito ha la sala d'attesa attiva, riprova tra qualche minuto." : (e as Error).message.slice(0, 300);
    console.error(JSON.stringify({ prenotazione: { controllo: c.id, errore: testo } }));
    await ctx.tg.modifica(chatId, messaggio, `❌ Prenotazione non riuscita: ${html(testo)}`);
    await scriviStato(ctx.db, blocco, { inCorso: false });
    return;
  }
  console.log(JSON.stringify({ prenotazione: { controllo: c.id, esito: r.esito, reale: ctx.prenotazioneReale } }));
  await scriviStato(ctx.db, blocco, { inCorso: false });

  if (r.esito === "non-disponibile") {
    await ctx.tg.modifica(
      chatId,
      messaggio,
      `😕 ${formatoData(letto.bersaglio.data)} non è più disponibile (presa da qualcun altro, o trattenuta da una ricerca di pochi minuti fa). Non ho prenotato nulla: riprova tra qualche minuto o scegli un'altra data.`,
    );
    return;
  }
  if (r.esito === "prova") {
    await ctx.tg.modifica(
      chatId,
      messaggio,
      [
        r.trattenuta
          ? "🧪 <b>Prova riuscita</b>: la data è trattenuta dall'ultima ricerca del bot e la richiesta di prenotazione è pronta con quella proposta."
          : "🧪 <b>Prova riuscita</b>: la data è ancora libera e la richiesta di prenotazione è pronta.",
        "",
        descriviAppuntamento(r.appuntamento).replace("Appuntamento attuale", "Data"),
        "",
        "<b>Non ho prenotato nulla</b> (modalità prova).",
      ].join("\n"),
    );
    return;
  }
  await dopoLaPrenotazione(c, r, chatId, messaggio, ctx);
}

async function dopoLaPrenotazione(
  c: Controllo,
  r: Extract<EsitoPrenotazione, { esito: "prenotato" }>,
  chatId: string,
  messaggio: number,
  ctx: ContestoPrenota,
) {
  const nuovo = r.appuntamenti[0];
  const daAnnullare = appuntamentoDaAnnullare(c);
  const righe = ["✅ <b>Prenotato!</b>", ""];
  if (nuovo) righe.push(descriviAppuntamento(nuovo).replace("Appuntamento attuale", "Nuovo appuntamento"));
  if (r.codici.length > 0) righe.push(`Codice prenotazione: <code>${html(r.codici.join(", "))}</code>`);
  if (r.importo) righe.push(`Importo: ${html(r.importo)} €`);
  if (daAnnullare) righe.push("", `L'appuntamento precedente (${formatoData(daAnnullare)}) è stato annullato automaticamente dal sito.`);
  righe.push("Controlla su PrenotaSalute o nell'email di conferma.");

  // Il controllo o la ricerca di prima finisce. Al suo posto un controllo del nuovo appuntamento NON
  // monitorato: il cron lo ripete solo dopo "🔔" (conferma esplicita), altrimenti si cancella dopo un'ora.
  await cancellaControllo(ctx.db, c.id);
  if (!nuovo) {
    righe.push("", `Ho chiuso #${c.id} e cancellato i suoi dati. Per cercare date migliori: /avvia.`);
    await ctx.tg.modifica(chatId, messaggio, righe.join("\n"));
    return;
  }
  const id = await nuovoControllo(ctx.db, ctx.chiave, {
    modalita: "anticipa",
    chatId: c.chatId,
    utenteId: c.utenteId,
    dati: c.dati,
    tipo: c.tipo,
    contesto: {
      appuntamento: nuovo,
      zona: c.modalita === "anticipa" ? c.contesto.zona : null,
      notificate: [],
      anticipate: [],
      primaData: null,
      monitora: false,
    },
  });
  righe.push(
    "",
    `Vuoi che controlli se si libera una data <b>prima</b> di questa, nella stessa struttura? Tocca 🔔 (controllo #${id}). Altrimenti tra un'ora cancello i dati (o subito con ✖️ Chiudi).`,
  );
  await ctx.tg.modifica(chatId, messaggio, righe.join("\n"), [
    [{ text: "🔔 Cerca date migliori", callback_data: `m:${id}` }],
    [
      { text: "🗑 Disdici", callback_data: `d:${id}` },
      { text: "✖️ Chiudi", callback_data: `mx:${id}` },
    ],
  ]);
}
