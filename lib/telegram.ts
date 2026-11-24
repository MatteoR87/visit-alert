// Chiamate alle API dei bot di Telegram.

export const LIMITE_MESSAGGIO = 4000;

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

  /** Testo HTML; se supera il limite di Telegram si divide in più messaggi, a capo. */
  async manda(chatId: string | number, testo: string) {
    for (const parte of dividi(testo)) {
      await this.chiama("sendMessage", {
        chat_id: chatId,
        text: parte,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
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
