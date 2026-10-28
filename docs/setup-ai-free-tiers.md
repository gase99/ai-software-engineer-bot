# گرفتن کلید رایگان هوش مصنوعی

اولویت پیش‌فرض ربات (ارزان‌ترین اول):

| رتبه | ارائه‌دهنده | مدل پیش‌فرض | پلن رایگان |
|---|---|---|---|
| ۱ | Google Gemini | `gemini-2.0-flash` | دارد (محدودیت نرخ روزانه) |
| ۲ | Groq | `llama-3.1-70b-versatile` | دارد (سریع، محدودیت نرخ) |
| ۳ | OpenRouter | مدل‌های دارای `:free` | دارد |
| ۴ | DeepSeek | `deepseek-chat` | اعتبار محدود اولیه |
| ۵ | OpenAI / Anthropic | — | **پولی؛ فقط با فعال‌سازی دستی شما** |

> قاعدهٔ سخت: ربات هرگز خودکار به مدل پولی نمی‌رود. اگر کلید OpenAI/Anthropic را
> بدهید، آن‌ها غیرفعال می‌مانند تا خودتان `/provider openai` را بزنید.

## ۱. Gemini (توصیهٔ اول)

1. به <https://aistudio.google.com/app/apikey> بروید.
2. `Create API key` → کلیدی شبیه `AIza...` می‌گیرید.
3. در ربات:

```bash
npx wrangler secret put GEMINI_API_KEY
```

بررسی: در تلگرام `/test_api` را بزنید یا

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GEMINI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"contents":[{"parts":[{"text":"سلام"}]}]}'
```

## ۲. Groq

1. ثبت‌نام در <https://console.groq.com>.
2. `API Keys → Create API Key` (شروع با `gsk_`).
3. `npx wrangler secret put GROQ_API_KEY`

## ۳. OpenRouter

1. <https://openrouter.ai/keys> → `Create Key` (شروع با `sk-or-`).
2. `npx wrangler secret put OPENROUTER_API_KEY`
3. فقط مدل‌هایی با پسوند `:free` انتخاب کنید، مثلاً:

```
/model meta-llama/llama-3.1-8b-instruct:free
```

## ۴. DeepSeek

1. <https://platform.deepseek.com/api_keys>
2. `npx wrangler secret put DEEPSEEK_API_KEY`

## ۵. تغییر ارائه‌دهنده و مدل از تلگرام

```
/provider gemini
/model gemini-1.5-flash
/models          # لیست ارائه‌دهنده‌ها و مدل‌ها
/test_api        # تست واقعی اتصال هر کلید
/usage           # مصرف امروز و این ماه
```

## ۶. سقف رایگان و رفتار ربات

- سقف روزانه/ماهانه برای هر ارائه‌دهنده در جدول `providers` (D1) ذخیره می‌شود و
  پیش‌فرض آن‌ها با پلن رایگان سازگار است.
- در ۸۰٪ سقف: پیام هشدار به شما.
- در ۱۰۰٪ سقف: ربات ارسال را متوقف می‌کند و درخواست را **صف** می‌کند (هزینه نمی‌سازد).
- برای تغییر سقف‌ها:

```sql
UPDATE providers SET daily_limit = 200000 WHERE name = 'gemini';
```

با `npx wrangler d1 execute DB --command "..."`.

## ۷. اگر کلید لو رفت

1. همان لحظه در پنل ارائه‌دهنده کلید را `Delete/Revoke` کنید.
2. کلید جدید بسازید و `npx wrangler secret put ...` را تکرار کنید.
3. `npx wrangler deploy` (تا مقدار جدید بارگذاری شود).
4. ربات کلید نامعتبر را خودکار غیرفعال می‌کند و به شما پیام می‌دهد — بدون نمایش کلید.
