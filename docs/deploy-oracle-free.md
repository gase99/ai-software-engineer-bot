# استقرار جایگزین روی Oracle Cloud Always Free (حالت B)

یک VM رایگان (AMD: تا ۴ هسته / ۲۴GB یا Arm Ampere) که همیشه روشن است. مناسب اگر
می‌خواهید ربات را با polling و بدون محدودیت زمان اجرا داشته باشید.

## ۱. ساخت VM

1. ثبت‌نام در Oracle Cloud (پلن Always Free؛ کارت برای احراز هویت لازم است اما
   برای منابع Always Free صورتحسابی صادر نمی‌شود).
2. `Compute → Instances → Create instance`
3. تصویر: `Ubuntu 22.04`؛ شکل: `VM.Standard.A1.Flex` (Arm) یا `VM.Standard.E2.1.Micro`
4. کلید SSH خود را بارگذاری کنید و `Create` را بزنید.
5. در `Networking → Security Lists` پورت‌های ۲۲ و (در صورت نیاز) ۸۰/۴۴۳ را باز کنید.

## ۲. نصب پیش‌نیازها

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # باید ۲۰ یا بالاتر باشد
```

## ۳. دریافت کد و نصب

```bash
git clone <این-مخزن> ai-software-engineer-bot
cd ai-software-engineer-bot
npm install --omit=dev   # یا با dev اگر می‌خواهید تست اجرا کنید
```

## ۴. تنظیم محیط

```bash
cp .env.example .env
chmod 600 .env
nano .env      # مقادیر را پُر کنید
```

## ۵. SQLite محلی

```bash
mkdir -p data
node -e "const {sqliteSql}=require('./dist/db/sql.js');" # یا از tsx:
npx tsx -e "import('node:fs')" >/dev/null
npm run db:migrate:local
```

در این حالت ربات از همان اسکیمای `migrations/0001_init.sql` استفاده می‌کند
(`Sql` روی `node:sqlite`).

## ۶. اجرا به‌صورت سرویس

`/etc/systemd/system/ai-bot.service`:

```ini
[Unit]
Description=AI Software Engineer Bot
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/ai-software-engineer-bot
EnvironmentFile=/home/ubuntu/ai-software-engineer-bot/.env
ExecStart=/usr/bin/node --experimental-sqlite dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-bot
journalctl -u ai-bot -f
```

## ۷. وب‌هوک یا پولینگ

- اگر دامنه/HTTPS دارید: وب‌هوک (مسیر `/telegram/webhook`).
- در غیر این صورت: یک اسکریپت polling ساده با `getUpdates` و همان `Bot.handleUpdate`.

## ۸. نگه‌داری

```bash
# پشتیبان روزانه
0 3 * * * sqlite3 /home/ubuntu/ai-software-engineer-bot/data/bot.sqlite \
  ".backup /home/ubuntu/backups/bot-$(date +\%F).sqlite"
```

## ۹. هزینه

منابع Always Free رایگان‌اند. مراقب باشید از سقف Always Free (تعداد instance، حجم
دیسک، ترافیک خروجی) عبور نکنید؛ در غیر این صورت ممکن است هزینه ایجاد شود.
