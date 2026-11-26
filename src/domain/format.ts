import type { NormalizedContent } from "./content.js";

const MAX_MESSAGE_LENGTH = 4_000;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function formatTehranDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "long",
    timeZone: "Asia/Tehran",
  }).format(date);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export interface TelegramMessageDraft {
  text: string;
  parse_mode: "HTML";
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
  disable_web_page_preview?: boolean;
}

export function renderContentMessage(
  item: NormalizedContent,
): TelegramMessageDraft {
  const label = item.kind === "article" ? "📚 <b>آموزش و مقاله</b>" : "📰 <b>خبر و اطلاعیه</b>";
  const summary = stripHtml(item.summary || item.content);
  const body = [
    label,
    "",
    `<b>${escapeHtml(truncate(item.title, 450))}</b>`,
    "",
    escapeHtml(truncate(summary, 2_600)),
    "",
    `<a href="${escapeHtml(item.publicUrl)}">ادامه مطلب ←</a>`,
    "",
    "<i>وب‌سایت توسن</i>",
  ].join("\n");

  return {
    text: truncate(body, MAX_MESSAGE_LENGTH),
    parse_mode: "HTML",
    disable_web_page_preview: false,
  };
}

export function renderRegistrationMessage(
  item: NormalizedContent,
  expired = false,
): TelegramMessageDraft {
  const start = formatTehranDate(item.startsAt);
  const end = formatTehranDate(item.endsAt);
  const summary = stripHtml(item.summary || item.content);
  const lines = [
    expired ? "⛔ <b>ثبت‌نام منقضی شده است</b>" : "🟢 <b>ثبت‌نام فعال</b>",
    "",
    `<b>${escapeHtml(truncate(item.title, 450))}</b>`,
    summary ? "" : null,
    summary ? escapeHtml(truncate(summary, 2_000)) : null,
    start ? `\n🗓 شروع: ${escapeHtml(start)}` : null,
    end ? `⏳ پایان مهلت: ${escapeHtml(end)}` : null,
    "",
    "<i>اطلاعات از وب‌سایت توسن</i>",
  ].filter((line): line is string => line !== null);

  const draft: TelegramMessageDraft = {
    text: truncate(lines.join("\n"), MAX_MESSAGE_LENGTH),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  if (!expired && item.requestUrl) {
    draft.reply_markup = {
      inline_keyboard: [[{
        text: item.buttonLabel || "ثبت درخواست و ورود به سامانه",
        url: item.requestUrl,
      }]],
    };
  }
  return draft;
}
