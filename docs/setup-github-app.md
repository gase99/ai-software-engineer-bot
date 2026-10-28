# راهنمای اتصال به گیت‌هاب

دو راه دارید؛ **GitHub App توصیه می‌شود** (کوتاه‌عمر و محدود به مخزن‌های نصب‌شده).

## گزینهٔ ۱ — GitHub App (توصیه)

### ساخت

1. `Settings → Developer settings → GitHub Apps → New GitHub App`
2. نام: `AI Software Engineer Bot`
3. `Homepage URL`: آدرس مخزن ربات
4. **Webhook: غیرفعال** (نیازی نداریم)
5. مجوزهای مخزن (کمینه):
   - `Contents: Read & write` (ساخت شاخه و کامیت)
   - `Pull requests: Read & write` (ساخت PR)
   - `Actions: Read & write` (dispatch و خواندن نتیجه)
   - `Metadata: Read-only` (اجباری)
6. `Where can this GitHub App be installed?` → `Only on this account`
7. ساخت برنامه؛ سپس `App ID` را یادداشت کنید.
8. `Generate a private key` → فایل `.pem` دانلود می‌شود.

### نصب روی مخزن

`Install App` → مخزن هدف را انتخاب کنید. سپس در صفحهٔ نصب، آدرس را نگاه کنید:
`https://github.com/settings/installations/<INSTALLATION_ID>` → این عدد را یادداشت کنید.

### تنظیم در ربات

```bash
npx wrangler secret put GITHUB_APP_ID           # مثلاً 123456
npx wrangler secret put GITHUB_INSTALLATION_ID  # مثلاً 98765432
npx wrangler secret put GITHUB_APP_PRIVATE_KEY  # محتوای کامل فایل .pem
```

برای وارد کردن کلید چندخطی در ترمینال:

```bash
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < ./ai-bot.private-key.pem
```

ربات با الگوریتم RS256 یک JWT امضا می‌کند (`src/github/appJwt.ts`، بدون وابستگی
خارجی، با `crypto.subtle`) و آن را با یک توکن نصب (حداکثر یک ساعت) عوض می‌کند.

### بررسی

```
/github
```

باید «نوع اتصال: GitHub App» و وضعیت مخازن را نشان دهد.

## گزینهٔ ۲ — Personal Access Token (ساده‌تر، وسیع‌تر)

1. `Settings → Developer settings → Personal access tokens → Fine-grained tokens`
2. `Resource owner`: حساب خودتان؛ `Repository access`: فقط مخزن هدف
3. مجوزها: `Contents: Read and write`، `Pull requests: Read and write`،
   `Actions: Read and write`، `Metadata: Read-only`
4. توکن را تولید کنید و:

```bash
npx wrangler secret put GITHUB_TOKEN
```

> PAT مانند رمز عبور است. اگر نشت کرد، همان لحظه آن را `Revoke` کنید.

## آماده‌سازی مخزن هدف

برای اجرای تست، فایل `.github/workflows/ai-exec.yml` را در مخزن هدف کپی کنید
(همین فایل در این مخزن هست). سپس:

- `Settings → Secrets and variables → Actions → Secrets`: `ACTIONS_CALLBACK_TOKEN`
- `Settings → Secrets and variables → Actions → Variables`: `BOT_CALLBACK_URL`
  (مثلاً `https://ai-software-engineer-bot.<account>.workers.dev/actions/callback`)

اگر این workflow در مخزن نباشد، ربات باز هم شاخه و PR می‌سازد اما **صادقانه
می‌گوید تستی اجرا نشد** (تست: `test/executor.test.ts`).

## نکتهٔ محدودیت دقیقه‌ها

مخزن عمومی: نامحدود (با Fair Use). مخزن خصوصی: ۲۰۰۰ دقیقه در ماه. ربات هر اجرا را
از روی زمان واقعی run اندازه می‌گیرد و نزدیک سقف هشدار می‌دهد یا متوقف می‌شود
(`src/github/quota.ts`).
