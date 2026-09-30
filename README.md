# DZBuild app starter

A DZBuild app is a service you run yourself: a merchant installs it on their store, and your code
reads and changes that store's data through the REST API at `https://api.dzbuild.app/v1`. DZBuild
is the e-commerce platform for Algerian merchants; the developer documentation is at
[dzbuild.dev](https://dzbuild.dev).

This repository gives you three ways in. Each one implements the same contract: the OAuth install
with PKCE, one token per store, signed webhooks and the launch link from the merchant dashboard.

## 1. Deploy a preset to Cloudflare

Each `cloudflare-*` directory is a self-contained Worker (Hono, D1, its own `package.json` and
`wrangler.jsonc`). Press the button: Cloudflare clones the preset into your GitHub account,
creates the D1 database and deploys it on a free `workers.dev` URL.

| Preset | What it does | Deploy | Needs a domain you own? |
|---|---|---|---|
| [`cloudflare-basic`](cloudflare-basic/) | Install flow, tokens in D1, launch link, signed webhook endpoint. The base for your own app. | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DZBuild-com/dzbuild-app-starter/tree/main/cloudflare-basic) | No. It registers no webhook. |
| `cloudflare-catalog` | Lists the store's products and exports them as CSV. | coming | No. |
| `cloudflare-orders` | Notices new orders (polling by default) and sends Telegram alerts; order webhooks once you have a domain. | coming | Only for webhooks: the DZBuild console refuses `workers.dev` webhook URLs. Polling works everywhere. |

After the deploy, apply the D1 migration once, set the two secrets and register the app in the
[developer console](https://dzbuild.com/dashboard/developer) with your Worker's URL. The preset
README lists every command.

## 2. Scaffold a preset locally

```bash
npm create cloudflare@latest my-app -- --template DZBuild-com/dzbuild-app-starter/cloudflare-basic -y --no-deploy --no-open
cd my-app && npm test
```

## 3. Run the Node example

A complete DZBuild app in about 200 lines of Node.js with no dependencies. Clone the repository,
set four environment variables, install it on your own store, and build your feature on top.

### What is implemented

| Route | What it does |
|---|---|
| `GET /install` | Creates a PKCE verifier and a `state`, then redirects the merchant to the DZBuild authorize URL. |
| `GET /callback` | Checks `state`, exchanges the code, stores one token per store in `data/tokens.json`, calls `GET /v1/whoami`. |
| `POST /webhooks/dzbuild` | Verifies `X-DZ-Signature` over the raw body, drops repeats by envelope `id`, answers `200` at once. Marks the store on `app.uninstalled`. |
| `GET /launch` | Verifies the `dz_launch` token (HS256, issuer, audience, expiry, replay) and redirects to `/app`. Without a token it starts the install, as DZBuild requires. |
| `GET /` | Lists the stores that installed the app. |

`src/dzbuild.js` holds the contract (PKCE, authorize URL, token exchange, webhook and launch-token
verification, API calls with the `Idempotency-Key` rule) and has no server code, so you can copy it
into any Node.js project. `cloudflare-*/src/dzbuild.ts` is the same contract on Web Crypto.

### Run it

1. Open the [developer console](https://dzbuild.com/dashboard/developer), register an app and note
   the `client_id`, the client secret (shown once) and the signing secret.
2. Expose your machine over `https`, for example with a tunnel, and register
   `https://<your-host>/callback` as the redirect URI, `https://<your-host>/launch` as the launch URL
   and `https://<your-host>/webhooks/dzbuild` as the webhook URL. Redirect URIs are compared character
   for character.
3. Copy `.env.example` to `.env`, fill it in, then:

```bash
npm test
set -a; . ./.env; set +a
node src/server.js
```

4. Open `https://<your-host>/install`, approve the app on your own store, and read the `whoami`
   answer. Press Verify next to the webhook URL in the console; the starter answers the
   `webhook.verify` request.

The app is a draft, so it installs only on stores your account owns until DZBuild reviews it. The
[review guidelines](https://dzbuild.dev/review-guidelines) list what the console requires before you
can submit.

### Make your first call

```js
import {api} from './src/dzbuild.js';
import {loadStores} from './src/store.js';

const store = Object.values(loadStores())[0];
const orders = await api(store.access_token, 'GET', '/orders?limit=10');
console.log(orders.data);
```

Writes need an `Idempotency-Key`; `api()` refuses a `POST`, `PATCH` or `DELETE` without one. Generate
one key per operation and reuse it on every retry:

```js
await api(store.access_token, 'POST', `/orders/${id}/whatsapp`, {
  body: {template: 'confirmed', language: 'fr'},
  idempotencyKey: `wa-${id}-confirmed`,
});
```

### Tests

`npm test` runs `node --test`: the RFC 7636 PKCE vector, webhook signatures (valid, tampered, stale,
malformed), launch tokens (valid, wrong audience, expired, `alg` none, bad signature) and the API
helper's error envelope and idempotency rule. Nothing in the tests touches the network.

## Docs MCP (coming)

`@dzbuild/docs-mcp` will let your coding agent search the developer docs and the API description
from the terminal. Once it is on npm, one line per client:

```bash
claude mcp add dzbuild-docs -- npx -y @dzbuild/docs-mcp          # Claude Code
codex mcp add dzbuild-docs -- npx -y @dzbuild/docs-mcp           # Codex
```

Cursor (`.cursor/mcp.json`) and Claude Desktop (`claude_desktop_config.json`) take the same command:

```json
{"mcpServers": {"dzbuild-docs": {"command": "npx", "args": ["-y", "@dzbuild/docs-mcp"]}}}
```

## Repository layout

- `src/`, `test/`: the Node example.
- `cloudflare-*/`: one isolated Worker per preset. `src/dzbuild.ts` is the same file in every preset; `node scripts/sync-check.mjs` exits 1 when a copy drifts.
- `scripts/test-all.sh`: every check in one run (sync-check, the Node tests, then `npm ci && npm test && npx wrangler deploy --dry-run` in each preset).
- `AGENTS.md`: the template from dzbuild.dev for coding agents.

## Read next

- [Get started](https://dzbuild.dev/getting-started) and [Core concepts](https://dzbuild.dev/concepts)
- [OAuth](https://dzbuild.dev/oauth), [Webhooks](https://dzbuild.dev/webhooks), [Errors](https://dzbuild.dev/errors)
- [Security requirements](https://dzbuild.dev/security)
- For coding agents: [llms.txt](https://dzbuild.dev/llms.txt) and the [agent skill](https://dzbuild.dev/skills/dzbuild-apps/SKILL.md).

## License

MIT.
