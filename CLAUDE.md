# visit-alert

Avvisi Telegram per date anticipate su PrenotaSalute (Regione Lombardia). Vedi README.md.

- Lingua: codice, commenti, documentazione e messaggi in italiano.
- Funzioni Vercel senza framework (`api/*.ts` con `export async function GET/POST(request: Request)`), TypeScript,
  moduli ESM (import relativi con `.js`), regione `fra1`.
- PrenotaSalute: solo chiamate HTTP alle API interne (`jsonBroker`), mai browser. Poche richieste.
- Prenotare (`pgpcitt_conferma_disponibilita`) solo su conferma esplicita dell'utente, una data alla volta
  (pulsanti 📅 → ✅ in `lib/prenota-bot.ts`): mai in automatico, mai dai giri del cron. Quando si sposta,
  l'annullamento del vecchio appuntamento lo fa il sito da solo.
- Disdire (`pgpcitt_annulla_appuntamento`) solo su richiesta e conferma esplicita dell'utente, un appuntamento
  alla volta (`/disdici` o 🗑 → "🗑 Sì, disdici" in `lib/disdetta-bot.ts`): mai in automatico, mai dal cron.
- Il cron ripete un controllo o una ricerca solo se l'utente l'ha chiesto (✅ Avvia il controllo dopo
  `/anticipa`, ⏪ o 🔔): `/anticipa`, `/cerca` e il controllo dopo una prenotazione partono non monitorati.
- Modalità prova (prenotazione e disdetta) finché `PRENOTAZIONE_REALE` non è `1`. Nelle prove di sviluppo mai
  chiamare la conferma né la disdetta.
- Le richieste di conferma e disdetta si costruiscono con i modelli del sito (`lib/modelli-sito.ts`), non con
  gli oggetti grezzi delle risposte (altrimenti `ERROR.UNHANDLED`).
- Dopo una prenotazione o una disdetta riuscita la ricetta non si sblocca; in tutti gli altri casi sì, nella
  stessa sessione.
- Codice fiscale, cifre della tessera e NRE arrivano solo dai comandi del bot, mai da variabili d'ambiente.
- Mai stampare dati sanitari, valori di cookie, token o segreti, nemmeno nei log: al più i nomi.
- Il README va aggiornato con ogni modifica a comandi, variabili o funzionamento.
- Prima di dichiarare finito: `npm run typecheck` e `npm test`.
