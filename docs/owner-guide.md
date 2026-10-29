# راهنمای مالک — گام‌های ۳ تا ۸

این راهنما برای مالک غیرفنی است. فرض می‌کنیم مخزن و حساب‌های لازم در گام‌های ۱ و ۲ آماده شده‌اند و نسخهٔ مورد تأیید تو در دسترس است.

> **هشدار صادقانه:** Telegram، Gemini، Cloudflare و اجرای واقعی `ai-exec.yml` در محیط توسعه **آزمایش نشده‌اند — مالک باید آن‌ها را انجام دهد**. `scripts/setup-owner.sh` هم اجرای کامل نشده و فقط سینتکس آن با `bash -n` تأیید شده است.
>
> هیچ Token، API Key یا Private Key را در چت، `wrangler.toml`, Git، اسکرین‌شات یا آرگومان دستور ننویس. نام‌های `[YOUR_X]` را فقط با مقدار غیرمحرمانه جایگزین کن؛ Secretها باید در Prompt پنهان یا Secrets پلتفرم وارد شوند.

## مسیر کوتاه پیشنهادی

اگر با ترمینال راحت نیستی، همین مسیر تعاملی را انتخاب کن:

```bash
cd [YOUR_BOT_REPOSITORY]
bash scripts/setup-owner.sh
```

خروجی مورد انتظار: پیش از هر مرحله سؤال `y/N` می‌آید. Secretها هنگام تایپ دیده نمی‌شوند. در خطا، اسکریپت با این الگو راهنما می‌کند:

```text
این مرحله را دستی انجام بده: [دستور یا اقدام دقیق]
```

اسکریپت برای ادامهٔ امن متوقف می‌شود؛ بعد از انجام اقدام دستی، آن را دوباره اجرا کن و مرحله‌های قبلی را با احتیاط بررسی کن. **اجرای کامل اسکریپت توسط عامل توسعه انجام نشده است.**

اگر می‌خواهی همه‌چیز را دستی انجام دهی، گام‌های زیر را دنبال کن.

---

## گام ۳ — آماده‌سازی Node، Cloudflare و D1

### ۳.۱ بررسی نسخه و نصب وابستگی‌ها

```bash
cd [YOUR_BOT_REPOSITORY]
node --version
npm ci --no-audit --no-fund
npx wrangler --version
```

خروجی مورد انتظار:

- Node: `v22.5.0` یا جدیدتر؛ Node 20 برای تست‌های این پروژه کافی نیست.
- Wrangler: شمارهٔ نسخه، بدون خطای `command not found`.
- npm: پایان بدون `npm ERR!`.

### ۳.۲ ورود به Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

خروجی مورد انتظار: حساب Cloudflare خودت در `whoami` دیده شود. لینک ورود یا توکن حساب را برای کسی نفرست.

### ۳.۳ ساخت D1 و اتصال آن

```bash
npx wrangler d1 create ai-eng-bot-db
```

در خروجی، مقدار `database_id` را پیدا کن و در `wrangler.toml` جای این مقدار قرار بده:

```toml
database_id = "[YOUR_D1_DATABASE_ID]"
```

سپس Migration را اجرا کن:

```bash
npm run db:migrate
```

خروجی مورد انتظار: Migrationها با وضعیت موفق اعمال شوند و خطای `no such table` یا `database not found` نباشد.

**چک این گام**

- [ ] `npx wrangler whoami` حساب درست را نشان می‌دهد.
- [ ] `database_id` واقعی در `wrangler.toml` است، نه `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
- [ ] Migration روی D1 واقعی موفق شده است.

---

## گام ۴ — ثبت Secrets بدون نمایش مقدار

### ۴.۱ قبل از شروع

یک Password Manager باز کن. برای `APPROVAL_SECRET`, `TELEGRAM_WEBHOOK_SECRET` و `ACTIONS_CALLBACK_TOKEN` رشتهٔ تصادفی جدا بساز و امن نگه دار. اسکریپت تعاملی دو مورد اول را بدون نمایش تولید می‌کند؛ در مسیر دستی می‌توانی با دستور زیر رشته بسازی و آن را فقط در Password Manager ذخیره کنی:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

خروجی این دستور Secret است: آن را Commit یا برای عامل/چت نفرست.

### ۴.۲ نام Secrets لازم در Cloudflare

دستورها عمداً **بدون مقدار** هستند؛ مقدار را فقط در Prompt بزن:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put OWNER_TELEGRAM_ID
npx wrangler secret put APPROVAL_SECRET
npx wrangler secret put ACTIONS_CALLBACK_TOKEN
npx wrangler secret put GEMINI_API_KEY
```

برای GitHub App توصیه‌شده:

```bash
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_INSTALLATION_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < [YOUR_PRIVATE_KEY_FILE].pem
```

