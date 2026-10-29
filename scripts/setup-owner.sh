#!/usr/bin/env bash
# هشدار: این اسکریپت آزمایش نشده؛ اولین اجرا را با احتیاط انجام بده.
# فقط سینتکس آن با bash -n بررسی می‌شود؛ هیچ Deploy یا تماس واقعی با آن انجام نشده است.
# Secrets are read interactively or from stdin, never as command arguments.
# Do not run this file with `bash -x` or `set -x`.

set -u
set -o pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR" || exit 1

DB_NAME="ai-eng-bot-db"
WORKER_URL=""
TELEGRAM_BOT_TOKEN_VALUE=""
TELEGRAM_WEBHOOK_SECRET_VALUE=""
trap 'unset TELEGRAM_BOT_TOKEN_VALUE TELEGRAM_WEBHOOK_SECRET_VALUE' EXIT

info() { printf '\nℹ️  %s\n' "$*"; }
ok() { printf '✅ %s\n' "$*"; }
manual() { printf '\nاین مرحله را دستی انجام بده: %s\n' "$*"; }

confirm_step() {
  local prompt="$1"
  local answer=""
  printf '\n────────────────────────────────────────\n%s\n' "$prompt"
  printf 'برای ادامه y و برای توقف n بزن [y/N]: '
  read -r answer || return 1
  case "$answer" in
    y|Y|yes|YES|بله) return 0 ;;
    *) return 1 ;;
  esac
}

run_step() {
  local prompt="$1"
  local manual_command="$2"
  shift 2
  if ! confirm_step "$prompt"; then
    manual "$manual_command"
    return 1
  fi
  if "$@"; then
    ok "مرحله انجام شد: $prompt"
    return 0
  fi
  manual "$manual_command"
  return 1
}

check_node() {
  command -v node >/dev/null 2>&1 || return 1
  node --version
  node -e "const [major,minor]=process.versions.node.split('.').map(Number); if(major<22||(major===22&&minor<5)){console.error('Node 22.5+ لازم است');process.exit(1)}"
}

cloudflare_login() {
  if npx wrangler whoami; then return 0; fi
  info "ورود به Cloudflare لازم است؛ صفحهٔ مرورگر یا لینک ورود را فقط خودت باز کن."
  npx wrangler login && npx wrangler whoami
}

create_d1_and_bind() {
  local output=""
  local status=0
  local database_id=""
  output="$(npx wrangler d1 create "$DB_NAME" 2>&1)"
  status=$?
  printf '%s\n' "$output"
  if [ "$status" -ne 0 ]; then return 1; fi

  database_id="$(printf '%s\n' "$output" | grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | head -n 1 || true)"
  if [[ ! "$database_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    printf 'database_id در خروجی پیدا نشد.\n' >&2
    return 1
  fi

  DATABASE_ID="$database_id" node - <<'NODE'
const fs = require('fs');
const id = process.env.DATABASE_ID;
const file = 'wrangler.toml';
const placeholder = 'database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"';
const text = fs.readFileSync(file, 'utf8');
if (!id || !text.includes(placeholder)) {
  console.error('جایگزین database_id در wrangler.toml پیدا نشد؛ فایل را دستی بررسی کن.');
  process.exit(1);
}
fs.writeFileSync(file, text.replace(placeholder, `database_id = "${id}"`));
console.log('database_id در wrangler.toml ثبت شد؛ هیچ Secretی در این فایل قرار ندارد.');
NODE
}

put_secret() {
  local name="$1"
  local prompt="$2"
  local target_variable="${3:-}"
  local value=""
  printf '%s (ورودی پنهان است): ' "$prompt"
  read -rsp '' value
  printf '\n'
  if [ -z "$value" ]; then
    printf 'مقدار خالی برای %s پذیرفته نیست.\n' "$name" >&2
    return 1
  fi
  if ! printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null; then
    unset value
    printf 'ثبت %s ناموفق بود.\n' "$name" >&2
    return 1
  fi
  if [ -n "$target_variable" ]; then printf -v "$target_variable" '%s' "$value"; fi
  unset value
  ok "Secret ثبت شد: $name"
}

put_generated_secret() {
  local name="$1"
  local target_variable="${2:-}"
  local value=""
  value="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")" || return 1
  if ! printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null; then
    unset value
    return 1
  fi
  if [ -n "$target_variable" ]; then printf -v "$target_variable" '%s' "$value"; fi
  unset value
  ok "Secret تصادفی ثبت شد (بدون نمایش مقدار): $name"
}

put_private_key() {
  local key_path=""
  read -rp 'مسیر کامل فایل .pem گیت‌هاب (محتوا نمایش داده نمی‌شود): ' key_path
  if [ -z "$key_path" ] || [ ! -f "$key_path" ]; then
    printf 'فایل private key پیدا نشد.\n' >&2
    return 1
  fi
  if ! npx wrangler secret put GITHUB_APP_PRIVATE_KEY < "$key_path" >/dev/null; then
    printf 'ثبت GITHUB_APP_PRIVATE_KEY ناموفق بود.\n' >&2
    return 1
  fi
  ok 'Secret ثبت شد: GITHUB_APP_PRIVATE_KEY'
}

configure_secrets() {
  info "هیچ مقداری در آرگومان دستور یا خروجی نمایش داده نمی‌شود. برای ACTIONS_CALLBACK_TOKEN مقدار تصادفی را قبلاً در Password Manager ذخیره کن؛ بعداً همان را در GitHub Actions Secrets هم لازم داری."
  put_secret TELEGRAM_BOT_TOKEN 'توکن BotFather' TELEGRAM_BOT_TOKEN_VALUE || return 1
  put_generated_secret TELEGRAM_WEBHOOK_SECRET TELEGRAM_WEBHOOK_SECRET_VALUE || return 1
  put_secret OWNER_TELEGRAM_ID 'شناسهٔ عددی مالک در Telegram' || return 1
  put_generated_secret APPROVAL_SECRET || return 1
  put_secret ACTIONS_CALLBACK_TOKEN 'توکن تصادفی Callback که در Password Manager ذخیره کرده‌ای' || return 1
  put_secret GEMINI_API_KEY 'کلید Gemini' || return 1

  local github_method=""
  read -rp 'اتصال GitHub با [A]pp توصیه‌شده یا [P]AT؟ [A/P]: ' github_method
  case "${github_method:-A}" in
    a|A)
      put_secret GITHUB_APP_ID 'GitHub App ID' || return 1
      put_secret GITHUB_INSTALLATION_ID 'GitHub Installation ID' || return 1
      put_private_key || return 1
      ;;
    p|P)
      put_secret GITHUB_TOKEN 'Fine-grained GitHub PAT فقط برای مخزن هدف' || return 1
      ;;
    *)
      printf 'گزینهٔ GitHub نامعتبر است.\n' >&2
      return 1
      ;;
  esac
}

