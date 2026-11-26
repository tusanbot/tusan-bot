import { config, renderUrlTemplate } from "../config.js";
import type { NormalizedContent, SourceTable } from "../domain/content.js";
import { supabase } from "../supabase.js";

type SourceRow = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeHttpsUrl(value: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function relationOne(value: unknown): SourceRow | null {
  if (Array.isArray(value)) return (value[0] as SourceRow | undefined) ?? null;
  return value && typeof value === "object" ? value as SourceRow : null;
}

async function readRows(table: SourceTable, columns: string): Promise<SourceRow[]> {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .order("updated_at", { ascending: true })
    .limit(2_000);

  if (error) throw new Error("Supabase read failed for " + table + ": " + error.message);
  return (data ?? []) as SourceRow[];
}

export async function loadPublishedContent(): Promise<NormalizedContent[]> {
  const [newsRows, blogRows, registrationRows] = await Promise.all([
    readRows(
      "news_announcements",
      "id,title,slug,excerpt,content,status,is_active_registration,registration_start_at,registration_end_at,published_at,created_at,updated_at,official_url,source_url",
    ),
    readRows(
      "blog_posts",
      "id,title,slug,excerpt,content,status,published_at,created_at,updated_at",
    ),
    readRows(
      "services_announcements",
      "id,title,type,summary,content,start_at,end_at,extended_end_at,is_active,is_extendable,button_label,service_id,priority,created_at,updated_at,services:services(slug,is_active)",
    ),
  ]);

  const news: NormalizedContent[] = newsRows
    .filter((row) => row.status === "published")
    .map((row) => {
      const slug = text(row.slug);
      const isRegistration = row.is_active_registration === true;
      return {
        sourceTable: "news_announcements",
        sourceId: text(row.id),
        kind: isRegistration ? "registration" : "news",
        title: text(row.title),
        summary: text(row.excerpt),
        content: text(row.content),
        publicUrl: config.newsUrlTemplate ? renderUrlTemplate(config.newsUrlTemplate, slug) : "",
        updatedAt: dateOrNull(row.updated_at) ?? dateOrNull(row.published_at) ?? new Date(0).toISOString(),
        createdAt: dateOrNull(row.created_at) ?? dateOrNull(row.published_at) ?? new Date(0).toISOString(),
        isActive: isRegistration,
        startsAt: dateOrNull(row.registration_start_at),
        endsAt: dateOrNull(row.registration_end_at),
        requestUrl: isRegistration
          ? safeHttpsUrl(text(row.official_url)) ?? safeHttpsUrl(text(row.source_url))
          : null,
        buttonLabel: isRegistration ? "ثبت درخواست / مشاهده شرایط" : null,
      };
    })
    .filter((item) => item.sourceId && item.title);

  const blogs: NormalizedContent[] = blogRows
    .filter((row) => row.status === "published")
    .map((row) => ({
      sourceTable: "blog_posts",
      sourceId: text(row.id),
      kind: "article",
      title: text(row.title),
      summary: text(row.excerpt),
      content: text(row.content),
      publicUrl: config.siteUrl + "/blog/" + encodeURIComponent(text(row.slug)),
      updatedAt: dateOrNull(row.updated_at) ?? dateOrNull(row.published_at) ?? new Date(0).toISOString(),
      createdAt: dateOrNull(row.created_at) ?? dateOrNull(row.published_at) ?? new Date(0).toISOString(),
      isActive: true,
      startsAt: null,
      endsAt: null,
      requestUrl: null,
      buttonLabel: null,
    }))
    .filter((item) => item.sourceId && item.title && item.publicUrl);

  const registrations: NormalizedContent[] = registrationRows
    .filter((row) => row.type === "registration")
    .map((row) => {
      const service = relationOne(row.services);
      const serviceSlug = text(service?.slug);
      const requestUrl = serviceSlug
        ? renderUrlTemplate(config.serviceRequestUrlTemplate, serviceSlug)
        : null;
      const endAt = dateOrNull(row.extended_end_at) ?? dateOrNull(row.end_at);
      return {
        sourceTable: "services_announcements",
        sourceId: text(row.id),
        kind: "registration",
        title: text(row.title),
        summary: text(row.summary),
        content: text(row.content),
        publicUrl: requestUrl ?? config.siteUrl,
        updatedAt: dateOrNull(row.updated_at) ?? dateOrNull(row.created_at) ?? new Date(0).toISOString(),
        createdAt: dateOrNull(row.created_at) ?? new Date(0).toISOString(),
        isActive: row.is_active === true && (service?.is_active !== false),
        startsAt: dateOrNull(row.start_at),
        endsAt: endAt,
        requestUrl,
        buttonLabel: text(row.button_label) || "ثبت درخواست و ورود به سامانه",
      };
    })
    .filter((item) => item.sourceId && item.title);

  return [...news, ...blogs, ...registrations];
}
