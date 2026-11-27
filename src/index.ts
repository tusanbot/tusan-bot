export interface Env {
  BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  SUPABASE_WEBHOOK_SECRET: string;
  DB: D1Database;
  SITE_URL?: string;
}

type SupabaseEvent = {
  type?: string;
  table?: string;
  schema?: string;
  record?: Record<string, unknown> | null;
  old_record?: Record<string, unknown> | null;
};

type Content = {
  key: string;
  title: string;
  summary: string;
  url: string;
  kind: "خبر" | "مقاله" | "اطلاعیه";
  registration?: boolean;
};

function escapeHtml(value: unknown, maxLength = Number.POSITIVE_INFINITY): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  };
  let output = "";
  for (const character of String(value ?? "")) {
    const escaped = replacements[character] || character;
    if (output.length + escaped.length > maxLength) break;
    output += escaped;
  }
  return output;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function contentFrom(event: SupabaseEvent, siteUrl: string): Content | null {
  if (event.type !== "INSERT" || event.schema !== "public" || !event.record) return null;
  const row = event.record;
  const id = text(row.id);
  if (!id) return null;

  if (event.table === "news_announcements") {
    if (text(row.status) !== "published") return null;
    const slug = text(row.slug);
    if (!slug) return null;
    return {
      key: `news_announcements:${id}`,
      title: text(row.title) || "خبر تازه",
      summary: text(row.excerpt) || text(row.content).slice(0, 500),
      url: `${siteUrl}/news/${encodeURIComponent(slug)}`,
      kind: "خبر",
    };
  }

  if (event.table === "blog_posts") {
    if (text(row.status) !== "published") return null;
    const slug = text(row.slug);
    if (!slug) return null;
    return {
      key: `blog_posts:${id}`,
      title: text(row.title) || "مقاله تازه",
      summary: text(row.excerpt) || text(row.meta_description),
      url: `${siteUrl}/blog/${encodeURIComponent(slug)}`,
      kind: "مقاله",
    };
  }

  if (event.table === "services_announcements") {
    if (text(row.type) !== "registration" || row.is_active !== true) return null;
    const endAt = text(row.extended_end_at) || text(row.end_at);
    return {
      key: `services_announcements:${id}`,
      title: text(row.title) || "ثبت‌نام فعال",
      summary: [text(row.summary) || text(row.content), endAt ? `مهلت ثبت‌نام: ${endAt.slice(0, 10)}` : ""].filter(Boolean).join("\n"),
      url: `${siteUrl}/services`,
      kind: "اطلاعیه",
      registration: true,
    };
  }
  return null;
}

async function sendTelegram(env: Env, item: Content): Promise<number> {
  const body = [
    `<b>${escapeHtml(item.kind, 80)} | ${escapeHtml(item.title, 300)}</b>`,
    escapeHtml(item.summary, 2800),
    item.registration ? "برای مشاهده جزئیات و ثبت درخواست از دکمه زیر استفاده کنید." : "",
  ].filter(Boolean).join("\n\n");

  const payload: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHANNEL_ID,
    text: body,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [[{
        text: item.registration ? "مشاهده و درخواست" : "ادامه مطلب",
        url: item.url,
      }]],
    },
  };

  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const result = await response.json() as { ok?: boolean; description?: string; result?: { message_id?: number } };
  if (!result.ok) throw new Error(result.description || "Telegram sendMessage failed");
  if (typeof result.result?.message_id !== "number") throw new Error("Telegram response did not include message_id");
  return result.result.message_id;
}

async function expireRegistration(env: Env, eventKey: string): Promise<boolean> {
  const saved = await env.DB.prepare(
    "SELECT telegram_message_id, last_error FROM published_events WHERE event_key = ? AND state = 'sent'"
  ).bind(eventKey).first<{ telegram_message_id: number | null; last_error: string | null }>();

  if (!saved?.telegram_message_id) return false;
  if (saved.last_error === "expired") return true;

  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHANNEL_ID,
      message_id: saved.telegram_message_id,
      text: "⛔️ <b>این ثبت‌نام دیگر فعال نیست.</b>\n\nمهلت ثبت‌نام به پایان رسیده یا اطلاعیه از سایت حذف شده است.",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    }),
  });

  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!result.ok) throw new Error(result.description || "Telegram editMessageText failed");

  await env.DB.prepare(
    "UPDATE published_events SET last_error = 'expired' WHERE event_key = ?"
  ).bind(eventKey).run();
  return true;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    request.headers.get("x-webhook-secret") || "";
  if (!provided || provided !== env.SUPABASE_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let event: SupabaseEvent;
  try {
    event = await request.json() as SupabaseEvent;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (event.schema === "public" && event.table === "services_announcements" &&
      (event.type === "DELETE" ||
       (event.type === "UPDATE" && event.record &&
        (event.record.is_active !== true || text(event.record.type) !== "registration")))) {
    const id = text(event.record?.id) || text(event.old_record?.id);
    if (!id) return Response.json({ ok: true, skipped: true, reason: "missing_registration_id" });
    const expired = await expireRegistration(env, `services_announcements:${id}`);
    return Response.json({ ok: true, expired });
  }

  const item = contentFrom(event, (env.SITE_URL || "https://tusancn.ir").replace(/\/$/, ""));
  if (!item) return Response.json({ ok: true, skipped: true });

  const claimed = await env.DB.prepare(
    "INSERT OR IGNORE INTO published_events (event_key, state, created_at) VALUES (?, 'processing', datetime('now'))"
  ).bind(item.key).run();
  if (!claimed.meta.changes) {
    const reclaimed = await env.DB.prepare(
      "UPDATE published_events SET state = 'processing', created_at = datetime('now'), last_error = NULL WHERE event_key = ? AND (state = 'failed' OR (state = 'processing' AND created_at < datetime('now', '-5 minutes')))"
    ).bind(item.key).run();
    if (!reclaimed.meta.changes) return Response.json({ ok: true, duplicate: true });
  }

  try {
    const messageId = await sendTelegram(env, item);
    await env.DB.prepare(
      "UPDATE published_events SET state = 'sent', sent_at = datetime('now'), telegram_message_id = ?, last_error = NULL WHERE event_key = ?"
    ).bind(messageId, item.key).run();
    return Response.json({ ok: true, sent: true });
  } catch (error) {
    await env.DB.prepare(
      "UPDATE published_events SET state = 'failed', last_error = ? WHERE event_key = ?"
    ).bind(String(error).slice(0, 1000), item.key).run();
    return new Response("Publish failed", { status: 502 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "tosan-telegram-publisher" });
    }
    if (request.method === "POST" && url.pathname === "/webhooks/supabase") {
      return handleWebhook(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
