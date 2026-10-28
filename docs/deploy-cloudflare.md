# استقرار روی Cloudflare Workers (حالت A — پیشنهادی)

## پیش‌نیازها

- حساب رایگان Cloudflare
- Node 20+ و npm
- توکن تلگرام، یک کلید رایگان AI، و یک اعتبارنامهٔ گیت‌هاب

## ۱. نصب و ورود

```bash
npm install
npx wrangler login
```

## ۲. ساخت پایگاه‌داده D1

```bash
npx wrangler d1 create ai-eng-bot-db
```

خروجی شامل یک `database_id` است؛ آن را در `wrangler.toml` جایگزین
`REPLACE_WITH_YOUR_D1_DATABASE_ID` کنید.

اعمال مایگریشن:

```bash
npm run db:migrate          # روی D1 واقعی
npm run db:migrate:local    # روی Miniflare برای توسعه
```

اسکیمای رسمی در `migrations/0001_init.sql` است و با `src/db/schema.ts` یکی است
(تست `test/schema.test.ts` انحراف را شکست می‌دهد).

## ۳. تنظیم اسرار

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OWNER_TELEGRAM_ID          # فقط عدد، چندتا را با کاما جدا کنید
npx wrangler secret put APPROVAL_SECRET            # رشتهٔ تصادفی بلند
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET    # رشتهٔ تصادفی
npx wrangler secret put GEMINI_API_KEY             # و/یا GROQ_API_KEY و ...
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < ./ai-bot.private-key.pem
npx wrangler secret put GITHUB_INSTALLATION_ID
npx wrangler secret put ACTIONS_CALLBACK_TOKEN     # برای کالبک Actions و /admin
```

تولید رشته‌های تصادفی:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## ۴. متغیرهای غیرمحرمانه

در `wrangler.toml` بخش `[vars]`:

```toml
COMMAND_ALLOWLIST = "npm test,npm run test,pytest,npm run lint"
AI_DAILY_TOKEN_LIMIT = "500000"
ACTIONS_MONTHLY_MINUTE_LIMIT = "2000"
MAX_UPLOAD_BYTES = "200000"
```

## ۵. استقرار

```bash
npm run typecheck
npm test
npm run deploy
```

آدرس خروجی معمولاً:
`https://ai-software-engineer-bot.<your-subdomain>.workers.dev`

## ۶. ثبت وب‌هوک

```bash
curl -X POST https://<worker>.workers.dev/admin/set-webhook \
  -H "x-admin-token: <ACTIONS_CALLBACK_TOKEN>" \
  -H 'content-type: application/json' \
  -d '{"url":"https://<worker>.workers.dev"}'
```

بررسی: `curl https://<worker>.workers.dev/health` → `{"ok":true,...}`

## ۷. کرون و صف

`wrangler.toml` شامل `crons = ["*/5 * * * *"]` است؛ هر ۵ دقیقه صف وظایف تخلیه
می‌شود. برای دیدن لاگ زنده:

```bash
npx wrangler tail
```

## ۸. توسعهٔ محلی

```bash
cp .dev.vars.example .dev.vars   # مقادیر را پُر کنید
npm run dev                      # Miniflare روی http://localhost:8787
```

برای تست وب‌هوک در محیط لوکال از یک تونل (مثلاً `cloudflared`) استفاده کنید و
وب‌هوک را به آن آدرس ست کنید.

## ۹. پشتیبان‌گیری

```bash
npx wrangler d1 export ai-eng-bot-db --remote --output backup-$(date +%F).sql
```

فایل را در R2 یا یک مخزن خصوصی نگه دارید. بازیابی:

```bash
npx wrangler d1 execute ai-eng-bot-db --remote --file backup.sql
```

## ۱۰. هزینه

همه‌چیز روی پلن رایگان است: Workers (درخواست + محدودیت CPU هر invocation)،
D1 (سهمیهٔ روزانه)، Cron Triggers، و GitHub Actions برای اجرای کد. هیچ کارت
اعتباری لازم نیست. اگر از پلن رایگان فراتر رفتید، ربات به‌جای ایجاد هزینه صف می‌کند.
