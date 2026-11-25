# visit-alert

Bot Telegram per [PrenotaSalute](https://prenotasalute.regione.lombardia.it/prenotaonline/) (Regione Lombardia):

- **`/avvia`**: avvisa quando si libera una data **prima** dell'appuntamento già prenotato, **nella stessa struttura**;
- **`/cerca`**: cerca una visita nelle zone, nel periodo e nella fascia oraria scelti, mostra le **prime 10 date**
  e avvisa quando ne compaiono di migliori.

Funzioni Vercel senza framework (TypeScript, moduli ESM, regione `fra1`), database Turso, solo chiamate HTTP
alle API interne del sito: nessun browser. Il servizio legge e basta: non prenota, non sposta, non disdice.

## Come funziona

```
Telegram ──webhook──▶ /api/telegram ──▶ /avvia CF CIFRE NRE ──▶ giro sul sito ──▶ Turso (dati cifrati)
cron-job.org ──▶ /api/controlla ──▶ per ogni controllo: giro sul sito ──▶ date nuove prima dell'appuntamento ──▶ Telegram
```

A ogni giro, per ogni controllo:

1. accesso al sito con codice fiscale e ultime 5 cifre della tessera;
2. la ricetta (NRE) con il suo **appuntamento futuro** (data, presidio, agenda);
3. le disponibilità nella zona (provincia) del presidio, per lo stesso tipo di prestazione;
4. le date **prima** dell'appuntamento **nello stesso presidio**: se ce n'è almeno una mai notificata arriva un
   messaggio con tutte (🆕 le nuove). Le date in un'altra agenda dello stesso presidio sono segnalate come tali;
5. sblocco della ricetta elettronica (sempre, anche dopo un errore).

Se l'appuntamento cambia (spostato da te) il bot lo dice e da lì confronta con quello nuovo; se la ricetta non ha
più un appuntamento futuro il controllo si ferma e i dati si cancellano. Dopo 3 errori di fila arriva un avviso
(e un altro quando torna a funzionare); la sala d'attesa attiva del sito non conta come errore: si salta il giro.

### Ricerca nuova (`/cerca`)

Procedura guidata: `/cerca CF CIFRE NRE [O|Z]` (messaggio cancellato subito) → il bot legge la ricetta e le zone
del sito, poi chiede con i pulsanti:

1. **prima visita o controllo**, solo se dalla ricetta non si capisce (senza appuntamento non c'è un'agenda con
   cui verificarlo, come fa `/avvia`);
2. **zone**: le 13 del sito (le province, con Milano città e Milano provincia separate), al massimo 4: ogni zona
   è una ricerca sul sito da 5-15 secondi;
3. **periodo**: da subito, entro 30/60/90 giorni, entro 6 mesi, oppure scritto (`01/12/2026-31/01/2027`,
   `15/1-28/2`, `01/12/2026`);
4. **fasce orarie**, anche più di una (al massimo 8): pulsanti 7–9, 9–11, 11–13, 13–15, 15–17, 17–20 da
   accendere e spegnere, più quelle scritte a mano (`8-9:30`, o più insieme: `8-10, 14:30-16`), che diventano
   pulsanti spuntati; poi Avanti. Nessuna fascia = tutto il giorno. Una data va bene se sta in una qualsiasi
   fascia (estremi inclusi). Al sito si chiede mattina e/o pomeriggio secondo le fasce (il confine non è
   documentato, si chiede largo) e l'orario esatto si filtra dopo. Le ricerche salvate con la prima versione
   (una sola fascia `oraDa`/`oraA`) si leggono ancora;
5. riepilogo e **✅ Avvia**: ricerca in tutte le zone, prime 10 date in ordine e salvataggio come controllo
   in modalità `cerca`.

La procedura sta nella tabella `bozze` (cifrata) e scade dopo un'ora; i pulsanti di un passo vecchio non fanno
nulla. A ogni giro del cron la ricerca si ripete: arriva un messaggio con le prime 10 date (🆕 le nuove) quando
ce n'è una mai mandata e, se l'elenco era già di 10, migliore dell'ultima. La ricetta già prenotata si può
cercare lo stesso (per trovare di meglio altrove); se invece viene prenotata **dopo** l'avvio della ricerca, la
ricerca si ferma e i dati si cancellano.

**Prima visita o controllo.** Il sito lo vuole sapere (`O`/`Z`). Come il sito, lo si ricava dalla ricetta
(campo apposito, "(PRIMA VISITA)"/"(CONTROLLO)" nella descrizione, esenzione per patologia); se non basta si
prova `O` e si verifica che le date siano nell'agenda dell'appuntamento, altrimenti `Z`. Il risultato si salva
al primo `/avvia`. `/avvia … O` o `/avvia … Z` lo forza.

## Comandi

| Comando | Cosa fa |
|---|---|
| `/avvia CODICEFISCALE CIFRE NRE [O\|Z]` | avvia un controllo. CIFRE = ultime 5 cifre della tessera sanitaria. Il messaggio si **cancella subito** (anche se sbagliato o da chi non è abilitato); il bot fa un giro e risponde con l'appuntamento trovato e, se ci sono già, le date anticipate. Un nuovo `/avvia` con lo stesso NRE sostituisce il precedente |
| `/cerca CODICEFISCALE CIFRE NRE [O\|Z]` | ricerca nuova con procedura guidata a pulsanti (vedi sopra). Messaggio cancellato subito |
| `/stato` | stato del cron (🟢/🟠/🔴) e dei propri controlli e ricerche: appuntamento o filtri, prima data, ultimo esito |
| `/date [N]` | controlla adesso e mostra le date (anticipate, o le prime 10 della ricerca) |
| `/stop [N]` | ferma il controllo o la ricerca e **cancella** i suoi dati |
| `/aiuto` | come si usa |
| `/id` | il proprio ID Telegram e quello della chat (risponde a tutti) |

`N` serve solo con più controlli attivi. Il bot risponde solo agli utenti di `TELEGRAM_UTENTI` e scrive nella chat
da cui è partito `/avvia`.

## Dati

Turso, tre tabelle:

- `controlli`: in chiaro solo ID, chat, utente, modalità (`anticipa`/`cerca`), tipo (`O`/`Z`), orari, ultimo
  esito e contatore errori. Cifrati con AES-256-GCM (`CHIAVE_CIFRATURA`): i dati sanitari (codice fiscale, cifre
  della tessera, NRE) e il contesto (appuntamento o filtri, zone, date già notificate). Senza la chiave, che sta
  solo su Vercel, il database non basta a leggerli. La colonna `modalita` si aggiunge da sola ai database della
  prima versione (le righe esistenti sono `anticipa`);
- `bozze`: la procedura di `/cerca` in corso, cifrata; si cancella all'avvio, all'annullamento o, se abbandonata,
  dopo un'ora (al primo giro del cron);
- `stato`: riepilogo dell'ultimo giro del cron, per `/stato`.

Codice fiscale, cifre della tessera e NRE arrivano **solo** da `/avvia`: mai variabili d'ambiente, mai nei log.
Se si cambia `CHIAVE_CIFRATURA` i controlli salvati non si leggono più: si rifà `/avvia`.

## Come parla il sito

Tutte le operazioni sono `POST /prenotaonline/jsonBroker` con corpo `application/x-www-form-urlencoded`:

```
metadata={"destination":"<servizio>","method":"handle","argumentTypes":["java.lang.String"]}
jsonBusinessArg0=<argomento JSON, url-encoded, con & → &amp;>
```

Intestazioni: `X-Prenota-Online-Channel: WEB`, `X-Prenota-Online-Token` (da `pgpcitt_genera_token`; dopo
l'accesso diventa `token | codice fiscale | ultime 5 cifre della tessera`), `X-Prenota-Online-Info`
(`versione|sistema|versione sistema|browser`). Risposta: `{ uuid, result: "<JSON>", exception: {code} | null }`.

Prima del sito c'è la sala d'attesa Queue-it (`attesa.servizirl.it`): con poco traffico rimanda subito indietro
con i cookie di accesso; se la coda è attiva il giro si salta (`InCoda`).

### Il giro (provato il 24/11/2026)

Lo stesso percorso del pulsante "Sposta" del sito, fermandosi prima di scegliere una data:

1. `pgpcitt_genera_token`, `pgpcitt_ricerca_parametro` (versione del sito, separatore del token).
2. `pgpcitt_login_gp_prv` `{codiceFiscale, crs: ultime 5 cifre, dataScadenza: "", flagIncludiCrsNonAttive: "N"}`.
3. `pgpcitt_ricerca_ricetta` `{codiceFiscale, nre, iup/iurp/rur: null, periodo: {dal: null, al: null},
   flagFlussoPostoInCoda: "N", flagIncludiNonPrenotabili: "N", codicePrestazione: "", categoriaPrestazione: ""}`:
   restituisce la ricetta **e** i suoi appuntamenti (`appuntamenti.singoli[]`: `data` `AAAAMMGGhhmmss`,
   `unitaErogante.presidio`, `agenda`, `regimeErogazione`). **Blocca la ricetta elettronica**: vedi il passo 6.
4. `pgpcitt_ricerca_zona` `{}`: la zona della provincia del presidio (`codiceComune: "%"`). Si salva dopo il
   primo giro.
5. `pgpcitt_ricerca_disponibilita` con `{codiceFiscale, zona, ricetta, tipoPrestazione, presidi: [], aziende: [],
   recapiti, vincoliTemporali: {dal: AAAAMMGG000000, al, lunedi…domenica/mattina/pomeriggio: "S"}, regimeErogazione, …}`.
   La ricetta va mandata come la manda il sito: `emessaIl`/`scadenzaIl` come mezzanotte italiana in ISO,
   `prestazioniPrenotate` (le prestazioni in stato `03`), `appuntamentiUnificati: null`; altrimenti `ES0001`.
   Risposta: `singole[]` con `appuntamento` (data, presidio, agenda), `richiesta`, `migliore`, `primaDataProposta`.
   Può metterci più di 20 secondi (timeout 40).
6. `pgpcitt_sblocca_ricetta_elettronica` `{codiceFiscale, nre}`: **sempre**, anche dopo un errore, come fa il sito
   all'uscita dal flusso.

Mai chiamati: `pgpcitt_conferma_disponibilita`, `pgpcitt_annulla_appuntamento` e simili.

## Configurazione

### Variabili d'ambiente (Vercel → Settings → Environment Variables)

| Nome | Cosa |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token del bot, da @BotFather |
| `TELEGRAM_UTENTI` | ID Telegram di chi può usare il bot, separati da virgola (da `/id`) |
| `TURSO_DATABASE_URL` | `libsql://…turso.io` |
| `TURSO_AUTH_TOKEN` | token del database, lettura e scrittura |
| `CHIAVE_CIFRATURA` | 32 byte casuali in base64: cifra i dati nel database |
| `CRON_SEGRETO` | segreto di `/api/controlla`, `/api/configura` e `/api/test-prenota`: `Authorization: Bearer …` o `?chiave=` |

Dopo aver cambiato una variabile serve un **nuovo deploy** (Deployments → ⋯ → Redeploy). Ogni push su `main`
fa il deploy in produzione da solo.

### Primo avvio

1. Deploy con tutte le variabili tranne `TELEGRAM_UTENTI`.
2. Apri `https://visit-alert.vercel.app/api/configura?chiave=<segreto>`: collega il webhook del bot (con un segreto
   che Telegram rimanda a ogni messaggio; messaggi e tocchi sui pulsanti), imposta il menu dei comandi e crea le
   tabelle. Deve rispondere `"ok": true`. Va riaperto dopo un deploy che cambia i comandi o i tipi di aggiornamento.
3. Scrivi `/id` al bot, metti il tuo ID in `TELEGRAM_UTENTI` e fai **Redeploy**.
4. Scrivi `/avvia CODICEFISCALE CIFRE NRE` al bot.
5. Su cron-job.org (fuso orario Europe/Rome) due job verso `https://visit-alert.vercel.app/api/controlla`, metodo
   GET, intestazione `Authorization: Bearer <segreto>`, timeout massimo:
   - **giorno**: ogni 15 minuti (minuti 0, 15, 30, 45), ore 7–23;
   - **notte**: ogni ora (minuto 0), ore 0–6.

   `/api/controlla` risponde subito `202 {"avviato": true}` e fa il giro dopo (`waitUntil`, fino a 120 secondi):
   cron-job.org aspetta al massimo una trentina di secondi. Per vedere il riepilogo di un giro a mano:
   `/api/controlla?chiave=<segreto>&attendi=1`.

   Le agende cambiano soprattutto di giorno, quando gli ospedali lavorano e arrivano le disdette; di notte un giro
   all'ora basta e vuol dire meno richieste al sito e ricetta sbloccata più a lungo. `/stato` lo sa: di
   giorno il cron è in ritardo oltre 25 minuti e fermo oltre 60, di notte (fino alle 7:20) 75 e 130.

Prova del sito da Vercel, senza dati personali: `/api/test-prenota?chiave=<segreto>` deve rispondere
`"ok": true`. `"inCoda": true` vuol dire sala d'attesa attiva (riprovare); un errore in fase `apertura` con
HTTP 403 vuol dire che il firewall del sito blocca Vercel.

## Sviluppo

```
npm install
npm run typecheck
npm test        # sito, Telegram e database finti (SQLite in memoria)
npm run prova   # la prova di /api/test-prenota dal proprio PC
```

## Avvertenze

Le API usate sono interne e non documentate: la Regione può cambiarle senza preavviso. Il progetto è per uso
personale, con poche richieste e solo in lettura.
