# ربات مهندس نرم‌افزار هوش مصنوعی (نسخهٔ بدون هزینه)

یک ربات تلگرام واقعی که درخواست‌های فارسی سادهٔ شما را می‌فهمد، مخزن گیت‌هاب را تحلیل
می‌کند، **طرح اجرا به فارسی** می‌دهد، و **تنها پس از تأیید صریح شما** شاخه می‌سازد،
کد می‌نویسد، تست را در GitHub Actions اجرا می‌کند و Pull Request باز می‌کند.

حالت استقرار انتخاب‌شده: **حالت A — Serverless** (Cloudflare Workers + D1 + Webhook،
اجرای کد و تست در GitHub Actions). هیچ سرویس پولی به‌عنوان وابستگی اجباری وجود ندارد.

---

## ۱. وضعیت واقعی پروژه (گزارش صادقانه)

| بخش | وضعیت | نوع آزمایش |
|---|---|---|
| اسکلت ربات، منوی فارسی، ۱۹ فرمان | ✅ کامل | تست‌شده در این سندباکس با شبیه‌ساز تلگرام |
| احراز هویت مالک (سمت سرور) + محدودیت نرخ | ✅ کامل | تست‌شده (کاربر غیرمجاز، کالبک جعلی، انفجار پیام) |
| دیتابیس SQLite-سازگار (۱۵ جدول) روی D1/SQLite | ✅ کامل | تست‌شده (ماندگاری پس از restart) |
| مدیریت چند ارائه‌دهنده AI (Gemini/Groq/OpenRouter/DeepSeek/OpenAI/Anthropic) | ✅ کامل | تست‌شده با شبیه‌ساز HTTP |
| سقف رایگان روزانه/ماهانه + صف‌کردن | ✅ کامل | تست‌شده |
| اتصال گیت‌هاب (App با امضای RS256 واقعی و PAT) | ✅ کامل | تست‌شده (امضای کلید واقعی + REST شبیه‌سازی‌شده) |
| موتور تحلیل و تولید طرح + گزارش فارسی | ✅ کامل | تست‌شده با پاسخ مدل شبیه‌سازی‌شده |
| جریان تأیید با امضای HMAC و انقضا | ✅ کامل | تست‌شده (جعل، انقضا، استفادهٔ مجدد) |
| ساخت شاخه، کامیت فایل، ساخت PR | ✅ کامل | تست‌شده end-to-end روی GitHub شبیه‌سازی‌شده |
| اجرای تست در GitHub Actions + محدودیت دقیقه | ✅ کامل | workflow آماده + منطق dispatch/outcome تست‌شده |
| امنیت: حذف اسرار، ضد تزریق دستور، audit log | ✅ کامل | تست‌شده |
| مستندات و CI | ✅ کامل | CI روی هر PR اجرا می‌شود |
| **تماس زنده با api.telegram.org** | ⏳ نیازمند استقرار | در این سندباکس خروجی شبکه به تلگرام **مسدود** است |
| **تماس زنده با Gemini/Groq** | ⏳ نیازمند کلید شما | در این سندباکس مسدود است؛ با کلید واقعی روی Workers تست می‌شود |
| **اجرای واقعی workflow در Actions** | ⏳ نیازمند مخزن هدف | کد dispatch/outcome تست‌شده؛ اجرای واقعی پس از استقرار |

> یعنی: منطق، امنیت و چرخهٔ کامل با تست‌های واقعی (۸۶ تست، اجرای واقعی روی SQLite
> واقعی و امضای واقعی RSA/HMAC) تأیید شده‌اند؛ اما تماس زنده با تلگرام و مدل‌های
> هوش مصنوعی در این محیط به‌دلیل محدودیت شبکه ممکن نبود و هنگام استقرار با کلید
> واقعی انجام می‌شود (دستور: `/test_api`).

---

## ۲. معماری در یک نگاه

```
تلگرام ──(Webhook با سرّ مشترک)──▶ Cloudflare Worker
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        │                             │                              │
   Auth & Rate-limit            Provider Manager                 Job Queue (D1)
   (فقط owner)            Gemini ▸ Groq ▸ OpenRouter ▸ DeepSeek       │
        │                  (پولی فقط با فعال‌سازی دستی)                │
        │                             │                              ▼
        │                      Analysis Engine ──▶ طرح فارسی ──▶ Approval (HMAC+TTL)
        │                                                              │ تأیید مالک
        │                                                              ▼
        │                                              Execution Engine (GitHub API)
        │                                        شاخه ▸ کامیت ▸ PR ▸ workflow_dispatch
        │                                                              │
        └──────────────────────────── audit log + usage ◀── GitHub Actions (سندباکس)
```

۱۵ جزء منطقی مستقل در `src/` (جزئیات: [`docs/architecture.md`](docs/architecture.md)).

---

## ۳. راه‌اندازی سریع (۱۰ دقیقه)

