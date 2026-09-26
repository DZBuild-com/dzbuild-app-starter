// A complete DZBuild app in one process: install flow, token storage, signed webhooks, launch link.
// Node 20+, no dependencies. Configuration comes from the environment (see .env.example).
import http from 'node:http';
import crypto from 'node:crypto';
import {api, authorizeUrl, exchangeCode, pkcePair, verifyLaunchToken, verifyWebhook} from './dzbuild.js';
import {loadStores, saveStore} from './store.js';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
};

const CLIENT_ID = env('DZBUILD_CLIENT_ID');
const CLIENT_SECRET = env('DZBUILD_CLIENT_SECRET');
const SIGNING_SECRET = env('DZBUILD_SIGNING_SECRET');
const REDIRECT_URI = env('DZBUILD_REDIRECT_URI');
const SCOPES = env('DZBUILD_SCOPES', 'orders:read');
const PORT = Number(env('PORT', '3000'));

// state -> PKCE verifier, for 10 minutes (the lifetime of a consent request).
const pending = new Map();
// Webhook envelope ids already handled (delivery is at least once).
const seenEvents = new Set();
// Launch token ids accepted in the last 5 minutes.
const seenLaunches = new Map();

const html = (res, status, body) => {
  res.writeHead(status, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
  res.end(`<!doctype html><meta charset="utf-8"><title>DZBuild app starter</title><body style="font:16px/1.5 system-ui;max-width:48rem;margin:3rem auto;padding:0 1rem">${body}`);
};
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const stores = Object.values(loadStores());
    const rows = stores.map((s) => `<li>${escape(s.store_name)} (store ${s.store_id}, install ${s.install_id}, scopes ${escape(s.scope)})</li>`).join('');
    return html(res, 200, `<h1>DZBuild app starter</h1><p>${stores.length} installed store(s).</p><ul>${rows}</ul><p><a href="/install">Install on a store</a></p>`);
  }

  // Start the install: a fresh PKCE pair and state per request, kept server side.
  if (req.method === 'GET' && (url.pathname === '/install' || (url.pathname === '/launch' && !url.searchParams.has('dz_launch')))) {
    const state = crypto.randomBytes(16).toString('hex');
    const {verifier, challenge} = pkcePair();
    pending.set(state, {verifier, at: Date.now()});
    for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
    res.writeHead(302, {location: authorizeUrl({clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scope: SCOPES, state, challenge})});
    return res.end();
  }

  // The merchant approved: check state, exchange the code, store one token per store.
  if (req.method === 'GET' && url.pathname === new URL(REDIRECT_URI).pathname) {
    const state = url.searchParams.get('state');
    const entry = state && pending.get(state);
    if (!entry) return html(res, 400, '<p>Unknown or expired state. <a href="/install">Start again</a>.</p>');
    pending.delete(state);
    if (url.searchParams.has('error')) {
      return html(res, 400, `<p>DZBuild answered <code>${escape(url.searchParams.get('error'))}</code>. <a href="/install">Start again</a>.</p>`);
    }
    try {
      const grant = await exchangeCode({code: url.searchParams.get('code'), verifier: entry.verifier, redirectUri: REDIRECT_URI, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET});
      for (const s of grant.stores) saveStore({...s, scope: grant.scope, installed_at: new Date().toISOString()});
      const whoami = await api(grant.access_token, 'GET', '/whoami');
      return html(res, 200, `<h1>Installed on ${grant.stores.length} store(s)</h1><pre>${escape(JSON.stringify(whoami.data, null, 2))}</pre><p><a href="/">Home</a></p>`);
    } catch (e) {
      console.error('exchange failed', e);
      return html(res, 502, `<p>The exchange failed: ${escape(e.message)}. <a href="/install">Start again</a>.</p>`);
    }
  }

  // Signed webhooks: verify the raw bytes first, answer fast, process after.
  if (req.method === 'POST' && url.pathname === '/webhooks/dzbuild') {
    const raw = await readBody(req);
    if (!verifyWebhook({secret: SIGNING_SECRET, signatureHeader: req.headers['x-dz-signature'], rawBody: raw})) {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200);
    res.end();
    const event = JSON.parse(raw.toString('utf8'));
    if (seenEvents.has(event.id)) return;
    seenEvents.add(event.id);
    if (seenEvents.size > 10_000) seenEvents.delete(seenEvents.values().next().value);
    if (event.event === 'app.uninstalled') {
      saveStore({store_id: event.store_id, uninstalled_at: event.data.uninstalled_at, access_token: null});
    }
    console.log(`webhook ${event.event} store ${event.store_id} id ${event.id}`);
    return;
  }

  // The merchant clicked Open in the dashboard: verify dz_launch, then leave the token behind.
  if (req.method === 'GET' && url.pathname === '/launch') {
    const claims = verifyLaunchToken({jwt: url.searchParams.get('dz_launch'), secret: SIGNING_SECRET, clientId: CLIENT_ID});
    const now = Date.now();
    for (const [k, t] of seenLaunches) if (now - t > 5 * 60_000) seenLaunches.delete(k);
    if (!claims || seenLaunches.has(claims.jti)) return html(res, 401, '<p>This launch link is not valid. Open the app from your DZBuild dashboard again.</p>');
    seenLaunches.set(claims.jti, now);
    res.writeHead(302, {location: `/app?store=${claims.store_id}`});
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/app') {
    const store = loadStores()[url.searchParams.get('store')];
    if (!store || !store.access_token) return html(res, 404, '<p>This store has not installed the app. <a href="/install">Install it</a>.</p>');
    return html(res, 200, `<h1>${escape(store.store_name)}</h1><p>Opened from the DZBuild dashboard. The app holds a token for store ${store.store_id}.</p>`);
  }

  html(res, 404, '<p>Not found.</p>');
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) html(res, 500, '<p>Something went wrong.</p>');
  });
}).listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
