# cloudflare-catalog

A DZBuild app on Cloudflare Workers that lists a store's products and exports them as CSV. It is
`cloudflare-basic` (the OAuth install with PKCE, one token per store in D1, the launch link from
the merchant dashboard, a signed webhook endpoint) plus two routes that read `GET /v1/products`.
Hono routes the requests, `src/dzbuild.ts` holds the DZBuild contract, D1 holds the state.

## What it does

| Route | What it does |
|---|---|
| `GET /` | Lists the stores that installed the app and links to the install. Shows a banner while a secret is missing. |
| `GET /oauth/install` | Creates a PKCE verifier and a `state` in D1, then redirects the merchant to the DZBuild authorize URL. |
| `GET /oauth/callback` | Consumes the `state` (a second callback with the same state answers 400), exchanges the code, stores one token per store, calls `GET /v1/whoami`. |
| `GET /launch?dz_launch=…` | Verifies the launch token (HS256, issuer, audience, expiry, one use per `jti`), sets a signed session cookie for 15 minutes and redirects to `/app`. Without a token it starts the install, as DZBuild requires. |
| `GET /app` | The page a merchant sees after pressing Open in the dashboard: the first 200 products of the store (one request per 200, following `next_cursor`) and the link to the export. Needs the session cookie and a store that still holds a token. |
| `GET /app/products.csv` | Every product of the store as `products-<store_id>.csv`: columns `id,name,slug,sku,price,status`, CRLF rows, RFC 4180 quoting (a field holding a quote, a comma or a line break is quoted and its quotes doubled), UTF-8 with a byte order mark so Excel reads Arabic names. Same session as `/app`. |
| `POST /webhooks/dzbuild` | Verifies `X-DZ-Signature` over the raw body, answers `webhook.verify`, drops repeats by envelope `id`, clears the store's token on `app.uninstalled` when `data.install_id` matches the current install. |

Redirect, launch and webhook URLs derive from the request origin, so the same code runs on
`workers.dev` and on a domain of your own.

The export is built in memory before the response starts, so a failed page (a revoked token, a
missing scope, a `429`) answers the error page with DZBuild's message rather than a file that ends
short. One invocation may make 50 outbound requests on the free Workers plan (1,000 on the paid
one), which puts the export at 10,000 products on the free plan.

## Deploy it

Three ways in; each ends with a Worker on `https://<name>.<account>.workers.dev`.

1. Button: [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DZBuild-com/dzbuild-app-starter/tree/main/cloudflare-catalog).
   Cloudflare clones this directory into your GitHub account, creates the D1 database and deploys.
   The build runs `npx wrangler deploy`, which does not apply the migration: run `npm run migrate`
   once from the cloned repository, or set the deploy command to `npm run deploy` in the Worker's
   build settings.
2. Scaffold: `npm create cloudflare@latest my-app -- --template DZBuild-com/dzbuild-app-starter/cloudflare-catalog -y --no-deploy --no-open`, then the commands below.
3. Clone: `git clone https://github.com/DZBuild-com/dzbuild-app-starter && cd dzbuild-app-starter/cloudflare-catalog && npm ci`.

For 2 and 3 (Node 22 or newer):

```bash
npx wrangler login
npx wrangler d1 create dzbuild_app   # paste the printed database_id into wrangler.jsonc
npm run deploy                       # applies migrations/ to the remote database, then deploys
```

## Register the app

In the [developer console](https://dzbuild.com/dashboard/developer), create an app with:

| Field | Value |
|---|---|
| Redirect URI | `https://<your-worker>/oauth/callback` |
| Launch URL | `https://<your-worker>/launch` |
| Scopes | the ones in `DZBUILD_SCOPES` in `wrangler.jsonc` (`products:read` by default); every scope the app asks for must be registered |
| Webhook URL | empty (see the next section) |

Then wire the credentials:

```bash
# wrangler.jsonc: replace dzapp_replace_me in vars.DZBUILD_CLIENT_ID with your client_id, then redeploy
npx wrangler secret put DZBUILD_CLIENT_SECRET    # dzas_… shown once when you create the app
npx wrangler secret put DZBUILD_SIGNING_SECRET   # 64 hex characters, behind the toggle in the console
```

`GET /` shows a banner until both secrets exist. Open `https://<your-worker>/oauth/install`,
approve the app on your own store and read the `whoami` answer. While the app is a draft it
installs only on stores your account owns; the [review guidelines](https://dzbuild.dev/review-guidelines)
list what the console requires before you can submit it.

## Webhooks need a domain you own

The DZBuild console refuses webhook URLs on `workers.dev`, so this preset registers no webhook.
Without one, `app.uninstalled` is never delivered: treat a `401` on a store's token as an
uninstall. The endpoint is ready for when you have a zone on your Cloudflare account: add
`"routes": [{ "pattern": "app.example.com", "custom_domain": true }]` to `wrangler.jsonc`, deploy,
register `https://app.example.com/webhooks/dzbuild` in the console and press Verify.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the two secrets
npx wrangler d1 migrations apply dzbuild_app --local
npm run dev                      # http://localhost:8787
```

The install flow needs an `https` redirect URI registered in the console, so exercise install and
launch on the deployed Worker. A local run covers `/` and the webhook handler (sign a body with your
signing secret, `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`); `/app` and the export need a
token, so they run on the deployed Worker too.

## Tests

`npm test` runs `tsc` and Vitest inside workerd (`@cloudflare/vitest-plugin`) with the D1
migration applied: the RFC 7636 PKCE vector, webhook signatures (valid, tampered, stale,
malformed, duplicate id), launch tokens (valid, wrong audience, expired, `alg` none, replayed
`jti`), the install flow (unknown state, `access_denied`, duplicate callback, one row per store),
the uninstall ordering and the API helper's error envelope, plus the catalog routes: `/app`
follows `next_cursor` across two pages and stops at 200, the export quotes a name holding a quote,
a comma and a line break, round-trips an Arabic name, starts with the byte order mark, goes past
200 rows, answers the error page when a later page fails, and answers `401` without a session.
Every outbound `fetch` is stubbed; nothing touches the network.

## Files

- `src/index.ts`: the routes, the product pager and the CSV rows.
- `src/dzbuild.ts`: the DZBuild contract, the same file in every `cloudflare-*` preset.
- `migrations/0001_init.sql`: `installs`, `oauth_states`, `launch_jti`, `webhook_events`.
- `wrangler.jsonc`: the Worker, its D1 binding and the two plain variables. Secrets never go here.
- `worker-configuration.d.ts`: generated by `npm run types` (keep a `.dev.vars` present so the secrets are typed); rerun it after changing a binding.
