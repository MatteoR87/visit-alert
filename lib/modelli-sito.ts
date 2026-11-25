// I modelli AngularJS del sito (moduli gpmodel/gprefdata/pgpcitt) che costruiscono la richiesta di
// pgpcitt_conferma_disponibilita: ogni `newFrom` copia solo i suoi campi (gli assenti restano null, oppure
// undefined e quindi fuori dal JSON, come nel sito) e trasforma i sotto-oggetti con i loro modelli.
// Riprodotti a mano dal JS del sito (app-64b09c8551.js) e confrontati con una conferma riuscita dal sito
// (25/11/2026). Le date restano stringhe (Dates.newDate lascia le stringhe come sono).

type O = Record<string, any>;
const presente = (x: unknown): x is O => x !== null && x !== undefined && x !== false && x !== 0 && x !== "";

/** RData: {codice, descrizione} (anche quesitoDiagnostico). */
export const rData = (t: any) => ({ codice: presente(t) ? t.codice : null, descrizione: presente(t) ? t.descrizione : null });

const infoLink = (t: any) => ({ testo: presente(t) ? t.testo : null, link: presente(t) ? t.link : null });

const localita = (t: any) =>
  presente(t)
    ? { codice: t.codice, descrizione: t.descrizione, cap: t.cap, siglaProvincia: t.siglaProvincia }
    : { codice: null, descrizione: null, cap: null, siglaProvincia: null };

/** Coordinate: longitude da x, latitude da y. */
const coordinate = (t: any) => ({
  latitude: presente(t) ? (t.y ? t.y : t.latitude) : null,
  longitude: presente(t) ? (t.x ? t.x : t.longitude) : null,
});

const indirizzo = (t: any) =>
  presente(t)
    ? { toponimo: t.toponimo, descrizione: t.descrizione, civico: t.civico, frazione: t.frazione, coordinate: coordinate(t) }
    : { toponimo: null, descrizione: null, civico: null, frazione: null, coordinate: null };

const puntoIndirizzo = (t: any) =>
  presente(t) ? { localita: localita(t.localita), indirizzo: indirizzo(t.indirizzo) } : { localita: null, indirizzo: null };

/** FlagAzienda: null se assente. */
const flagAzienda = (t: any) =>
  presente(t)
    ? {
        prioritaB: t.prioritaB,
        differita: t.differita,
        unitaPrenotante: t.unitaPrenotante,
        differitaVisibile: t.differitaVisibile,
        abilitataPagamento: t.abilitataPagamento,
      }
    : null;

const infoPrenotazione = (t: any) =>
  presente(t) ? { telefono: t.telefono, orari: Array.isArray(t.orari) ? [...t.orari] : [] } : { telefono: null, orari: null };

export const azienda = (t: any) =>
  presente(t)
    ? {
        id: t.id,
        codice: t.codice,
        descrizione: t.descrizione,
        area: t.area,
        email: t.email,
        sito: t.sito,
        flag: flagAzienda(t.flag),
        infoPrenotazione: infoPrenotazione(t.infoPrenotazione),
      }
    : { id: null, codice: null, descrizione: null, area: null, email: null, sito: null, flag: null, infoPrenotazione: null };

const flagUnitaPrenotante = (t: any) => (presente(t) ? { inibizioneNre: t.inibizioneNre } : null);

const unitaPrenotante = (t: any) =>
  presente(t)
    ? { codice: t.codice, descrizione: t.descrizione, azienda: azienda(t.azienda), flag: flagUnitaPrenotante(t.flag) }
    : { codice: null, descrizione: null, azienda: null, flag: null };

const presidio = (t: any) =>
  presente(t)
    ? {
        id: t.id,
        codice: t.codice,
        descrizione: t.descrizione,
        descrizioneEstesa: t.descrizioneEstesa,
        email: t.email,
        puntoIndirizzo: puntoIndirizzo(t.puntoIndirizzo),
        azienda: azienda(t.azienda),
        telefono: t.telefono,
        orariApertura: t.orariApertura,
        periodoChiusura: t.periodoChiusura,
        distanza: null,
      }
    : {
        id: null, codice: null, descrizione: null, descrizioneEstesa: null, email: null, puntoIndirizzo: null,
        azienda: null, telefono: null, orariApertura: null, periodoChiusura: null, distanza: null,
      };

/** Ue: null se assente (unitaErogante / unitaErogatrice). */
const ue = (t: any) =>
  presente(t)
    ? {
        codice: t.codice,
        descrizione: t.descrizione,
        telefono: t.telefono,
        puntoIndirizzo: puntoIndirizzo(t.puntoIndirizzo),
        unitaPrenotante: unitaPrenotante(t.unitaPrenotante),
        presidio: presidio(t.presidio),
        cdSissUe: t.cdSissUe,
      }
    : null;

