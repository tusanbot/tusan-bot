# Tosan Telegram Publisher

ناشر خودکار محتوای سایت توسن در کانال تلگرام، با دریافت رویدادهای درج رکورد از Supabase.

## منابع

- `public.services_announcements`: رکورد INSERT با `type = registration` و `is_active = true`
- `public.news_announcements`: رکورد INSERT با `status = published`
- `public.blog_posts`: رکورد INSERT با `status = published`

خبر و مقاله با دکمه «ادامه مطلب» منتشر می‌شوند. ثبت‌نام فعال با دکمه «مشاهده و درخواست» ارسال می‌شود. رکوردهای بازبینی/پیش‌نویس نادیده گرفته می‌شوند؛ محتوای قبلی به‌صورت انبوه منتشر نمی‌شود.

## راه‌اندازی

1. برای دیتابیس D1 موجود، `database_id` و `database_name` را در `wrangler.toml` با مقادیر واقعی جایگزین کنید؛ Binding باید دقیقاً `DB` باشد. نام Worker در فایل `tusan-bot` است.
2. `npx wrangler d1 migrations apply tusan-bot --remote` را اجرا کنید.
3. Secrets را تنظیم کنید: `BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `SUPABASE_WEBHOOK_SECRET`. نام `BOT_TOKEN` همان متغیری است که Worker فعلی شما دارد.
4. Worker را deploy کنید.
5. در Supabase برای هر سه جدول یک Database Webhook از نوع INSERT بسازید و به `/webhooks/supabase` بفرستید؛ هدر `Authorization: Bearer <secret>` را تنظیم کنید.
6. بات باید در کانال ادمین و مجاز به ارسال پیام باشد.

## نکات

- این پروژه در Supabase هیچ تغییری نمی‌دهد؛ migration فقط جدول deduplication در D1 می‌سازد.
- برای جلوگیری از ارسال دوباره، کلید `table:id` در D1 ثبت می‌شود.
- تا زمان تأیید مسیر دقیق فرم درخواست، دکمه ثبت‌نام به صفحه خدمات سایت می‌رود.
- برای فعال‌شدن واقعی، D1، secrets، webhookها و دسترسی کانال باید در محیط استقرار تنظیم شوند.
