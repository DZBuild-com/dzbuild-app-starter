# AGENTS.md

This repository is a DZBuild app: a service that merchants install on their DZBuild store
(https://dzbuild.com, e-commerce platform for Algerian merchants). DZBuild runs none of this code.
The app talks to the store through the REST API at https://api.dzbuild.app/v1 and receives webhooks.

## Where the facts are

- Index of the developer docs, one line per page: https://dzbuild.dev/llms.txt
- Any page as Markdown: its URL plus `.md`, for example https://dzbuild.dev/webhooks.md
- The rules in one file: https://dzbuild.dev/skills/dzbuild-apps/SKILL.md
- OpenAPI 3.1 description of every operation an install token can call: https://dzbuild.dev/openapi/dzbuild-apps-v1.json

Read the page for the part you are changing before you change it. Do not infer DZBuild behaviour from
general OAuth or webhook knowledge; several details differ (no refresh tokens, `Idempotency-Key` on every
write, one token per store).

## Rules for changes

- Secrets (`DZBUILD_CLIENT_SECRET`, `DZBUILD_SIGNING_SECRET`, every install token) come from the
  environment or the secret store. Never write them into code, tests, fixtures, logs or chat.
- Every `POST`, `PATCH` and `DELETE` to `api.dzbuild.app` carries an `Idempotency-Key` (at most 64
  characters of `A-Z a-z 0-9 _ - : .`), one key per operation, reused on every retry of that operation.
- Webhook handlers read the raw body, verify `X-DZ-Signature` (`t=<ts>,v1=<hex>` where `v1` is
  HMAC-SHA256 with the signing secret over `t + "." + raw body`) in constant time, reject a timestamp
  more than 300 seconds away, dedupe on the envelope `id`, answer `200` at once and process later.
- Redirect URIs are compared character for character with the ones registered in the developer console.
- Treat `401` on an install token as an uninstall. Stop on `403` with an `app_*` code and show the message.
- Back off on `429` using `error.retry_after`, then resend with the same `Idempotency-Key`.
- On `app.uninstalled`, drop the store's token and delete its data within 30 days.
- Store one token per `store_id`; a token never reaches another store.

## Environment variables

| Name | Value |
|---|---|
| `DZBUILD_CLIENT_ID` | `dzapp_` + 20 hex characters, from the developer console |
| `DZBUILD_CLIENT_SECRET` | `dzas_` + 48 hex characters, shown once in the console |
| `DZBUILD_SIGNING_SECRET` | 64 hex characters, from the console; signs webhooks and `dz_launch` tokens |
| `DZBUILD_REDIRECT_URI` | One of the redirect URIs registered on the app, exact string |

## Checks before a pull request

- PKCE: the verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` must give the challenge
  `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`.
- A webhook fixture signed with a test secret verifies; the same fixture with one byte changed fails;
  a timestamp 301 seconds old fails.
- A `dz_launch` token with the wrong `aud`, a wrong `alg` or an `exp` in the past is refused.
- No secret value appears in the diff (`git diff | grep -E 'dzas_|dzpk_live_'` prints nothing).