```bash
git clone <این-مخزن> ai-software-engineer-bot && cd ai-software-engineer-bot
npm install
cp .dev.vars.example .dev.vars       # سپس مقادیر را پُر کن (هرگز کامیت نشود)
npx wrangler d1 create ai-eng-bot-db # شناسهٔ D1 را در wrangler.toml بگذار
npm run db:migrate                   # اعمال migrations/0001_init.sql
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OWNER_TELEGRAM_ID
npx wrangler secret put APPROVAL_SECRET
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GEMINI_API_KEY
npm run deploy
curl -X POST https://<worker>.workers.dev/admin/set-webhook \
  -H "x-admin-token: <ACTIONS_CALLBACK_TOKEN>" \
  -H 'content-type: application/json' \
  -d '{"url":"https://<worker>.workers.dev"}'
```

راهنماهای گام‌به‌گام:
[ساخت ربات تلگرام](docs/setup-telegram.md) ·
[GitHub App](docs/setup-github-app.md) ·
[کلید رایگان هوش مصنوعی](docs/setup-ai-free-tiers.md) ·
[استقرار روی Cloudflare](docs/deploy-cloudflare.md) ·
[جایگزین‌ها: HF Spaces](docs/deploy-hf-spaces.md) و [Oracle Free](docs/deploy-oracle-free.md)

---

## ۴. فرمان‌ها

`/start` `/help` `/projects` `/project` `/new` `/resume` `/status` `/tasks`
`/models` `/provider` `/model` `/test_api` `/github` `/usage` `/tests`
`/history` `/security` `/cancel` `/settings`

همهٔ پاسخ‌ها فارسی و ساده‌اند. منوی اصلی: پروژه‌های من · درخواست جدید · ادامه قبلی ·
انتخاب مدل · تنظیمات API · اتصال GitHub · وضعیت وظایف · تاریخچه · گزارش تست‌ها ·
تنظیمات امنیتی · راهنما.

---

## ۵. قواعد سخت (تغییرناپذیر)

1. **بدون تأیید معتبر، هیچ تغییری در مخزن ایجاد نمی‌شود.** تأیید یعنی دکمهٔ امضاشده با
   `request_id` و `plan_version` و تاریخ انقضا. «باشه»، «ممنون» و «سلام» تأیید نیستند.
2. **هرگز به مدل پولی مهاجرت خودکار نمی‌شود.** اولویت: Gemini ▸ Groq ▸ OpenRouter(:free)
   ▸ DeepSeek؛ OpenAI/Anthropic فقط با فعال‌سازی دستی شما.
3. **هیچ کلیدی در کد، گیت‌هاب، لاگ یا پیام تلگرام نمایش داده نمی‌شود.**
4. **هیچ دستوری که مدل تولید کرده مستقیماً اجرا نمی‌شود**؛ فقط لیست مجاز
   (`src/github/commands.ts` و همان لیست در workflow).
5. **ادغام، انتشار و حذف نیازمند تأیید جداگانه است.**
6. اگر پلن رایگان تمام شود، ربات **می‌خوابد و صف می‌کند**، نه اینکه هزینه بسازد.

---

## ۶. تست‌ها

```bash
npm test        # ۸۶ تست (واحد، یکپارچه، end-to-end با شبیه‌ساز تلگرام/گیت‌هاب/مدل)
npm run typecheck
```

ساختار: `test/auth`, `commands`, `providers`, `github`, `analysis`, `approval`,
`executor`, `patch`, `persistence`, `queue`, `security`, `schema`, `workflow`.
هیچ تستی به شبکه واقعی وصل نمی‌شود؛ همهٔ تماس‌های HTTP با `FetchMock` جایگزین شده‌اند.

---

## ۷. محدودیت‌های رایگان (پایش‌شده)

| منبع | سقف | رفتار ربات |
|---|---|---|
| توکن Gemini/Groq/... | روزانه و ماهانه (در D1 قابل تنظیم) | هشدار در ۸۰٪، توقف و صف در ۱۰۰٪ |
| GitHub Actions | ۲۰۰۰ دقیقه/ماه برای مخزن خصوصی (عمومی: نامحدود با Fair Use) | برآورد قبل از dispatch، هشدار و توقف نزدیک سقف |
| Workers Cron | هر ۵ دقیقه | تخلیهٔ صف |
| D1 | پلن رایگان | کوئری‌های سبک و ایندکس‌دار |

---

## ۸. امنیت

مالک فقط از طریق متغیر محیطی `OWNER_TELEGRAM_ID` تعریف می‌شود و بررسی **سمت سرور**
انجام می‌شود. اسرار در Secrets پلتفرم‌اند. هر محتوای مخزن/Issue/لاگ «دادهٔ غیرقابل‌اعتماد»
است و در پرامپت‌ها محصور می‌شود، بنابراین نمی‌تواند approval بسازد یا دستور عوض کند.
گزارش کامل: [`docs/security.md`](docs/security.md).

---

## ۹. نقشهٔ راه

فاز ۰ تا ۸ انجام شده است؛ جزئیات باقی‌مانده در
[`docs/roadmap.md`](docs/roadmap.md) و مشکلات شناخته‌شده در
[`docs/troubleshooting.md`](docs/troubleshooting.md).
