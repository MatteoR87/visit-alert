# visit-alert

Avvisa su Telegram quando su [PrenotaSalute](https://prenotasalute.regione.lombardia.it/prenotaonline/)
(Regione Lombardia) si libera una data **prima** dell'appuntamento già prenotato, **nella stessa struttura**.

Funzioni Vercel senza framework (TypeScript, moduli ESM, regione `fra1`), solo chiamate HTTP alle API interne del
sito: nessun browser.

## Stato

- ✅ Client HTTP del sito (`lib/prenota.ts`): sala d'attesa Queue-it, cookie, token, chiamate a `jsonBroker`.
- ✅ `/api/test-prenota`: il sito risponde a Vercel?
- ⏳ Accesso con i dati della ricetta, lettura dell'appuntamento, ricerca delle date nella stessa struttura.
- ⏳ Bot Telegram, database, `/api/controlla` chiamato da cron-job.org.

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

### Il giro di controllo (provato il 24/11/2026)

Lo stesso percorso del pulsante "Sposta" del sito, fermandosi prima di scegliere una data:

1. `pgpcitt_genera_token`, `pgpcitt_ricerca_parametro` (versione del sito, separatore del token).
2. `pgpcitt_login_gp_prv` `{codiceFiscale, crs: ultime 5 cifre, dataScadenza: "", flagIncludiCrsNonAttive: "N"}`.
3. `pgpcitt_ricerca_ricetta` `{codiceFiscale, nre, iup/iurp/rur: null, periodo: {dal: null, al: null},
   flagFlussoPostoInCoda: "N", flagIncludiNonPrenotabili: "N", codicePrestazione: "", categoriaPrestazione: ""}`:
   restituisce la ricetta **e** i suoi appuntamenti (`appuntamenti.singoli[]`: `data` `AAAAMMGGhhmmss`,
   `unitaErogante.presidio`, `agenda`, `regimeErogazione`). **Blocca la ricetta elettronica**: vedi il passo 6.
4. `pgpcitt_ricerca_zona` `{}`: la zona della provincia del presidio (`codiceComune: "%"`).
5. `pgpcitt_ricerca_disponibilita` con `{codiceFiscale, zona, ricetta, tipoPrestazione, presidi: [], aziende: [],
   recapiti, vincoliTemporali: {dal: AAAAMMGG000000, al, lunedi…domenica/mattina/pomeriggio: "S"}, regimeErogazione, …}`.
   La ricetta va mandata come la manda il sito: `emessaIl`/`scadenzaIl` come data ISO, `prestazioniPrenotate`
   (le prestazioni in stato `03`), `appuntamentiUnificati: null`; altrimenti risponde `ES0001`.
   `tipoPrestazione`: `O` prima visita, `Z` controllo (il sito lo chiede se non lo capisce dalla ricetta).
   Risposta: `singole[]` con `appuntamento` (data, presidio, agenda), `richiesta`, `migliore`, `primaDataProposta`.
   Può metterci più di 20 secondi.
6. `pgpcitt_sblocca_ricetta_elettronica` `{codiceFiscale, nre}`: **sempre**, anche dopo un errore, come fa il sito
   all'uscita dal flusso.

Mai chiamati: `pgpcitt_conferma_disponibilita`, `pgpcitt_annulla_appuntamento` e simili.

## Dati sanitari

Codice fiscale, ultime 5 cifre della tessera sanitaria e numero di ricetta (NRE) **non** sono variabili d'ambiente:
si passano al bot quando si avvia il controllo. Non si stampano mai nei log.

## Configurazione

| Variabile (Vercel → Settings → Environment Variables) | Cosa |
|---|---|
| `CRON_SEGRETO` | segreto delle chiamate di servizio: `Authorization: Bearer …` o `?chiave=` |

Prova dopo il deploy: `https://<progetto>.vercel.app/api/test-prenota?chiave=<segreto>` deve rispondere
`"ok": true`. `"inCoda": true` vuol dire sala d'attesa attiva (riprovare); un errore in fase `apertura` con
HTTP 403 vuol dire che il firewall del sito blocca Vercel.

## Sviluppo

```
npm install
npm run typecheck
npm test        # con un sito finto
npm run prova   # la prova di /api/test-prenota dal proprio PC
```

## Avvertenze

Le API usate sono interne e non documentate: la Regione può cambiarle senza preavviso. Il progetto è per uso
personale, con poche richieste (un giro ogni 15 minuti) e solo in lettura: non prenota né disdice nulla.
