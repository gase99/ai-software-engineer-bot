# معماری

## چرا حالت A (Serverless)؟

| معیار | A: Workers + D1 + Actions | B: VM همیشه‌روشن | C: فقط Actions |
|---|---|---|---|
| هزینه | ۰ (پلن رایگان) | ۰ ولی وابسته به VM رایگان | ۰ |
| همیشه در دسترس | بله (edge) | بله | خیر (تأخیر cron) |
| اجرای کد/تست | Actions (سندباکس واقعی) | روی همان VM | Actions |
| نگه‌داری | کم | متوسط (سیستم‌عامل، صف) | کم |
| محدودیت | زمان CPU هر invocation | منابع VM رایگان | تأخیر چنددقیقه‌ای |

انتخاب مالک: **A**. پیامد: هر کار سنگین (تحلیل طولانی، ساخت شاخه/کامیت/PR، اجرای تست)
یا به GitHub Actions فرستاده می‌شود یا در صف (`jobs`) می‌ماند تا کرون (هر ۵ دقیقه)
آن را بردارد. Worker فقط پیام را می‌گیرد، جواب می‌دهد و کار را صف می‌کند.

## ۱۵ جزء منطقی

| # | جزء | فایل(ها) | مسئولیت |
|---|---|---|---|
| ۱ | Telegram Interface | `src/telegram/api.ts`, `router.ts`, `keyboard.ts`, `src/index.ts` | وب‌هوک، ارسال/ویرایش پیام، کیبورد فارسی |
| ۲ | Auth & Authorization | `src/security/auth.ts` | فقط `OWNER_TELEGRAM_ID`؛ بررسی سمت سرور |
| ۳ | Project Registry | `src/db/store.ts` (جدول `projects`, `github_repos`) | ثبت و انتخاب پروژه |
| ۴ | AI Provider Manager | `src/ai/registry.ts`, `providers/*`, `usage.ts` | انتخاب مدل، سقف رایگان، جایگزینی، مصرف |
| ۵ | Context Builder | `src/core/context.ts` | انتخاب فایل‌های مرتبط در بودجهٔ توکن |
| ۶ | Analysis Engine | `src/core/analyzer.ts`, `prompts.ts`, `report.ts` | تحلیل مخزن و تولید گزارش فارسی |
| ۷ | Approval Workflow | `src/core/approval.ts` | توکن امضاشده + انقضا + جلوگیری از تکرار |
| ۸ | GitHub Integration | `src/github/client.ts`, `appJwt.ts`, `token.ts` | خواندن مخزن، شاخه، کامیت، PR |
| ۹ | Execution Dispatcher | `src/github/actions.ts`, `quota.ts` | `workflow_dispatch` و پایش دقیقه |
| ۱۰ | Execution Worker | `.github/workflows/ai-exec.yml` | اجرای دستورهای مجاز در runner تمیز |
| ۱۱ | Job Queue | `src/db/store.ts` (جدول `jobs`), `src/jobs/dispatcher.ts` | صف idempotent با اجاره و تلاش مجدد |
| ۱۲ | Persistent DB | `src/db/schema.ts`, `sql.ts` | یک اسکیمای SQLite برای D1/Turso/SQLite |
| ۱۳ | Logging & Audit | `src/util/log.ts`, جدول `audit_log`, `job_logs` | لاگ JSON ساختاریافته و ردپای حسابرسی |
| ۱۴ | Cost & Usage Tracking | جدول `api_usage`, `github_actions_usage` | سقف روزانه/ماهانه و هشدار |
| ۱۵ | Config & Secrets | `src/env.ts`, `wrangler.toml`, `.dev.vars` | تنظیمات غیرمحرمانه + اسرار پلتفرم |

## جریان یک درخواست

```
/new <متن>
  │
  ├─ createRequest(status=draft) ─▶ enqueue(job: analyze) ─▶ اجرا (inline یا کرون)
  │        └─ takeSnapshot ─▶ buildContext ─▶ ProviderManager.complete(jsonMode)
  │             └─ coercePlan (پاک‌سازی مسیرها و دستورها) ─▶ savePlan(version=n)
  │                  └─ renderPlanReport + issue(token) ─▶ پیام با ۴ دکمه
  │
  ├─ [تأیید و شروع]  ⇐ امضای HMAC + نسخهٔ طرح + TTL
  │        └─ enqueue(job: execute)
  │             ├─ branchExists? ─▶ createBranch(ai/<id>-<slug>)
  │             ├─ writeCode ─▶ validateRepoPath ─▶ putFile (یا applyUnifiedDiff)
  │             ├─ createPullRequest(head=branch, base=default_branch)
  │             ├─ checkActionsQuota ─▶ dispatchWorkflow(ai-exec.yml) ─▶ outcome()
  │             └─ reportExecution ─▶ پیام نهایی + addMemory + audit
  │
  └─ [اصلاح طرح] ─▶ نسخهٔ جدید طرح (version+1) بدون هیچ تغییر در مخزن
```

## انتخاب فناوری و دلیل آن

| انتخاب | دلیل |
|---|---|
| TypeScript روی Workers | زمان اجرای کوتاه، D1 بومی، Cron رایگان، بدون سرور |
| D1 (SQLite) | رایگان، SQLite-سازگار، همان کد روی Turso/SQLite محلی اجرا می‌شود |
| `crypto.subtle` به‌جای وابستگی JWT | بدون وابستگی خارجی؛ همان کد در Node برای تست کار می‌کند |
| fetch خام به‌جای Octokit | حجم Worker کوچک و کنترل کامل روی تلاش مجدد/تایم‌اوت |
| یک لایهٔ `Sql` برای D1 و node:sqlite | یک پیاده‌سازی کوئری، بدون انحراف بین محیط تست و تولید |
| GitHub Actions به‌عنوان سندباکس | بدون Docker روی میزبان؛ runner تمیز و محدودیت زمان/خروجی |
| Cron هر ۵ دقیقه | تخلیهٔ صف بدون سرویس پولی؛ jobها idempotent با `job_id` |

## محدودیت‌های شناخته‌شده

- زمان CPU هر invocation روی Workers محدود است؛ تحلیل‌های خیلی بزرگ ممکن است به کرون
  منتقل شوند (تأخیر تا ۵ دقیقه). پیام «درصف» به مالک نشان می‌دهد.
- خروجی تست‌ها از طریق artifact و job summary منتقل می‌شود؛ لاگ کامل فقط در Actions است.
- GitHub API برای «دقیقهٔ باقیمانده» endpoint عمومی ندارد؛ ربات از زمان اجراهای واقعی
  خودش اندازه‌گیری می‌کند (`src/github/quota.ts`).
