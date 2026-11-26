import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, renderRegistrationMessage, stripHtml } from "../src/domain/format.ts";

test("escapeHtml escapes Telegram-sensitive characters", () => {
  assert.equal(escapeHtml('<tag a="b">&'), "&lt;tag a=&quot;b&quot;&gt;&amp;");
});

test("stripHtml removes markup and normalizes whitespace", () => {
  assert.equal(stripHtml("<p>سلام <b>توسن</b></p>"), "سلام توسن");
});

test("active registration includes an inline URL button", () => {
  const draft = renderRegistrationMessage({
    sourceTable: "services_announcements",
    sourceId: "00000000-0000-4000-8000-000000000001",
    kind: "registration",
    title: "ثبت‌نام آزمون",
    summary: "ثبت‌نام آغاز شد",
    content: "",
    publicUrl: "https://www.tusancn.ir",
    updatedAt: "2026-11-26T10:00:00Z",
    createdAt: "2026-11-25T10:00:00Z",
    isActive: true,
    startsAt: null,
    endsAt: "2026-12-01T20:30:00Z",
    requestUrl: "https://www.tusancn.ir/services/example",
    buttonLabel: "ثبت درخواست",
  });
  assert.equal(draft.reply_markup?.inline_keyboard[0][0].url, "https://www.tusancn.ir/services/example");
  assert.match(draft.text, /ثبت‌نام فعال/);
});

test("expired registration has no action button", () => {
  const draft = renderRegistrationMessage({
    sourceTable: "services_announcements",
    sourceId: "00000000-0000-4000-8000-000000000001",
    kind: "registration",
    title: "ثبت‌نام آزمون",
    summary: "",
    content: "",
    publicUrl: "https://www.tusancn.ir",
    updatedAt: "2026-11-26T10:00:00Z",
    createdAt: "2026-11-25T10:00:00Z",
    isActive: false,
    startsAt: null,
    endsAt: "2026-11-01T20:30:00Z",
    requestUrl: "https://www.tusancn.ir/services/example",
    buttonLabel: "ثبت درخواست",
  }, true);
  assert.equal(draft.reply_markup, undefined);
  assert.match(draft.text, /منقضی شده/);
});
