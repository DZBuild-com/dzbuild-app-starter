# cloudflare-orders

A DZBuild app on Cloudflare Workers that notices new orders and sends one Telegram message per
order. It is `cloudflare-basic` (the OAuth install with PKCE, one token per store in D1, the launch
link, the signed webhook endpoint) plus a Cron Trigger that polls `GET /v1/orders` once a minute.

## Polling first, webhooks when you have a domain

Order webhooks need a domain you own on your Cloudflare account; `*.workers.dev` URLs are refused
by the DZBuild console. This preset polls new orders every minute instead, which works on
`workers.dev`. To receive status changes as they happen, add
`"routes": [{ "pattern": "app.example.com", "custom_domain": true }]` to `wrangler.jsonc`, deploy,
register `https://app.example.com/webhooks/dzbuild` in the console with the `order.*` events,
press Verify, then set `WEBHOOKS` to `"on"` in `wrangler.jsonc` and deploy again. Polling keeps
running in both modes, so a new order is never missed while a webhook is down.

## What it does

| Route | What it does |
|---|---|
| `GET /` | Lists the stores that installed the app with their polling state (last `orders_since`, orders seen). Shows a banner while a secret or `TELEGRAM_CHAT_ID` is missing. |
| `GET /oauth/install`, `GET /oauth/callback` | The install flow, as in `cloudflare-basic`. |
| `GET /launch?dz_launch=…`, `GET /app` | The launch link from the merchant dashboard, as in `cloudflare-basic`. |
| `POST /webhooks/dzbuild` | Verifies `X-DZ-Signature`, answers `webhook.verify`, drops repeats by envelope `id`, clears the token on `app.uninstalled`. With `WEBHOOKS` on, `order.*` envelopes are kept in `webhook_inbox` for the cron; off, they are acknowledged and dropped. |

Every minute the cron (`src/poll.ts`) runs two steps:

1. For up to 15 installed stores, one `GET /v1/orders?since=<orders_since or installed_at>&limit=50`
   (following `next_cursor` when a page is full). New orders land in `seen_orders` with
   `INSERT OR IGNORE`, and `orders_since` moves to the newest `created_at`. The boundary order comes
   back on the next tick and the primary key absorbs it. A `401` means the install token is dead:
   the store is marked uninstalled. A `403` or `429` skips the store this tick and logs.
2. Up to 30 messages: first the orders that have no message yet (store name, order number,
   customer, total, status), then the stored webhook events, one message per status change. A
   failed send counts one attempt and keeps the error; after five attempts the row stays for
   inspection and is not retried.

The budget is one API request per store per minute, inside the 120 per minute of an install
token, and at most 45 outbound requests per run, inside the free plan's 50 subrequests per
invocation.

## Deploy it

Three ways in; each ends with a Worker on `https://<name>.<account>.workers.dev`.

1. Button: [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DZBuild-com/dzbuild-app-starter/tree/main/cloudflare-orders).
   Cloudflare clones this directory into your GitHub account, creates the D1 database and deploys.
   The build runs `npx wrangler deploy`, which does not apply the migrations: run `npm run migrate`
   once from the cloned repository, or set the deploy command to `npm run deploy` in the Worker's
   build settings.
2. Scaffold: `npm create cloudflare@latest my-app -- --template DZBuild-com/dzbuild-app-starter/cloudflare-orders -y --no-deploy --no-open`, then the commands below.
3. Clone: `git clone https://github.com/DZBuild-com/dzbuild-app-starter && cd dzbuild-app-starter/cloudflare-orders && npm ci`.

For 2 and 3 (Node 22 or newer):

```bash
npx wrangler login
npx wrangler d1 create dzbuild_app   # paste the printed database_id into wrangler.jsonc
npm run migrate                      # applies migrations/ (installs, seen_orders, webhook_inbox) to the remote database
npm run deploy
```

The deploy registers the Cron Trigger (`* * * * *` in `wrangler.jsonc`). The Worker's page in the
Cloudflare dashboard lists the past runs under Triggers.

## Register the app

