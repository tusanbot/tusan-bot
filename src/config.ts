const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const url = (name: string, value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  return parsed.toString().replace(/\/$/, "");
};

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChannelId: required("TELEGRAM_CHANNEL_ID"),
  supabaseUrl: url("SUPABASE_URL", required("SUPABASE_URL")),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  siteUrl: url("SITE_URL", required("SITE_URL")),
  newsUrlTemplate: process.env.NEWS_URL_TEMPLATE?.trim() || null,
  serviceRequestUrlTemplate: required("SERVICE_REQUEST_URL_TEMPLATE"),
  sourcePollIntervalMs: positiveInteger("SOURCE_POLL_INTERVAL_MS", 300_000),
  queuePollIntervalMs: positiveInteger("QUEUE_POLL_INTERVAL_MS", 30_000),
  queueBatchSize: positiveInteger("QUEUE_BATCH_SIZE", 10),
  timezone: "Asia/Tehran" as const,
};

export function renderUrlTemplate(template: string, slug: string): string {
  if (!template.includes("{slug}")) {
    throw new Error("URL template must contain the {slug} placeholder");
  }
  const rendered = template.replaceAll("{slug}", encodeURIComponent(slug));
  const parsed = new URL(rendered);
  if (parsed.protocol !== "https:") {
    throw new Error("Generated content URLs must use HTTPS");
  }
  return parsed.toString();
}
