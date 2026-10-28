# استقرار جایگزین روی Hugging Face Spaces (حالت B)

اگر به هر دلیلی Cloudflare در دسترس نیست، همین کدبیس را می‌توان روی یک Space اجرا کرد.
در این حالت «همیشه‌روشن» بودن بستگی به پلن دارد؛ بنابراین بخشی از کارها از طریق کرون
یا GitHub Actions انجام می‌شود.

## ۱. ساخت Space

1. <https://huggingface.co/new-space>
2. نام: `ai-software-engineer-bot`، نوع: **Docker** (یا Node)، پلن: **Free**
3. در `Settings → Variables and secrets` متغیرها را اضافه کنید:
   - Secrets: `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `APPROVAL_SECRET`,
     `TELEGRAM_WEBHOOK_SECRET`, کلید(های) AI, اعتبارنامهٔ گیت‌هاب,
     `ACTIONS_CALLBACK_TOKEN`
   - Variables: `BOT_PUBLIC_URL`, `COMMAND_ALLOWLIST`,
     `AI_DAILY_TOKEN_LIMIT`, `ACTIONS_MONTHLY_MINUTE_LIMIT`

## ۲. انتخاب نحوهٔ دریافت پیام

- **Webhook (توصیه)**: سرور HTTP روی پورت `7860` گوش می‌دهد و آدرس Space
  (`https://<user>-<space>.hf.space`) مستقیماً قابل استفاده است.
- **Polling**: اگر Space می‌خوابد، یک job زمان‌بندی‌شده (GitHub Actions cron)
  هر ۵ دقیقه `getUpdates` را صدا می‌زند.

## ۳. پایگاه‌داده

در این حالت به‌جای D1 از SQLite محلی روی دیسک Space استفاده کنید — نیازی به تغییر
کد نیست چون لایهٔ `Sql` یکسان است:

```ts
import { sqliteSql } from './src/db/sql.js';
const sql = await sqliteSql('/data/bot.sqlite');
const bot = await Bot.create(env, sql);
```

دیسک Space بعد از راه‌اندازی مجدد پاک می‌شود؛ بنابراین پشتیبان‌گیری دوره‌ای را
به یک مخزن خصوصی یا R2 اضافه کنید (یک workflow cron در Actions).

## ۴. وب‌هوک روی آدرس Space

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://<user>-<space>.hf.space/telegram/webhook","secret_token":"..."}'
```

اگر از Node مستقیم استفاده می‌کنید، همان `fetch` handler در `src/index.ts` را با یک
سرور HTTP سبک (مثلاً `node:http`) wrap کنید؛ هیچ تغییری در منطق لازم نیست.

## ۵. محدودیت‌ها

- پلن رایگان ممکن است Space را پس از بی‌حرکتی بخواباند → اولین پیام کند می‌شود.
- اجرای کد و تست همچنان باید به GitHub Actions برود (دیسک و CPU محدود است).
- برای «همیشه بیدار» بودن، می‌توانید یک cron در Actions بسازید که هر ۱۰ دقیقه
  `/health` را صدا بزند.