یا فقط یکی از این دو مسیر، نه هر دو:

```bash
# مسیر PAT؛ اگر App کامل تنظیم شده، این مورد لازم نیست
npx wrangler secret put GITHUB_TOKEN
```

خروجی مورد انتظار: برای هر نام، پیام موفقیت Wrangler بدون نمایش مقدار Secret.

| محل | نام‌های لازم | توضیح بدون مقدار |
|---|---|---|
| Cloudflare | `TELEGRAM_BOT_TOKEN` | از BotFather |
| Cloudflare | `TELEGRAM_WEBHOOK_SECRET` | رشتهٔ تصادفی جدا؛ برای Webhook لازم و اجباری |
| Cloudflare | `OWNER_TELEGRAM_ID` | شناسهٔ عددی مالک |
| Cloudflare | `APPROVAL_SECRET` | رشتهٔ تصادفی جدا برای امضای Approval |
| Cloudflare | `ACTIONS_CALLBACK_TOKEN` | رشتهٔ تصادفی جدا؛ بعداً در GitHub هم ثبت می‌شود |
| Cloudflare | `GEMINI_API_KEY` | کلید Gemini؛ Providerهای دیگر اختیاری‌اند |
| Cloudflare، مسیر App | `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | هر سه با هم لازم‌اند |
| Cloudflare، مسیر PAT | `GITHUB_TOKEN` | Fine-grained و فقط مخزن هدف |
| GitHub Actions Secret در مخزن هدف | `ACTIONS_CALLBACK_TOKEN` | همان مقدار Cloudflare؛ مقدار در این سند نوشته نمی‌شود |
| GitHub Actions Variable در مخزن هدف | `BOT_CALLBACK_URL` | `[YOUR_WORKER_URL]/actions/callback`؛ Secret نیست |

**چک این گام**

- [ ] هیچ مقدار Secret در دستورهای بالا بعد از نام Secret نوشته نشده است.
- [ ] هیچ `.pem`, `.env` یا `.dev.vars` در Git قرار ندارد.
- [ ] برای GitHub یا هر سه مقدار App آماده است، یا PAT محدود به مخزن هدف.

---

## گام ۵ — آماده‌سازی مخزن هدف و سقفهای هزینه

### ۵.۱ Workflow اجرای تست

فایل `.github/workflows/ai-exec.yml` همین نسخه باید در مخزن هدف وجود داشته باشد. آن را از مسیر معتبر پروژه کپی کن؛ از روی متن ناشناس یا پیام‌های مدل کپی نکن.

در مخزن هدف:

1. `Settings → Secrets and variables → Actions → Secrets` را باز کن و Secret با نام `ACTIONS_CALLBACK_TOKEN` بساز.
2. در بخش `Variables`, Variable با نام `BOT_CALLBACK_URL` بساز و مقدار غیرمحرمانهٔ `[YOUR_WORKER_URL]/actions/callback` را قرار بده.
3. مطمئن شو Job `report` هیچ `actions/checkout` ندارد و Secret فقط در همان Job است.

> اگر Workflow وجود نداشته باشد، ربات ممکن است Branch/PR بسازد اما باید صریحاً بگوید «تستی اجرا نشد». چنین پیامی را موفقیت تست حساب نکن.

### ۵.۲ سقفهای محلی پیش‌فرض

در `wrangler.toml` این دو مقدار را ببین:

```toml
AI_DAILY_REQUEST_LIMIT = "50"
ACTIONS_MONTHLY_MINUTE_LIMIT = "100"
```

- ۵۰ درخواست AI برای **همهٔ Providerها و `/test_api`** مشترک است.
- ۱۰۰ دقیقه Actions یک بودجهٔ محلی و محافظه‌کارانه است؛ صورتحساب رسمی GitHub نیست.
- این اعداد مصرف خارج از ربات را نمی‌بینند و هزینهٔ صفر را تضمین نمی‌کنند.

**چک این گام**

- [ ] Workflow همان نسخهٔ بررسی‌شده است.
- [ ] نام Secret و Variable درست است و مقدار Secret در Git نیست.
- [ ] سقفهای ۵۰ و ۱۰۰ بررسی شده‌اند؛ تغییر آن‌ها فقط با تصمیم آگاهانهٔ تو.

---

## گام ۶ — اعتبارسنجی و Deploy

ابتدا تست محلی:

```bash
npm run typecheck
npm test
npm audit --audit-level=high
```

خروجی مورد انتظار در زمان نوشتن این راهنما: Typecheck موفق، **۹۸/۹۸ تست** و `found 0 vulnerabilities`. اگر در آینده تعداد تست‌ها بیشتر شد، مهم این است که شکست صفر باشد؛ تعداد را حدس نزن.

سپس Deploy واقعی—فقط با تأیید خودت:

```bash
npm run deploy
```

خروجی مورد انتظار: آدرس HTTPS Worker مانند الگوی زیر، بدون خطای D1 یا Secret:

```text
[YOUR_WORKER_URL]
```

بررسی Health:

```bash
curl --fail [YOUR_WORKER_URL]/health
```

خروجی مورد انتظار: JSON شامل `"ok":true` و نام سرویس.

**چک این گام**

- [ ] Typecheck و همهٔ تست‌ها بدون شکست‌اند.
- [ ] Deploy را خودت تأیید و اجرا کرده‌ای.
- [ ] Health واقعاً `ok:true` می‌دهد؛ فقط دیدن پیام Deploy کافی نیست.

---

## گام ۷ — ثبت Webhook و بررسی `getWebhookInfo`

### ۷.۱ مسیر دستی امن

توکن و Webhook Secret را با Prompt پنهان بخوان؛ با این کار مقدار وارد History دستور نمی‌شود:

```bash
read -rsp 'Telegram Bot Token: ' TELEGRAM_BOT_TOKEN; echo
read -rsp 'Telegram Webhook Secret: ' TELEGRAM_WEBHOOK_SECRET; echo
export TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
WORKER_URL='[YOUR_WORKER_URL]'
```

ثبت Webhook با Node؛ مقدار Secret در آرگومان فرآیند قرار نمی‌گیرد:

```bash
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
TELEGRAM_WEBHOOK_SECRET="$TELEGRAM_WEBHOOK_SECRET" \
WORKER_URL="$WORKER_URL" \
node --input-type=module - <<'NODE'
const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: `${process.env.WORKER_URL}/telegram/webhook`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    drop_pending_updates: false,
  }),
});
const body = await response.json();
console.log(JSON.stringify({ httpStatus: response.status, ok: body.ok, description: body.description }, null, 2));
if (!response.ok || !body.ok) process.exit(1);
NODE
```

خروجی مورد انتظار: `"ok": true` و عدم وجود `Unauthorized`.

### ۷.۲ بررسی وضعیت Webhook

```bash
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" node --input-type=module - <<'NODE'
const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, { method: 'POST' });
const body = await response.json();
const result = body.result ?? {};
console.log(JSON.stringify({
  ok: body.ok,
  url: result.url,
  pending_update_count: result.pending_update_count,
  last_error_message: result.last_error_message,
  last_error_date: result.last_error_date,
}, null, 2));
if (!response.ok || !body.ok) process.exit(1);
NODE
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
```

خروجی مورد انتظار:

- `ok:true`
- `url` دقیقاً `[YOUR_WORKER_URL]/telegram/webhook`
- `last_error_message` خالی یا وجود نداشته باشد
- `pending_update_count` کم باشد و پیوسته زیاد نشود

**چک این گام**

- [ ] Webhook ثبت شده و Secret خالی نیست.
- [ ] مسیر `/telegram/webhook` دقیق است.
- [ ] هیچ Token در خروجی نمایش داده نشده است.

---

## گام ۸ — تست واقعی توسط مالک

این گام جای تست‌های محلی را نمی‌گیرد؛ آن‌ها را تکمیل می‌کند. چک‌لیست کامل در [`manual-test-checklist.md`](manual-test-checklist.md) است.

1. در Telegram `/start` بزن → پاسخ فارسی و منو باید بیاید.
2. `/project [YOUR_GITHUB_OWNER]/[YOUR_TARGET_REPO]` را بزن → مخزن و شاخهٔ درست باید خوانده شود.
3. `/test_api` را بزن → وضعیت Gemini را ببین؛ هیچ کلیدی نباید نمایش داده شود.
4. `/new یک تغییر خیلی کوچک و امن انجام بده` را بزن → ابتدا پیام «در صف تحلیل» می‌آید؛ Cron ممکن است تا چند دقیقه طول بکشد.
5. گزارش را بخوان و **لغو** را بزن → پیام «لغو شد» باید بیاید و هیچ Branch/PR ساخته نشود. دکمهٔ تأیید همان پیام قدیمی هم نباید بعد از لغو کار کند.
6. برای درخواست تازه، **اصلاح طرح** را بزن → دکمهٔ تأیید نسخهٔ قبلی باید نامعتبر شود.
7. در یک درخواست تازه و فقط بعد از خواندن Scope، **تأیید و شروع** را بزن → فقط Branch کاری و PR باز شود؛ `main` و Merge دست‌نخورده بماند.
8. در مخزن هدف، Run واقعی `AI Execution Sandbox` را ببین. یک تست عمداً Fail کن و مطمئن شو Run و پیام ربات Failure را صادقانه نشان می‌دهند.
9. `/usage`, `/tasks` و داشبوردهای Cloudflare/GitHub/Gemini را بررسی کن.

> هر مورد بالا که انجام نشده، وضعش «آزمایش نشد» است؛ «انجام شد» فقط وقتی خودت خروجی واقعی را دیده‌ای.

---

## جدول خطا → معنی → راه‌حل

| خطا/نشانه | معنی محتمل | راه‌حل امن |
|---|---|---|
| `Node 22.5+ لازم است` یا خطای `node:sqlite` | Node قدیمی است | Node 22.5+ نصب کن و `node --version` را ببین |
| `wrangler: command not found` | وابستگی نصب نشده | `npm ci --no-audit --no-fund` سپس `npx wrangler --version` |
| `Authentication error` در Wrangler | Login نداری یا حساب اشتباه است | `npx wrangler login && npx wrangler whoami` |
| `database already exists` | D1 از قبل ساخته شده | `npx wrangler d1 list`; ID موجود را بررسی و در `wrangler.toml` قرار بده |
| `no such table` | Migration اعمال نشده | `npm run db:migrate` و بررسی موفقیت خروجی |
| `REPLACE_WITH_YOUR_D1_DATABASE_ID` | Binding هنوز Placeholder است | `database_id` واقعی را در `wrangler.toml` بنویس |
| `401` روی Webhook یا `webhook.bad_secret` | Secret وب‌هوک خالی/متفاوت است | همان Secret تصادفی را در Cloudflare و `setWebhook` ثبت کن؛ مقدار را نمایش نده |
| `شما اجازه استفاده ... ندارید` | شناسهٔ فرستنده مالک نیست | `OWNER_TELEGRAM_ID` را با شناسهٔ عددی درست اصلاح کن |
| `invalid_key` یا ۴۰۱ در `/test_api` | کلید اشتباه/باطل است | کلید را Revoke و جدید بساز؛ فقط با `wrangler secret put` ثبت کن |
| ۴۲۹ یا `rate_limited` | سهمیهٔ Provider یا ربات پر شده | `/usage` و داشبورد Provider؛ کلید پولی را خودکار جایگزین نکن |
| `سقف درخواست AI روزانه` | ۵۰ تماس محلی کامل شده | تا روز بعد صبر کن یا آگاهانه و با بررسی هزینه سقف را تغییر بده |
| `سقف ۱۰۰ دقیقه Actions` | بودجهٔ محلی/رزروها پر شده | `/usage` و Runهای GitHub را بررسی کن؛ شمارنده را بدون شاهد صفر نکن |
| `workflow پیدا نشد` / ۴۰۴ در Dispatch | `ai-exec.yml` یا دسترسی Actions نیست | Workflow را در مخزن هدف و مجوز Actions را بررسی کن |
| `تستی اجرا نشد` | Dispatch یا Run موفق نبوده | Actions را باز کن؛ این پیام را «تست موفق» تفسیر نکن |
| Callback نامعتبر/منقضی | طرح عوض، دکمه مصرف یا زمان گذشته است | `/resume` یا درخواست تازه؛ دکمهٔ قدیمی را دست‌کاری نکن |
| بعد از لغو پیام اجرا دیده می‌شود | جریان حسابرسی باید بررسی شود | فوراً تأیید جدید نکن؛ Branch/PR/Actions و `audit_log` را بررسی کن |
| Deploy موفق ولی `/start` پاسخ ندارد | Webhook/Cron/Secret مشکل دارد | `/health`, `getWebhookInfo`, `npx wrangler tail` را بررسی کن |
| `last_error_message` در Webhook | Telegram به Worker نمی‌رسد یا Worker خطا می‌دهد | URL، HTTPS، Secret و لاگ Worker را تطبیق بده |

## چک‌لیست نهایی مالک

- [ ] سینتکس اسکریپت تأیید شده، اما می‌دانم اجرای کامل آن آزمایش نشده است.
- [ ] همهٔ Secretها فقط در Prompt/Secrets وارد شده‌اند.
- [ ] D1 و Migration واقعی موفق‌اند.
- [ ] Deploy و Health واقعی بررسی شده‌اند.
- [ ] `getWebhookInfo` سالم است.
- [ ] `/start`, `/project`, `/test_api` واقعی بررسی شده‌اند.
- [ ] لغو، اصلاح و تأیید هر سه جداگانه بررسی شده‌اند.
- [ ] بعد از لغو هیچ اجرا/PR رخ نداده و Approval مصرف شده است.
- [ ] Run موفق و ناموفق `ai-exec.yml` واقعی دیده شده است.
- [ ] سقفهای ۵۰ و ۱۰۰ و داشبوردهای هزینه بررسی شده‌اند.
- [ ] هیچ PR بدون تأیید جداگانهٔ من Merge نشده است.
