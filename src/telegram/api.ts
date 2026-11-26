import type { TelegramMessageDraft } from "../domain/format.js";

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface SentMessage {
  message_id: number;
  chat: { id: number | string };
  date: number;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: number | undefined,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }

  get isRetryable(): boolean {
    return this.errorCode === 429 || (this.errorCode !== undefined && this.errorCode >= 500);
  }
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(token: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });

    const body = await response.json() as TelegramResponse<T>;
    if (!response.ok || !body.ok) {
      throw new TelegramApiError(
        body.description || `Telegram API request failed: ${method}`,
        body.error_code,
        body.parameters?.retry_after,
      );
    }
    return body.result;
  }

  getMe(): Promise<{ id: number; username?: string }> {
    return this.call<{ id: number; username?: string }>("getMe", {});
  }

  sendMessage(
    chatId: string,
    draft: TelegramMessageDraft,
  ): Promise<SentMessage> {
    return this.call<SentMessage>("sendMessage", {
      chat_id: chatId,
      text: draft.text,
      parse_mode: draft.parse_mode,
      disable_web_page_preview: draft.disable_web_page_preview,
      ...(draft.reply_markup ? { reply_markup: draft.reply_markup } : {}),
    });
  }

  editMessage(
    chatId: string,
    messageId: number,
    draft: TelegramMessageDraft,
  ): Promise<SentMessage | boolean> {
    try {
      return await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: draft.text,
        parse_mode: draft.parse_mode,
        disable_web_page_preview: draft.disable_web_page_preview,
        reply_markup: draft.reply_markup ?? { inline_keyboard: [] },
      });
    } catch (error) {
      if (error instanceof TelegramApiError && /message is not modified/i.test(error.message)) {
        return true;
      }
      throw error;
    }
  }

  async pinMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      return await this.call("pinChatMessage", {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: true,
      });
    } catch (error) {
      if (error instanceof TelegramApiError && /message is already pinned/i.test(error.message)) {
        return true;
      }
      throw error;
    }
  }

  async unpinMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      return await this.call("unpinChatMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (error) {
      if (error instanceof TelegramApiError && /message is not pinned/i.test(error.message)) {
        return true;
      }
      throw error;
    }
  }
}
