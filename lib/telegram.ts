// Chiamate alle API dei bot di Telegram.

export const LIMITE_MESSAGGIO = 4000;

export type Pulsante = { text: string; callback_data: string };
export type Tastiera = Pulsante[][];

export class Telegram {
  constructor(
    private readonly token: string,
    private readonly f: typeof fetch = fetch,
  ) {}

  async chiama(metodo: string, corpo: Record<string, unknown>): Promise<any> {
    const r = await this.f(`https://api.telegram.org/bot${this.token}/${metodo}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const j: any = await r.json().catch(() => ({}));
    // Il token è nell'indirizzo: nei messaggi d'errore si riporta solo il metodo.
    if (!j.ok) throw new Error(`Telegram ${metodo}: ${j.description ?? r.status}`);
    return j.result;
  }

  /**
   * Testo HTML; se supera il limite di Telegram si divide in più messaggi, a capo (i pulsanti vanno sull'ultimo).
   * Restituisce l'ID dell'ultimo messaggio.
   */
  async manda(chatId: string | number, testo: string, tastiera?: Tastiera): Promise<number> {
    const parti = dividi(testo);
    let id = 0;
    for (const [i, parte] of parti.entries()) {
      const m = await this.chiama("sendMessage", {
        chat_id: chatId,
        text: parte,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(tastiera && i === parti.length - 1 ? { reply_markup: { inline_keyboard: tastiera } } : {}),
      });
      id = Number(m?.message_id ?? 0);
    }
    return id;
  }

  /** Cambia testo e pulsanti di un messaggio già mandato (senza pulsanti, li toglie). */
  async modifica(chatId: string | number, messageId: number, testo: string, tastiera?: Tastiera) {
    try {
      await this.chiama("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: testo.slice(0, LIMITE_MESSAGGIO),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: tastiera ?? [] },
      });
    } catch (e) {
      // Telegram rifiuta una modifica che non cambia nulla: non è un errore.
      if (!/not modified/i.test((e as Error).message)) throw e;
    }
  }

  /** Cambia solo i pulsanti di un messaggio (il testo resta); gli errori si ignorano. */
  async pulsanti(chatId: string | number, messageId: number, tastiera: Tastiera) {
    await this.chiama("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: tastiera },
    }).catch(() => null);
  }

  /** Toglie la clessidra dal pulsante toccato, con un avviso breve facoltativo. */
  async rispondiPulsante(id: string, testo?: string) {
    await this.chiama("answerCallbackQuery", { callback_query_id: id, ...(testo ? { text: testo } : {}) }).catch(() => null);
  }

  /** Cancella un messaggio (per esempio quello con i dati sanitari); gli errori si ignorano. */
  async cancella(chatId: string | number, messageId: number): Promise<boolean> {
    try {
      await this.chiama("deleteMessage", { chat_id: chatId, message_id: messageId });
      return true;
    } catch {
      return false;
    }
  }
}

export function dividi(testo: string, limite = LIMITE_MESSAGGIO): string[] {
  if (testo.length <= limite) return [testo];
  const parti: string[] = [];
  let corrente = "";
  for (const riga of testo.split("\n")) {
    if (corrente && corrente.length + riga.length + 1 > limite) {
      parti.push(corrente);
      corrente = "";
    }
    corrente = corrente ? `${corrente}\n${riga}` : riga.slice(0, limite);
  }
  if (corrente) parti.push(corrente);
  return parti;
}

export function html(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