const prestazioneAppuntamento = (t: any) => {
  const campi = [
    "codice", "descrizione", "codiceDistretto", "codiceMetodica", "flagExAsl", "flagEsameLaboratorio",
    "flagAmbulatoriale", "flagVaccinoAntinfluenzale", "flagTamponeRapido", "flagTamponeCovid",
    "codiceNomenclatoreNazionale", "codiceNomenclatoreRegionale", "codCatalogoPrescr",
  ];
  return Object.fromEntries(campi.map((k) => [k, presente(t) ? t[k] : null]));
};

const appuntamentoAgenda = (t: any) =>
  presente(t)
    ? { codice: t.codice, descrizione: t.descrizione, note: t.note, noteAggiuntive: t.noteAggiuntive }
    : { codice: null, descrizione: null, note: null, noteAggiuntive: null };

/** AppuntamentoCittadino: sempre un oggetto (il sito controlla solo `null !==`). */
const appuntamentoCittadino = (t: any) => {
  const campi = ["codiceFiscale", "codiceSanitario", "nome", "cognome", "sesso", "nascita", "localita", "residenza", "indirizzo", "tel", "sms", "email"];
  return Object.fromEntries(campi.map((k) => [k, t != null ? t[k] : null]));
};

const risorsa = (t: any) =>
  presente(t)
    ? {
        codice: t.codice,
        nome: t.nome,
        cognome: t.cognome,
        azienda: t.azienda,
        idPresidio: t.idPresidio,
        idAgenda: t.idAgenda,
        agende: t.agende || [],
        aziende: t.aziende,
        presidi: t.presidi,
        descrizione: `${t.nome} ${t.cognome}`,
      }
    : { codice: "", nome: "", cognome: "", azienda: null, idPresidio: null, idAgenda: "", agende: [], aziende: [], presidi: [], descrizione: "" };

/** Ricetta.newFromAppuntamento: una Ricetta vuota con iup, iurp e modulo {id, tipo}. */
export function ricettaDaAppuntamento(a: any) {
  return {
    iup: a?.iup, iurp: a?.iurp, cittadino: null, emessaIl: null, scadenzaIl: null, tipo: null,
    modulo: { id: a?.modulo, tipo: null }, flagRe: null, priorita: null, urgenza: null,
    tipoPrestazione: null, stato: null, quesitoDiagnostico: null, note: null, esenzione: null,
    flagEsenzionePatologia: null, flagAltreEsenzioni: null, flagSuggerita: null, brancaSpecialistica: null,
    provenienzaPrescrizione: null, prescrittore: null, nrPrestazioni: null, prestazioni: [],
    prestazioniPrenotate: [], datiRispostaMEF: null, appuntamenti: null, appuntamentiUnificati: [],
    daSbloccare: false,
  };
}

/** Appuntamento.newFrom (per un appuntamento non MOSA: prestazione = PrestazioneAppuntamento). */
export function appuntamento(u: any) {
  const ueErogante = ue(u?.unitaErogante);
  return {
    uuid: u?.uuid,
    idAppuntamento: u?.idAppuntamento,
    iup: u?.iup,
    iurp: u?.iurp,
    modulo: u?.modulo,
    associazione: u?.associazione,
    ipCup: u?.ipCup,
    cup: u?.cup,
    data: u?.data,
    cittadino: appuntamentoCittadino(u?.cittadino ?? null),
    prenotatoIl: u?.prenotatoIl,
    registratoIl: u?.registratoIl,
    modificatoIl: u?.modificatoIl,
    annullatoIl: u?.annullatoIl,
    noteAnnullamento: u?.noteAnnullamento,
    stato: u?.stato,
    tipo: u?.tipo,
    prestazione: prestazioneAppuntamento(u?.prestazione),
    azienda: azienda(u?.azienda),
    unitaErogante: ueErogante,
    unitaErogatrice: ue(u?.unitaErogatrice),
    agenda: appuntamentoAgenda(u?.agenda),
    infoNote: infoLink(u?.infoNote),
    infoNotePreparazione: infoLink(u?.infoNotePreparazione),
    infoLuogoPresentazione: infoLink(u?.infoLuogoPresentazione),
    infoMemorandum: infoLink(u?.infoMemorandum),
    infoNoteDisdettaPrenotazione: infoLink(u?.infoNoteDisdettaPrenotazione),
    infoConsensoInformato: infoLink(u?.infoConsensoInformato),
    infoMezzi: infoLink(u?.infoMezzi),
    cicli: Array.isArray(u?.cicli) ? u.cicli : [],
    quesitoDiagnostico: rData(u?.quesitoDiagnostico),
    differita: null,
    ricetta: ricettaDaAppuntamento(u),
    regimeErogazione: u?.regimeErogazione,
    risorsa: risorsa(u?.risorsa),
    tariffaLp: u?.tariffaLp,
    importo: u?.importo,
  };
}

