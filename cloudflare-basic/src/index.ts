// A DZBuild app on Cloudflare Workers: install flow, one token per store in D1, signed webhooks,
// launch link. Redirect, launch and webhook URLs derive from the request origin, so register
// `<origin>/oauth/callback`, `<origin>/launch` and `<origin>/webhooks/dzbuild` in the console.
import { Hono } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { api, authorizeUrl, DZBuildError, exchangeCode, pkce, verifyLaunchToken, verifyWebhook } from './dzbuild';

interface InstallRow {
  store_id: number;
  install_id: number;
  store_name: string | null;
  scopes: string;
  active: number;
}

interface WebhookEnvelope {
  id: string;
  event: string;
  store_id: number;
  data?: { install_id?: number; uninstalled_at?: string };
}

const app = new Hono<{ Bindings: Env }>();

const page = (body: HtmlEscapedString | Promise<HtmlEscapedString>) =>
  html`<!doctype html><meta charset="utf-8"><title>DZBuild app</title><body style="font:16px/1.5 system-ui;max-width:48rem;margin:3rem auto;padding:0 1rem">${body}`;
const origin = (url: string) => new URL(url).origin;
const unix = () => Math.floor(Date.now() / 1000);

app.onError((err, c) => {
  console.error(err);
  if (err instanceof DZBuildError) {
    return c.html(page(html`<p>DZBuild answered ${err.message}. <a href="/oauth/install">Start again</a>.</p>`), 502);
  }
  return c.html(page(html`<p>Something went wrong.</p>`), 500);
});

app.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT store_id, install_id, store_name, scopes, access_token IS NOT NULL AS active FROM installs ORDER BY store_id',
  ).all<InstallRow>();
  const missing = (['DZBUILD_CLIENT_SECRET', 'DZBUILD_SIGNING_SECRET'] as const).filter((name) => !c.env[name]);
  return c.html(page(html`
    ${missing.map((name) => html`<p style="background:#fef3c7;padding:.75rem 1rem">Secret missing: run <code>npx wrangler secret put ${name}</code>, then redeploy.</p>`)}
    <h1>DZBuild app</h1>
    <p>${results.length} installed store(s).</p>
    <ul>${results.map((r) => html`<li>${r.store_name ?? `Store ${r.store_id}`} (store ${r.store_id}, install ${r.install_id}, scopes ${r.scopes}${r.active ? '' : ', uninstalled'})</li>`)}</ul>
    <p><a href="/oauth/install">Install on a store</a></p>`));
});

// Start the install: a fresh PKCE pair and state per request, kept in D1 for 10 minutes.
app.get('/oauth/install', async (c) => {
  const { verifier, challenge } = await pkce();
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const now = unix();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - 600),
    c.env.DB.prepare('INSERT INTO oauth_states (state, verifier, created_at) VALUES (?, ?, ?)').bind(state, verifier, now),
  ]);
  return c.redirect(authorizeUrl({
    clientId: c.env.DZBUILD_CLIENT_ID,
    redirectUri: `${origin(c.req.url)}/oauth/callback`,
    scope: c.env.DZBUILD_SCOPES,
    state,
    challenge,
  }));
});

// The merchant approved: consume the state, exchange the code, store one token per store.
app.get('/oauth/callback', async (c) => {
  const verifier = await c.env.DB.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING verifier').bind(c.req.query('state') ?? '').first<string>('verifier');
  if (!verifier) return c.html(page(html`<p>Unknown or expired state. <a href="/oauth/install">Start again</a>.</p>`), 400);
  const error = c.req.query('error');
  if (error) return c.html(page(html`<p>DZBuild answered <code>${error}</code>. <a href="/oauth/install">Start again</a>.</p>`), 400);
  const grant = await exchangeCode(fetch, {
    code: c.req.query('code') ?? '',
    verifier,
    redirectUri: `${origin(c.req.url)}/oauth/callback`,
    clientId: c.env.DZBUILD_CLIENT_ID,
    clientSecret: c.env.DZBUILD_CLIENT_SECRET,
  });
  const installedAt = new Date().toISOString();
  await c.env.DB.batch(grant.stores.map((s) => c.env.DB.prepare(
    `INSERT INTO installs (store_id, install_id, store_name, access_token, scopes, installed_at, uninstalled_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(store_id) DO UPDATE SET install_id = excluded.install_id, store_name = excluded.store_name, access_token = excluded.access_token,
       scopes = excluded.scopes, installed_at = excluded.installed_at, uninstalled_at = NULL`,
  ).bind(s.store_id, s.install_id, s.store_name, s.access_token, grant.scope, installedAt)));
  const whoami = await api<{ data: unknown }>(fetch, grant.access_token, 'GET', '/whoami');
  return c.html(page(html`<h1>Installed on ${grant.stores.length} store(s)</h1><pre>${JSON.stringify(whoami.data, null, 2)}</pre><p><a href="/">Home</a></p>`));
});

