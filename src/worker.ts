import { createHash } from "node:crypto";
import { config } from "./config.js";
import type { NormalizedContent, SourceTable } from "./domain/content.js";
import { renderContentMessage, renderRegistrationMessage } from "./domain/format.js";
import { supabase } from "./supabase.js";
import { loadPublishedContent } from "./sources/supabase-source.js";
import { TelegramApiError, TelegramClient } from "./telegram/api.js";

interface PublicationRow {
  id: string;
  source_table: SourceTable;
  source_id: string;
  chat_id: string;
  message_id: number | null;
  content_hash: string;
  source_updated_at: string | null;
  publication_status: "pending" | "published" | "expired" | "removed" | "failed" | "ignored";
  is_pinned: boolean;
  first_published_at: string | null;
}

interface QueueRow {
  id: string;
  source_table: SourceTable;
  source_id: string;
  operation: "publish" | "edit" | "expire" | "remove";
  payload: NormalizedContent;
  attempts: number;
}

const telegram = new TelegramClient(config.telegramBotToken);
const channelId = config.telegramChannelId;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRegistrationActive(item: NormalizedContent, now = Date.now()): boolean {
  if (!item.isActive || !item.endsAt) return false;
  const starts = item.startsAt ? Date.parse(item.startsAt) : Number.NEGATIVE_INFINITY;
  const ends = Date.parse(item.endsAt);
  return (item.startsAt === null || Number.isFinite(starts)) && Number.isFinite(ends) && starts <= now && ends > now;
}

function shouldPublish(item: NormalizedContent, now = Date.now()): boolean {
  return item.kind !== "registration" || isRegistrationActive(item, now);
}

async function ensureInitialBaseline(): Promise<void> {
  let { data: meta, error } = await supabase
    .from("telegram_publisher_meta")
    .select("key,value,created_at")
    .eq("key", "initial_baseline")
    .maybeSingle();
  if (error) throw new Error("Could not read publisher baseline: " + error.message);

  if (!meta) {
    const inserted = await supabase.from("telegram_publisher_meta")
      .insert({ key: "initial_baseline", value: { completed: false } })
      .select("key,value,created_at")
      .maybeSingle();
    if (inserted.error && inserted.error.code !== "23505") {
      throw new Error("Could not create publisher baseline: " + inserted.error.message);
    }
    if (inserted.data) {
      meta = inserted.data;
    } else {
      const reread = await supabase.from("telegram_publisher_meta")
        .select("key,value,created_at")
        .eq("key", "initial_baseline")
        .single();
      if (reread.error) throw new Error("Could not reload publisher baseline: " + reread.error.message);
      meta = reread.data;
    }
  }

  const metaValue = meta.value as { completed?: boolean };
  if (metaValue?.completed) return;

  const baselineAt = Date.parse(meta.created_at);
  if (!Number.isFinite(baselineAt)) throw new Error("Publisher baseline timestamp is invalid");
  const items = await loadPublishedContent();
  const historical = items.filter((item) => Date.parse(item.updatedAt) <= baselineAt);

  for (const item of historical) {
    const { error: upsertError } = await supabase.from("telegram_publications").upsert({
      source_table: item.sourceTable,
      source_id: item.sourceId,
      chat_id: channelId,
      content_hash: hash(item),
      source_updated_at: item.updatedAt,
      publication_status: "ignored",
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "source_table,source_id,chat_id", ignoreDuplicates: true });
    if (upsertError) throw new Error("Could not baseline historical content: " + upsertError.message);
  }

  const activeRegistrations = historical
    .filter((item) => item.kind === "registration" && item.requestUrl && isRegistrationActive(item))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  // Publish every currently active registration so an older active item can
  // become pinned when a newer one expires. Historical news/articles stay skipped.
  for (const item of activeRegistrations) {
    await enqueue(item, "publish");
    if (item.endsAt) await enqueue(item, "expire", item.endsAt);
  }

  const { error: completeError } = await supabase.from("telegram_publisher_meta")
    .update({ value: { completed: true }, updated_at: new Date().toISOString() })
    .eq("key", "initial_baseline");
  if (completeError) throw new Error("Could not complete publisher baseline: " + completeError.message);
}

async function readPublications(): Promise<PublicationRow[]> {
  const { data, error } = await supabase
    .from("telegram_publications")
    .select("id,source_table,source_id,chat_id,message_id,content_hash,source_updated_at,publication_status,is_pinned,first_published_at")
    .eq("chat_id", channelId);
  if (error) throw new Error("Could not read telegram_publications: " + error.message);
  return (data ?? []) as PublicationRow[];
}