In the [developer console](https://dzbuild.com/dashboard/developer), create an app with:

| Field | Value |
|---|---|
| Redirect URI | `https://<your-worker>/oauth/callback` |
| Launch URL | `https://<your-worker>/launch` |
| Scopes | `orders:read` (the value of `DZBUILD_SCOPES` in `wrangler.jsonc`) |
| Webhook URL | empty on `workers.dev`; `https://app.example.com/webhooks/dzbuild` once you have a domain |

Then wire the credentials:

```bash
# wrangler.jsonc: replace dzapp_replace_me in vars.DZBUILD_CLIENT_ID with your client_id, then redeploy
npx wrangler secret put DZBUILD_CLIENT_SECRET    # dzas_… shown once when you create the app
npx wrangler secret put DZBUILD_SIGNING_SECRET   # 64 hex characters, behind the toggle in the console
```

Open `https://<your-worker>/oauth/install` and approve the app on your own store. While the app is
a draft it installs only on stores your account owns; the
[review guidelines](https://dzbuild.dev/review-guidelines) list what the console requires before
you can submit it.

## Telegram

1. Open a chat with [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token
   (`123456789:AA…`).
2. Send your new bot any message (or add it to a group and write there), then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id` from the answer. A group id
   starts with `-100`.
3. Wire both:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# wrangler.jsonc: set vars.TELEGRAM_CHAT_ID to the chat id, then redeploy
```

Until both exist the cron records orders and logs that Telegram is off; the first tick after you
set them sends the backlog (30 messages per minute at most). Messages are plain text, no parse
mode, so order numbers and names appear as they are.

## Inspect the state

```bash
npx wrangler d1 execute dzbuild_app --remote --command "SELECT store_id, store_name, orders_since FROM installs"
npx wrangler d1 execute dzbuild_app --remote --command "SELECT * FROM seen_orders WHERE attempts >= 5"
npx wrangler d1 execute dzbuild_app --remote --command "SELECT * FROM webhook_inbox WHERE processed_at IS NULL"
```

`last_error` holds Telegram's answer (`400 Bad Request: chat not found` means the chat id is wrong
or the bot was never messaged). To retry a row that reached five attempts, set its `attempts` back
to `0`. `npx wrangler tail` shows the cron's log lines as they happen.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the three secrets
npx wrangler d1 migrations apply dzbuild_app --local
npm run dev -- --test-scheduled  # http://localhost:8787
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"   # runs one tick against the local database
```

The install flow needs an `https` redirect URI registered in the console, so exercise install and
launch on the deployed Worker. A local tick polls the real API with whatever tokens the local
database holds and sends to the real Telegram chat.

## Tests

`npm test` runs `tsc` and Vitest inside workerd (`@cloudflare/vitest-plugin`) with both migrations
applied. On top of the `cloudflare-basic` suite: two ticks over the same order list give one
`seen_orders` row and one Telegram call; `orders_since` advances to the newest `created_at`; a full
page follows `next_cursor`; a Telegram failure counts an attempt and a sixth tick never retries;
`ok: false` with a 200 status is a failure; a `401` marks the store uninstalled; a `429` or `403`
leaves the state untouched; missing Telegram configuration records orders without a call; at most
15 stores per tick; `WEBHOOKS` off drops `order.*` but still handles `app.uninstalled`; `WEBHOOKS`
on stores an envelope once and the cron sends one message per row. Every outbound `fetch` is
stubbed; nothing touches the network.

## Files

- `src/index.ts`: the routes and the default export (`fetch` plus `scheduled`).
- `src/poll.ts`: the cron: poll, record, notify.
- `src/dzbuild.ts`: the DZBuild contract, the same file in every `cloudflare-*` preset.
- `migrations/0001_init.sql`: `installs`, `oauth_states`, `launch_jti`, `webhook_events`.
- `migrations/0002_orders.sql`: `seen_orders`, `installs.orders_since`, `webhook_inbox`.
- `wrangler.jsonc`: the Worker, the cron, its D1 binding and the plain variables (`WEBHOOKS`, `TELEGRAM_CHAT_ID`). Secrets never go here.
- `worker-configuration.d.ts`: generated by `npm run types` (keep a `.dev.vars` present so the secrets are typed); rerun it after changing a binding.