// The merchant clicked Open in the dashboard: verify dz_launch once, then leave the token behind.
app.get('/launch', async (c) => {
  const token = c.req.query('dz_launch');
  if (!token) return c.redirect('/oauth/install');
  const invalid = () => c.html(page(html`<p>This launch link is not valid. Open the app from your DZBuild dashboard again.</p>`), 401);
  const claims = await verifyLaunchToken(token, c.env.DZBUILD_SIGNING_SECRET, c.env.DZBUILD_CLIENT_ID);
  if (!claims) return invalid();
  const now = unix();
  const [, inserted] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM launch_jti WHERE seen_at < ?').bind(now - 300),
    c.env.DB.prepare('INSERT OR IGNORE INTO launch_jti (jti, seen_at) VALUES (?, ?)').bind(claims.jti, now),
  ]);
  if (inserted.meta.changes === 0) return invalid();
  await setSignedCookie(c, 'dz_session', String(claims.store_id), c.env.DZBUILD_CLIENT_SECRET, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 900, path: '/' });
  return c.redirect('/app');
});

app.get('/app', async (c) => {
  const storeId = await getSignedCookie(c, c.env.DZBUILD_CLIENT_SECRET, 'dz_session');
  if (!storeId) return c.html(page(html`<p>Open the app from your DZBuild dashboard.</p>`), 401);
  const store = await c.env.DB.prepare('SELECT store_id, store_name FROM installs WHERE store_id = ? AND access_token IS NOT NULL')
    .bind(Number(storeId)).first<{ store_id: number; store_name: string | null }>();
  if (!store) return c.html(page(html`<p>This store has not installed the app. <a href="/oauth/install">Install it</a>.</p>`), 404);
  return c.html(page(html`<h1>${store.store_name ?? `Store ${store.store_id}`}</h1><p>Opened from the DZBuild dashboard. The app holds a token for store ${store.store_id}.</p>`));
});

// Signed webhooks: verify the raw bytes first, dedupe on the envelope id, then act.
app.post('/webhooks/dzbuild', async (c) => {
  const raw = await c.req.text();
  if (!(await verifyWebhook(raw, c.req.header('x-dz-signature') ?? null, c.env.DZBUILD_SIGNING_SECRET))) return c.body(null, 401);
  const event = JSON.parse(raw) as WebhookEnvelope;
  if (event.event === 'webhook.verify') return c.body(null, 200);
  const seen = await c.env.DB.prepare('INSERT OR IGNORE INTO webhook_events (event_id, event, store_id, received_at) VALUES (?, ?, ?, ?)')
    .bind(event.id, event.event, event.store_id, unix()).run();
  if (seen.meta.changes === 0) return c.body(null, 200);
  if (event.event === 'app.uninstalled') {
    // A delayed notice for an older install must not wipe a newer one, so install_id is in the WHERE.
    await c.env.DB.prepare('UPDATE installs SET access_token = NULL, uninstalled_at = ? WHERE store_id = ? AND install_id = ?')
      .bind(event.data?.uninstalled_at ?? new Date().toISOString(), event.store_id, event.data?.install_id ?? null).run();
  }
  return c.body(null, 200);
});

export default app;
