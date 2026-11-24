# visit-alert

Avvisi Telegram per date anticipate su PrenotaSalute (Regione Lombardia). Vedi README.md.

- Lingua: codice, commenti, documentazione e messaggi in italiano.
- Funzioni Vercel senza framework (`api/*.ts` con `export async function GET/POST(request: Request)`), TypeScript,
  moduli ESM (import relativi con `.js`), regione `fra1`.
- PrenotaSalute: solo chiamate HTTP alle API interne (`jsonBroker`), mai browser. Poche richieste, solo lettura:
  mai prenotare, confermare o disdire.
- Codice fiscale, cifre della tessera e NRE arrivano solo dai comandi del bot, mai da variabili d'ambiente.
- Mai stampare dati sanitari, valori di cookie, token o segreti, nemmeno nei log: al più i nomi.
- Il README va aggiornato con ogni modifica a comandi, variabili o funzionamento.
- Prima di dichiarare finito: `npm run typecheck` e `npm test`.
