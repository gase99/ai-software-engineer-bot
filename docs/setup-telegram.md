# راهنمای ساخت ربات تلگرام

## ۱. گرفتن توکن از BotFather

1. در تلگرام `@BotFather` را باز کنید.
2. دستور `/newbot` را بفرستید.
3. نام نمایشی (مثلاً `AI Software Engineer`) و سپس نام کاربری منحصربه‌فرد
   (حتماً با `bot` تمام شود، مثلاً `my_ai_engineer_bot`) را وارد کنید.
4. توکن را کپی کنید؛ شبیه:
   `123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

> این توکن را فقط در Secrets پلتفرم قرار دهید. در هیچ فایلِ کامیت‌شده‌ای ننویسید.

## ۲. پیدا کردن شناسهٔ عددی خودتان

به `@userinfobot` پیام بدهید؛ عدد مقابل `Id` همان `OWNER_TELEGRAM_ID` است
(مثلاً `1001`). اگر می‌خواهید چند نفر دسترسی داشته باشند، شناسه‌ها را با کاما جدا کنید.

## ۳. تنظیم فرمان‌ها و منو

ربات هنگام بالا آمدن فرمان‌ها را ثبت می‌کند. برای ثبت دستی:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setMyCommands" \
  -H 'content-type: application/json' \
  -d '{"commands":[{"command":"new","description":"درخواست جدید"},{"command":"status","description":"وضعیت"}]}'
```

یا از endpoint مدیریتی خود ربات:

```bash
curl -X POST https://<worker>.workers.dev/admin/set-webhook \
  -H "x-admin-token: <ACTIONS_CALLBACK_TOKEN>" \
  -H 'content-type: application/json' \
  -d '{"url":"https://<worker>.workers.dev"}'
```

## ۴. اتصال وب‌هوک

در حالت A از polling استفاده نمی‌شود. ربات دو روش دارد:

- خودکار: فراخوانی `/admin/set-webhook` (بالا).
- دستی:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://<worker>.workers.dev/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>"}'
```

بررسی وضعیت:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

فیلد `last_error_message` باید خالی باشد و `pending_update_count` باید کم باشد.

## ۵. تست اولیه

1. در تلگرام `/start` را بزنید → باید پاسخ فارسی و منو بیاید.
2. `/project owner/repo` را بزنید → باید مخزن را بخواند.
3. `/test_api` را بزنید → وضعیت کلید هوش مصنوعی را نشان می‌دهد.
4. `/new یک ویژگی ساده اضافه کن` → گزارش تحلیل + ۴ دکمه.

اگر پاسخی نیامد: [`docs/troubleshooting.md`](troubleshooting.md) را ببینید.