/** Disponibilita.newFrom + getPrestazioni() (chiamata dalla finestra di verifica prima della conferma). */
export function disponibilita(singola: any) {
  const a = appuntamento(singola?.appuntamento);
  return {
    selezionabile: true,
    appuntamento: a,
    prestazioni: [a.prestazione],
    richiesta: singola?.richiesta,
    primaDataProposta: singola?.primaDataProposta,
  };
}

const stato = (t: any) =>
  presente(t) ? { codice: t.codice, descrizione: t.descrizione, data: t.data } : { codice: null, descrizione: null, data: null };

const prestazione = (t: any) =>
  presente(t)
    ? {
        id: t.id, codice: t.codice, descrizione: t.descrizione, altreDescrizioni: t.altreDescrizioni,
        altreDescrizioniVis: null, tipo: t.tipo, stato: stato(t.stato), nota: t.nota, flagCiclica: t.flagCiclica,
        flagPrenotabile: t.flagPrenotabile, flagPrenotabileCittadino: t.flagPrenotabileCittadino,
        quantitaPrescritta: t.quantitaPrescritta, flagExAsl: t.flagExAsl, flagEsameLaboratorio: t.flagEsameLaboratorio,
        flagAmbulatoriale: t.flagAmbulatoriale, flagSceltaEsenzione: t.flagSceltaEsenzione, flagRadiologia: t.flagRadiologia,
        flagVaccinoAntinfluenzale: t.flagVaccinoAntinfluenzale, flagTamponeRapido: t.flagTamponeRapido,
        flagTamponeCovid: t.flagTamponeCovid, flagMedicoAderente: t.flagMedicoAderente, codiceMef: t.codiceMef,
        codiceNomenclatoreNazionale: t.codiceNomenclatoreNazionale,
        codiceNomenclatoreRegionale: t.codiceNomenclatoreRegionale, codCatalogoPrescr: t.codCatalogoPrescr,
        agende: t.agende || [],
      }
    : null;

/**
 * Ricetta.newFrom della ricetta dei criteri, con appuntamenti e appuntamentiUnificati a null
 * (ConfermaDisponibilita.newDefault). `prestazioniPrenotate` = prestazioni in stato 03.
 */
export function ricettaPerConferma(t: any) {
  const prestazioni = (t?.prestazioni ?? []).map(prestazione);
  return {
    iup: t?.iup,
    iurp: t?.iurp,
    cittadino: { codiceFiscale: t?.cittadino?.codiceFiscale },
    emessaIl: t?.emessaIl,
    scadenzaIl: t?.scadenzaIl,
    tipo: t?.tipo,
    modulo: presente(t?.modulo) ? { id: t.modulo.id, tipo: t.modulo.tipo } : { id: null, tipo: null },
    flagRe: t?.flagRe,
    priorita: t?.priorita,
    urgenza: t?.urgenza,
    tipoPrestazione: t?.tipoPrestazione,
    stato: stato(t?.stato),
    quesitoDiagnostico: rData(t?.quesitoDiagnostico),
    note: t?.note,
    esenzione: presente(t?.esenzione)
      ? { codice: t.esenzione.codice, descrizione: t.esenzione.descrizione, cdStampato: t.esenzione.cdStampato, cdNazionale: t.esenzione.cdNazionale }
      : { codice: null, descrizione: null, cdStampato: null, cdNazionale: null },
    flagEsenzionePatologia: t?.flagEsenzionePatologia,
    flagAltreEsenzioni: t?.flagAltreEsenzioni,
    flagSuggerita: t?.flagSuggerita,
    brancaSpecialistica: t?.brancaSpecialistica,
    provenienzaPrescrizione: t?.provenienzaPrescrizione,
    prescrittore: presente(t?.prescrittore)
      ? { codiceFiscale: t.prescrittore.codiceFiscale, codiceRegionale: t.prescrittore.codiceRegionale, nome: t.prescrittore.nome, cognome: t.prescrittore.cognome }
      : { codiceFiscale: null, codiceRegionale: null, nome: null, cognome: null },
    nrPrestazioni: t?.nrPrestazioni,
    prestazioni,
    prestazioniPrenotate: prestazioni.filter((p: any) => p?.stato?.codice === "03"),
    datiRispostaMEF: t?.datiRispostaMEF,
    appuntamenti: null,
    appuntamentiUnificati: null,
    daSbloccare: false,
  };
}

/** Zona.newFrom. */
export const zona = (t: any) => ({
  descrizione: t?.descrizione,
  codiceProvincia: t?.codiceProvincia,
  codiceComune: t?.codiceComune,
  codice: `${t?.codiceProvincia}${t?.codiceComune}`,
  abilitazionePiuPiu: t?.abilitazionePiuPiu,
  abilitazioneNre: t?.abilitazioneNre,
});