async function enqueue(
  item: NormalizedContent,
  operation: QueueRow["operation"],
  availableAt = new Date().toISOString(),
): Promise<void> {
  const eventKey = hash({
    sourceTable: item.sourceTable,
    sourceId: item.sourceId,
    operation,
    contentHash: hash(item),
    updatedAt: item.updatedAt,
  });
  const { error } = await supabase.from("telegram_publish_queue").upsert({
    event_key: eventKey,
    source_table: item.sourceTable,
    source_id: item.sourceId,
    operation,
    payload: item,
    status: "pending",
    attempts: 0,
    available_at: availableAt,
  }, { onConflict: "event_key", ignoreDuplicates: true });
  if (error) throw new Error("Could not enqueue " + eventKey + ": " + error.message);
}

async function markNewsIgnored(item: NormalizedContent, publication: PublicationRow | undefined): Promise<void> {
  if (!publication) {
    const { error } = await supabase.from("telegram_publications").upsert({
      source_table: item.sourceTable,
      source_id: item.sourceId,
      chat_id: channelId,
      content_hash: hash(item),
      source_updated_at: item.updatedAt,
      publication_status: "ignored",
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "source_table,source_id,chat_id", ignoreDuplicates: true });
    if (error) throw new Error("Could not mark news as waiting for a public route: " + error.message);
  } else if (publication.publication_status === "ignored") {
    const { error } = await supabase.from("telegram_publications").update({
      content_hash: hash(item),
      source_updated_at: item.updatedAt,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("source_table", item.sourceTable).eq("source_id", item.sourceId).eq("chat_id", channelId);
    if (error) throw new Error("Could not update ignored news baseline: " + error.message);
  }
}

export async function reconcileSources(): Promise<void> {
  const [items, publications] = await Promise.all([loadPublishedContent(), readPublications()]);
  const now = Date.now();
  const currentByKey = new Map(items.map((item) => [item.sourceTable + ":" + item.sourceId, item]));
  const publicationByKey = new Map(publications.map((row) => [row.source_table + ":" + row.source_id, row]));

  for (const item of items) {
    const key = item.sourceTable + ":" + item.sourceId;
    const publication = publicationByKey.get(key);
    if (item.kind === "registration" && !item.requestUrl) {
      if (publication?.publication_status === "published") await enqueue(item, "expire");
      continue;
    }
    if (item.sourceTable === "news_announcements" && item.kind !== "registration" && !item.publicUrl) {
      await markNewsIgnored(item, publication);
      continue;
    }
    const eligible = shouldPublish(item, now);
    const startAt = item.startsAt ? Date.parse(item.startsAt) : now;
    const endAt = item.endsAt ? Date.parse(item.endsAt) : Number.NaN;

    if (!publication) {
      if (eligible) {
        await enqueue(item, "publish");
      } else if (
        item.kind === "registration" &&
        item.isActive &&
        Number.isFinite(startAt) &&
        startAt > now &&
        Number.isFinite(endAt) &&
        endAt > now
      ) {
        await enqueue(item, "publish", new Date(startAt).toISOString());
      }
      if (item.kind === "registration" && item.isActive && Number.isFinite(endAt) && endAt > now) {
        await enqueue(item, "expire", new Date(endAt).toISOString());
      }
      continue;
    }

    if (publication.publication_status === "ignored") {
      if (eligible && item.updatedAt !== publication.source_updated_at) {
        await enqueue(item, "publish");
      } else if (
        item.kind === "registration" &&
        item.isActive &&
        item.startsAt &&
        Date.parse(item.startsAt) > now &&
        item.endsAt &&
        Date.parse(item.endsAt) > now
      ) {
        await enqueue(item, "publish", item.startsAt);
        await enqueue(item, "expire", item.endsAt);
      }
      continue;
    }

    if (
      !eligible &&
      item.kind === "registration" &&
      item.isActive &&
      Number.isFinite(startAt) &&
      startAt > now &&
      Number.isFinite(endAt) &&
      endAt > now &&
      (publication.publication_status === "expired" || publication.publication_status === "removed")
    ) {
      await enqueue(item, "publish", new Date(startAt).toISOString());
    } else if (eligible && (publication.publication_status === "expired" || publication.publication_status === "removed")) {
      await enqueue(item, "publish");
    } else if (publication.publication_status === "published" && !eligible) {
      await enqueue(item, "expire");
    } else if (eligible && publication.publication_status === "published" && publication.content_hash !== hash(item)) {
      await enqueue(item, "edit");
    }

    // Persist the deadline as a scheduled queue job. If the source is extended,
    // the old job re-checks the current row and moves itself to the new deadline.
    if (item.kind === "registration" && item.isActive && Number.isFinite(endAt) && endAt > now) {
      await enqueue(item, "expire", new Date(endAt).toISOString());
    }
  }

  for (const publication of publications) {
    const key = publication.source_table + ":" + publication.source_id;
    if (publication.publication_status !== "published" || currentByKey.has(key)) continue;
    const tombstone: NormalizedContent = {
      sourceTable: publication.source_table,
      sourceId: publication.source_id,
      kind: publication.source_table === "blog_posts" ? "article" :
        publication.source_table === "news_announcements" ? "news" : "registration",
      title: "محتوا از وب‌سایت حذف شده است",
      summary: "",
      content: "",
      publicUrl: config.siteUrl,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      isActive: false,
      startsAt: null,
      endsAt: null,
      requestUrl: null,
      buttonLabel: null,
    };
    await enqueue(tombstone, "remove");
  }

  await pinLatestActiveRegistration();
}

async function getPublication(item: NormalizedContent): Promise<PublicationRow | null> {
  const { data, error } = await supabase
    .from("telegram_publications")
    .select("id,source_table,source_id,chat_id,message_id,content_hash,source_updated_at,publication_status,is_pinned,first_published_at")
    .eq("source_table", item.sourceTable)
    .eq("source_id", item.sourceId)
    .eq("chat_id", channelId)
    .maybeSingle();
  if (error) throw new Error("Could not load publication: " + error.message);
  return data as PublicationRow | null;
}

async function getCurrentContent(item: NormalizedContent): Promise<NormalizedContent | null> {
  const items = await loadPublishedContent();
  return items.find((candidate) =>
    candidate.sourceTable === item.sourceTable && candidate.sourceId === item.sourceId
  ) ?? null;
}

async function rescheduleJob(job: QueueRow, item: NormalizedContent, availableAt: string): Promise<void> {
  const { error } = await supabase.from("telegram_publish_queue").update({
    status: "pending",
    payload: item,
    attempts: 0,
    available_at: availableAt,
    locked_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);
  if (error) throw new Error("Could not reschedule queue job " + job.id + ": " + error.message);
}


async function savePublication(item: NormalizedContent, messageId: number, status: PublicationRow["publication_status"], isPinned: boolean): Promise<void> {
  const { error } = await supabase.from("telegram_publications").upsert({
    source_table: item.sourceTable,
    source_id: item.sourceId,
    chat_id: channelId,
    message_id: messageId,
    content_hash: hash(item),
    source_updated_at: item.updatedAt,
    publication_status: status,
    is_pinned: isPinned,
    first_published_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "source_table,source_id,chat_id" });
  if (error) throw new Error("Could not save publication state: " + error.message);
}

async function updatePublication(item: NormalizedContent, patch: Partial<Pick<PublicationRow, "content_hash" | "publication_status" | "is_pinned">>): Promise<void> {
  const { error } = await supabase.from("telegram_publications").update({
    ...patch,
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("source_table", item.sourceTable).eq("source_id", item.sourceId).eq("chat_id", channelId);
  if (error) throw new Error("Could not update publication state: " + error.message);
}

async function pinLatestActiveRegistration(): Promise<void> {
  const [items, result] = await Promise.all([
    loadPublishedContent(),
    supabase
      .from("telegram_publications")
      .select("source_table,source_id,message_id,is_pinned,first_published_at")
      .in("source_table", ["services_announcements", "news_announcements"])
      .eq("chat_id", channelId)
      .eq("publication_status", "published")
      .not("message_id", "is", null),
  ]);
  if (result.error) throw new Error("Could not list registration posts: " + result.error.message);

  const activeItems = items
    .filter((item) => item.kind === "registration" && isRegistrationActive(item))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const rows = (result.data ?? []) as Array<{
    source_table: SourceTable;
    source_id: string;
    message_id: number | null;
    is_pinned: boolean;
  }>;
  const latest = activeItems
    .map((item) => rows.find((row) =>
      row.source_table === item.sourceTable && row.source_id === item.sourceId
    ))
    .find((row) => row?.message_id !== null && row?.message_id !== undefined);

  for (const row of rows) {
    if (!row.message_id) continue;
    const shouldPin = Boolean(latest && latest.source_id === row.source_id && latest.source_table === row.source_table);
    if (shouldPin && !row.is_pinned) {
      await telegram.pinMessage(channelId, row.message_id);
      const { error } = await supabase.from("telegram_publications")
        .update({ is_pinned: true, updated_at: new Date().toISOString() })
        .eq("source_table", row.source_table).eq("source_id", row.source_id).eq("chat_id", channelId);
      if (error) throw new Error("Could not save pinned state: " + error.message);
    } else if (!shouldPin && row.is_pinned) {
      await telegram.unpinMessage(channelId, row.message_id);
      const { error } = await supabase.from("telegram_publications")
        .update({ is_pinned: false, updated_at: new Date().toISOString() })
        .eq("source_table", row.source_table).eq("source_id", row.source_id).eq("chat_id", channelId);
      if (error) throw new Error("Could not save unpinned state: " + error.message);
    }
  }
}

async function publish(item: NormalizedContent): Promise<void> {
  const draft = item.kind === "registration" ? renderRegistrationMessage(item) : renderContentMessage(item);
  const sent = await telegram.sendMessage(channelId, draft);
  await savePublication(item, sent.message_id, "published", false);
  if (item.kind === "registration") {
    try {
      await pinLatestActiveRegistration();
    } catch (error) {
      console.error("[registration-pin]", error);
    }
  }
}

async function edit(item: NormalizedContent, publication: PublicationRow): Promise<void> {
  if (!publication.message_id) throw new Error("Published message id is missing");
  const draft = item.kind === "registration" ? renderRegistrationMessage(item) : renderContentMessage(item);
  await telegram.editMessage(channelId, publication.message_id, draft);
  await updatePublication(item, { content_hash: hash(item), publication_status: "published" });
  if (item.kind === "registration") await pinLatestActiveRegistration();
}

async function expire(item: NormalizedContent, publication: PublicationRow): Promise<void> {
  if (!publication.message_id) throw new Error("Published message id is missing");
  await telegram.editMessage(channelId, publication.message_id, renderRegistrationMessage(item, true));
  if (publication.is_pinned) await telegram.unpinMessage(channelId, publication.message_id);
  await updatePublication(item, { content_hash: hash(item), publication_status: "expired", is_pinned: false });
  await pinLatestActiveRegistration();
}

async function remove(item: NormalizedContent, publication: PublicationRow): Promise<void> {
  if (!publication.message_id) return;
  await telegram.editMessage(channelId, publication.message_id, {
    text: "<b>این محتوا دیگر در وب‌سایت توسن در دسترس نیست.</b>",
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  if (publication.is_pinned) await telegram.unpinMessage(channelId, publication.message_id);
  await updatePublication(item, { content_hash: hash(item), publication_status: "removed", is_pinned: false });
  if (item.kind === "registration") await pinLatestActiveRegistration();
}

async function logJob(job: QueueRow, outcome: string, details: Record<string, unknown> = {}): Promise<void> {
  const { error } = await supabase.from("telegram_publish_logs").insert({
    queue_id: job.id,
    source_table: job.source_table,
    source_id: job.source_id,
    operation: job.operation,
    outcome,
    details,
  });
  if (error) console.error("[publish-log]", error.message);
}

async function finishJob(job: QueueRow, status: "done" | "dead", errorMessage?: string): Promise<void> {
  const { error } = await supabase.from("telegram_publish_queue").update({
    status,
    last_error: errorMessage ?? null,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);
  if (error) console.error("[queue-finish]", error.message);
}

async function retryJob(job: QueueRow, error: unknown): Promise<void> {
  const attempts = job.attempts + 1;
  const exponentialDelay = Math.min(3_600, 5 * (2 ** Math.min(attempts, 10)));
  const telegramDelay = error instanceof TelegramApiError ? error.retryAfterSeconds ?? 0 : 0;
  const delay = Math.max(exponentialDelay, telegramDelay);
  const { error: updateError } = await supabase.from("telegram_publish_queue").update({
    status: attempts >= 8 ? "dead" : "pending",
    attempts,
    available_at: new Date(Date.now() + delay * 1_000).toISOString(),
    last_error: error instanceof Error ? error.message.slice(0, 2_000) : String(error),
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);
  if (updateError) console.error("[queue-retry]", updateError.message);
}

async function processJob(job: QueueRow): Promise<void> {
  const { data: claimed, error: claimError } = await supabase
    .from("telegram_publish_queue")
    .update({ status: "processing", attempts: job.attempts + 1, locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (claimError || !claimed) return;

  try {
    let item = job.payload;
    const publication = await getPublication(item);

    if (job.operation === "publish") {
      if (item.kind === "registration") {
        const current = await getCurrentContent(item);
        if (!current || !current.isActive || !current.requestUrl || !current.endsAt || Date.parse(current.endsAt) <= Date.now()) {
          await finishJob(job, "done");
          await logJob(job, "skipped", { reason: "registration is no longer eligible for publication" });
          return;
        }
        if (current.startsAt && Date.parse(current.startsAt) > Date.now()) {
          await rescheduleJob(job, current, current.startsAt);
          return;
        }
        item = current;
      }
      if (publication?.message_id) await edit(item, publication);
      else await publish(item);
    } else if (job.operation === "edit") {
      const current = await getCurrentContent(item);
      if (!current) {
        if (publication) await remove(item, publication);
      } else if (publication) {
        await edit(current, publication);
      } else {
        await publish(current);
      }
    } else if (job.operation === "expire") {
      if (publication?.publication_status !== "published") {
        // A scheduled expiry can outlive a later reactivation or a prior expiry.
      } else {
        const current = await getCurrentContent(item);
        if (current && isRegistrationActive(current)) {
          await rescheduleJob(job, current, current.endsAt as string);
          return;
        }
        await expire(current ?? item, publication);
      }
    } else if (publication) {
      await remove(item, publication);
    }

    await finishJob(job, "done");
    await logJob(job, "success");
  } catch (error) {
    const uncertainSend = job.operation === "publish" &&
      !(error instanceof TelegramApiError && error.errorCode === 429);
    if (uncertainSend) {
      const message = error instanceof Error ? error.message : String(error);
      await finishJob(job, "dead", "Uncertain send outcome; manual reconciliation required: " + message);
      await logJob(job, "uncertain", { error: message });
      return;
    }

    if (error instanceof TelegramApiError && !error.isRetryable) {
      await finishJob(job, "dead", error.message);
      await logJob(job, "dead", { error: error.message });
      return;
    }

    await retryJob(job, error);
    await logJob(job, "retry", { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function processQueueBatch(): Promise<void> {
  const { data, error } = await supabase
    .from("telegram_publish_queue")
    .select("id,source_table,source_id,operation,payload,attempts")
    .eq("status", "pending")
    .lte("available_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(config.queueBatchSize);
  if (error) throw new Error("Could not read Telegram queue: " + error.message);
  for (const row of (data ?? []) as QueueRow[]) await processJob(row);
}

async function recoverInFlightJobs(): Promise<void> {
  const { data, error } = await supabase
    .from("telegram_publish_queue")
    .select("id,operation")
    .eq("status", "processing");
  if (error) throw new Error("Could not recover interrupted queue jobs: " + error.message);

  for (const job of (data ?? []) as Array<{ id: string; operation: QueueRow["operation"] }>) {
    const isUncertainSend = job.operation === "publish";
    const { error: updateError } = await supabase.from("telegram_publish_queue").update({
      status: isUncertainSend ? "dead" : "pending",
      locked_at: null,
      available_at: new Date().toISOString(),
      last_error: isUncertainSend
        ? "Worker restarted during send; Telegram delivery outcome is uncertain and requires manual reconciliation."
        : "Recovered after worker restart.",
      updated_at: new Date().toISOString(),
    }).eq("id", job.id);
    if (updateError) throw new Error("Could not recover queue job " + job.id + ": " + updateError.message);
  }
}

export async function startWorker(): Promise<void> {
  const me = await telegram.getMe();
  console.info("Telegram publisher connected as @" + (me.username ?? me.id));
  await recoverInFlightJobs();
  await ensureInitialBaseline();

  let sourceRunning = false;
  let queueRunning = false;
  const runGuarded = async (
    label: string,
    action: () => Promise<void>,
    isRunning: () => boolean,
    setRunning: (value: boolean) => void,
  ) => {
    if (isRunning()) return;
    setRunning(true);
    try {
      await action();
    } catch (error) {
      console.error("[" + label + "]", error);
    } finally {
      setRunning(false);
    }
  };

  const runSource = () => runGuarded(
    "source-reconciliation", reconcileSources,
    () => sourceRunning, (value) => { sourceRunning = value; },
  );
  const runQueue = () => runGuarded(
    "publish-queue", processQueueBatch,
    () => queueRunning, (value) => { queueRunning = value; },
  );

  const sourceChannel = supabase
    .channel("tusan-content-publisher")
    .on("postgres_changes", { event: "*", schema: "public", table: "news_announcements" }, () => {
      void runSource();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "blog_posts" }, () => {
      void runSource();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "services_announcements" }, () => {
      void runSource();
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "telegram_publish_queue" }, () => {
      void runQueue();
    });

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 10_000);
    sourceChannel.subscribe((status) => {
      console.info("[supabase-realtime]", status);
      if (status === "SUBSCRIBED") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  await runSource();
  await runQueue();
  setInterval(() => void runSource(), config.sourcePollIntervalMs);
  setInterval(() => void runQueue(), config.queuePollIntervalMs);
}
