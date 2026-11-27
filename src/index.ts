export interface Env {
  TELEGRAM_BOT_TOKEN: string;
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

const encoder = new TextEncoder();

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
    const deadline = endAt ? `\nمهلت ثبت‌نام: ${escapeHtml(endAt.slice(0, 10))}` : "";
    return {
      key: `services_announcements:${id}`,
      title: text(row.title) || "ثبت‌نام فعال",
      summary: text(row.summary) || text(row.content),
      url: `${siteUrl}/services`,
      kind: "اطلاعیه",
      registration: true,
    };
  }
  return null;
}

async function sendTelegram(env: Env, item: Content): Promise<void> {
  const body = [
    `<b>${escapeHtml(item.kind)} | ${escapeHtml(item.title)}</b>`,
    escapeHtml(item.summary).slice(0, 3000),
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

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!result.ok) throw new Error(result.description || "Telegram sendMessage failed");
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

  const item = contentFrom(event, (env.SITE_URL || "https://tusancn.ir").replace(/\/$/, ""));
  if (!item) return Response.json({ ok: true, skipped: true });

  const claimed = await env.DB.prepare(
    "INSERT OR IGNORE INTO published_events (event_key, state, created_at) VALUES (?, 'processing', datetime('now'))"
  ).bind(item.key).run();
  if (!claimed.meta.changes) return Response.json({ ok: true, duplicate: true });

  try {
    await sendTelegram(env, item);
    await env.DB.prepare(
      "UPDATE published_events SET state = 'sent', sent_at = datetime('now'), last_error = NULL WHERE event_key = ?"
    ).bind(item.key).run();
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