validate_before_deploy() {
  grep -q 'AI_DAILY_REQUEST_LIMIT = "50"' wrangler.toml || return 1
  grep -q 'ACTIONS_MONTHLY_MINUTE_LIMIT = "100"' wrangler.toml || return 1
  if grep -q 'REPLACE_WITH_YOUR_D1_DATABASE_ID' wrangler.toml; then return 1; fi
  npm run typecheck && npm test
}

deploy_worker() {
  local output=""
  local status=0
  output="$(npm run deploy 2>&1)"
  status=$?
  printf '%s\n' "$output"
  if [ "$status" -ne 0 ]; then return 1; fi
  WORKER_URL="$(printf '%s\n' "$output" | grep -Eo 'https://[A-Za-z0-9._-]+\.workers\.dev' | head -n 1 || true)"
  if [ -z "$WORKER_URL" ]; then
    read -rp 'آدرس HTTPS Worker را از خروجی Deploy کپی کن: ' WORKER_URL
  fi
  WORKER_URL="${WORKER_URL%/}"
  [[ "$WORKER_URL" =~ ^https://[^[:space:]]+$ ]]
}

check_health() {
  WORKER_URL="$WORKER_URL" node --input-type=module - <<'NODE'
try {
  const response = await fetch(`${process.env.WORKER_URL}/health`);
  const body = await response.json().catch(() => null);
  console.log(JSON.stringify({ status: response.status, body }, null, 2));
  if (!response.ok || body?.ok !== true) process.exit(1);
} catch {
  console.error('تماس Health با Worker ناموفق بود.');
  process.exit(1);
}
NODE
}

set_telegram_webhook() {
  BOT_TOKEN="$TELEGRAM_BOT_TOKEN_VALUE" WEBHOOK_SECRET="$TELEGRAM_WEBHOOK_SECRET_VALUE" WORKER_URL="$WORKER_URL" node --input-type=module - <<'NODE'
try {
  const token = process.env.BOT_TOKEN;
  const secret = process.env.WEBHOOK_SECRET;
  const base = process.env.WORKER_URL;
  if (!token || !secret || !base) process.exit(1);
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${base}/telegram/webhook`, secret_token: secret, drop_pending_updates: false }),
  });
  const body = await response.json().catch(() => null);
  console.log(JSON.stringify({ httpStatus: response.status, ok: body?.ok, description: body?.description }, null, 2));
  if (!response.ok || body?.ok !== true) process.exit(1);
} catch {
  console.error('ثبت Webhook ناموفق بود؛ جزئیات درخواست و Secret چاپ نمی‌شود.');
  process.exit(1);
}
NODE
}

show_webhook_info() {
  BOT_TOKEN="$TELEGRAM_BOT_TOKEN_VALUE" node --input-type=module - <<'NODE'
try {
  const token = process.env.BOT_TOKEN;
  if (!token) process.exit(1);
  const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'POST' });
  const body = await response.json().catch(() => null);
  const result = body?.result ?? {};
  console.log(JSON.stringify({
    httpStatus: response.status,
    ok: body?.ok,
    url: result.url,
    pending_update_count: result.pending_update_count,
    last_error_message: result.last_error_message,
    last_error_date: result.last_error_date,
  }, null, 2));
  if (!response.ok || body?.ok !== true) process.exit(1);
} catch {
  console.error('getWebhookInfo ناموفق بود؛ Token چاپ نمی‌شود.');
  process.exit(1);
}
NODE
}

printf '\nهشدار: این اسکریپت آزمایش نشده؛ اولین اجرا را با احتیاط انجام بده.\n'
printf 'فقط سینتکس آن با bash -n بررسی شده است؛ اجرای کامل، Deploy و Webhook واقعی آزمایش نشده‌اند.\n'
printf 'هیچ Secret را در چت، خروجی، آرگومان اسکریپت یا فایل Commit‌شده وارد نکن.\n'

run_step '۱) بررسی Node 22.5 یا جدیدتر' 'Node 22.5+ را نصب کن و دستور node --version را اجرا کن' check_node || exit 1
run_step '۲) نصب وابستگی‌های قفل‌شدهٔ پروژه' 'npm ci --no-audit --no-fund' npm ci --no-audit --no-fund || exit 1
run_step '۳) بررسی Wrangler' 'npx wrangler --version' npx wrangler --version || exit 1
run_step '۴) بررسی/ورود به Cloudflare' 'npx wrangler login && npx wrangler whoami' cloudflare_login || exit 1

if ! confirm_step "۵) ساخت D1 با نام $DB_NAME و ثبت database_id در wrangler.toml"; then
  manual "npx wrangler d1 create $DB_NAME و ثبت database_id در wrangler.toml"
  exit 1
fi
if ! create_d1_and_bind; then
  manual "npx wrangler d1 list و سپس ثبت database_id درست در wrangler.toml؛ اگر دیتابیس نداری: npx wrangler d1 create $DB_NAME"
  exit 1
fi
ok 'مرحله انجام شد: ساخت و اتصال D1'

run_step '۶) اجرای Migration روی D1 واقعی' 'npm run db:migrate' npm run db:migrate || exit 1
run_step '۷) ثبت تعاملی Secrets در Cloudflare و انتخاب GitHub App/PAT' 'npx wrangler secret put [SECRET_NAME] را برای نام‌های docs/owner-guide.md یکی‌یکی اجرا کن؛ مقدار را فقط در prompt بنویس' configure_secrets || exit 1
run_step '۸) بررسی سقفهای ۵۰ درخواست AI و ۱۰۰ دقیقه Actions و اجرای Typecheck/تست' 'wrangler.toml را بررسی کن و سپس npm run typecheck && npm test را اجرا کن' validate_before_deploy || exit 1
run_step '۹) Deploy واقعی Worker روی Cloudflare' 'npm run deploy' deploy_worker || exit 1
run_step '۱۰) بررسی Health عمومی Worker' 'curl --fail [YOUR_WORKER_URL]/health' check_health || exit 1
run_step '۱۱) ثبت Telegram Webhook با Secret' 'docs/owner-guide.md، بخش ثبت Webhook دستی را اجرا کن' set_telegram_webhook || exit 1
run_step '۱۲) خواندن getWebhookInfo و نمایش فقط فیلدهای امن' 'docs/owner-guide.md، بخش getWebhookInfo دستی را اجرا کن' show_webhook_info || exit 1

info "Deploy اولیه تمام شد، اما راه‌اندازی هنوز کامل نیست."
printf '۱. در مخزن هدف، Variable با نام BOT_CALLBACK_URL را برابر %s/actions/callback قرار بده.\n' "$WORKER_URL"
printf '۲. Secret با نام ACTIONS_CALLBACK_TOKEN را با همان مقدار ذخیره‌شده در Password Manager بساز؛ مقدار اینجا چاپ نمی‌شود.\n'
printf '۳. فایل .github/workflows/ai-exec.yml را در مخزن هدف داشته باش و تست واقعی را طبق docs/manual-test-checklist.md انجام بده.\n'
printf '۴. Telegram، Gemini، Cloudflare و ai-exec واقعی را آزمایش کن؛ موفقیت این پیام به‌تنهایی تأیید آن‌ها نیست.\n'
