import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';

const ORIGIN = 'https://app.example.com';
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

async function hmac(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(data));
}
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (s: string | ArrayBuffer) =>
  btoa(typeof s === 'string' ? s : String.fromCharCode(...new Uint8Array(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function launchToken(claims: object, alg = 'HS256'): Promise<string> {
  const head = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(await hmac(env.DZBUILD_SIGNING_SECRET, `${head}.${body}`))}`;
}

const claimsFor = (storeId: number, jti: string, overrides: object = {}) => {
  const iat = now();
  return { iss: 'dzbuild', aud: env.DZBUILD_CLIENT_ID, sub: '15', store_id: storeId, install_id: 7, is_owner: true, iat, exp: iat + 300, jti, ...overrides };
};

async function webhook(body: object, t = now()): Promise<Response> {
  const raw = JSON.stringify(body);
  return exports.default.fetch(`${ORIGIN}/webhooks/dzbuild`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dz-signature': `t=${t},v1=${hex(await hmac(env.DZBUILD_SIGNING_SECRET, `${t}.${raw}`))}` },
    body: raw,
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Product { id: number; name: string; slug: string; sku: string | null; price: number; status: string }
interface ProductPage { items: Product[]; next_cursor: string | null; has_more: boolean }

const product = (id: number, name: string, sku: string | null = `SKU-${id}`): Product => ({ id, name, slug: `p-${id}`, sku, price: 1500, status: 'active' });
const productPage = (items: Product[], next_cursor: string | null = null): ProductPage => ({ items, next_cursor, has_more: next_cursor !== null });

function grant(stores: { store_id: number; install_id: number }[], scope = 'products:read') {
  const list = stores.map((s) => ({ ...s, store_name: `Shop ${s.store_id}`, access_token: `tok_${s.store_id}_${s.install_id}` }));
  return { access_token: list[0].access_token, token_type: 'Bearer', scope, store_id: list[0].store_id, install_id: list[0].install_id, stores: list };
}

// Runs the install redirect and returns the state DZBuild would send back.
async function startInstall(): Promise<string> {
  const res = await exports.default.fetch(`${ORIGIN}/oauth/install`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!).searchParams.get('state')!;
}

// Product pages are keyed by the cursor they answer to; '' is the first page. An unknown cursor is an unexpected fetch.
// A Response must be built inside the mock: one made in the test's request context cannot be read in the handler's.
function stubPlatform(g: ReturnType<typeof grant>, pages: Record<string, ProductPage | (() => Response)> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://dzbuild.com/oauth/apps/token') return json(200, g);
    if (url === 'https://api.dzbuild.app/v1/whoami') return json(200, { data: { app: { install_id: g.install_id } }, meta: {} });
    if (url.startsWith('https://api.dzbuild.app/v1/products?')) {
      const answer = pages[new URL(url).searchParams.get('cursor') ?? ''];
      if (typeof answer === 'function') return answer();
      if (answer) return json(200, { data: answer, meta: {} });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

async function install(stores: { store_id: number; install_id: number }[], pages: Record<string, ProductPage | (() => Response)> = {}) {
  const state = await startInstall();
  const calls = stubPlatform(grant(stores), pages);
  const res = await exports.default.fetch(`${ORIGIN}/oauth/callback?state=${state}&code=c0de`);
  expect(res.status).toBe(200);
  return calls;
}

const installRows = (storeId: number) =>
  env.DB.prepare('SELECT install_id, access_token, uninstalled_at FROM installs WHERE store_id = ?').bind(storeId).all<{ install_id: number; access_token: string | null; uninstalled_at: string | null }>();

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('GET /', () => {
  it('lists installed stores with names escaped and offers Install', async () => {
    await env.DB.prepare("INSERT INTO installs (store_id, install_id, store_name, access_token, scopes, installed_at) VALUES (1, 1, '<b>Shop</b>', 't', 'orders:read', '2026-09-30T00:00:00Z')").run();
    const res = await exports.default.fetch(`${ORIGIN}/`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('&lt;b&gt;Shop&lt;/b&gt;');
    expect(body).not.toContain('<b>Shop</b>');
    expect(body).toContain('href="/oauth/install"');
    expect(body).not.toContain('wrangler secret put');
  });

  it('shows the secrets banner when either secret is empty', async () => {
    for (const missing of ['DZBUILD_CLIENT_SECRET', 'DZBUILD_SIGNING_SECRET']) {
      const res = await app.fetch(new Request(`${ORIGIN}/`), { ...env, [missing]: '' });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`wrangler secret put ${missing}`);
    }
  });
});

describe('OAuth install', () => {
  it('redirects to the authorize URL with the origin-derived redirect URI and a stored state', async () => {
    const res = await exports.default.fetch(`${ORIGIN}/oauth/install`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe('https://dzbuild.com/oauth/apps/authorize');
    expect(url.searchParams.get('client_id')).toBe(env.DZBUILD_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/oauth/callback`);
    expect(url.searchParams.get('scope')).toBe(env.DZBUILD_SCOPES);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    const row = await env.DB.prepare('SELECT verifier FROM oauth_states WHERE state = ?').bind(state).first<{ verifier: string }>();
    expect(row?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('opens the install flow when /launch has no token', async () => {
    const res = await exports.default.fetch(`${ORIGIN}/launch`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/oauth/install');
  });

  it('answers 400 on an unknown state without calling the token endpoint', async () => {
    const res = await exports.default.fetch(`${ORIGIN}/oauth/callback?state=${'0'.repeat(32)}&code=c0de`);
    expect(res.status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('answers 400 on error=access_denied without calling the token endpoint', async () => {
    const state = await startInstall();
    const res = await exports.default.fetch(`${ORIGIN}/oauth/callback?state=${state}&error=access_denied`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('access_denied');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('exchanges the code with the verifier, stores one token per store and calls whoami', async () => {
    const state = await startInstall();
    const verifier = (await env.DB.prepare('SELECT verifier FROM oauth_states WHERE state = ?').bind(state).first<{ verifier: string }>())!.verifier;
    const calls = stubPlatform(grant([{ store_id: 201, install_id: 7 }, { store_id: 202, install_id: 8 }]));
    const res = await exports.default.fetch(`${ORIGIN}/oauth/callback?state=${state}&code=c0de`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Installed on 2 store(s)');
    const form = new URLSearchParams(String(calls[0].init?.body));
    expect(form.get('code')).toBe('c0de');
    expect(form.get('code_verifier')).toBe(verifier);
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/oauth/callback`);
    expect(form.get('client_secret')).toBe(env.DZBUILD_CLIENT_SECRET);
    expect(calls[1].url).toBe('https://api.dzbuild.app/v1/whoami');
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer tok_201_7');
    expect((await installRows(201)).results).toEqual([{ install_id: 7, access_token: 'tok_201_7', uninstalled_at: null }]);
    expect((await installRows(202)).results).toEqual([{ install_id: 8, access_token: 'tok_202_8', uninstalled_at: null }]);
  });

  it('refuses a second callback with the same state and keeps one install row', async () => {
    const state = await startInstall();
    stubPlatform(grant([{ store_id: 203, install_id: 9 }]));
    expect((await exports.default.fetch(`${ORIGIN}/oauth/callback?state=${state}&code=c0de`)).status).toBe(200);
    expect((await exports.default.fetch(`${ORIGIN}/oauth/callback?state=${state}&code=c0de`)).status).toBe(400);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect((await installRows(203)).results).toHaveLength(1);
  });

  it('shows the platform error when the exchange fails', async () => {
    const state = await startInstall();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(400, { error: 'invalid_grant', error_description: 'code used' }));
    const res = await exports.default.fetch(`${ORIGIN}/oauth/callback?state=${state}&code=c0de`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('invalid_grant');
  });
});

describe('GET /launch and /app', () => {
  it('accepts a valid token once, sets the session cookie and opens the store page', async () => {
    await install([{ store_id: 301, install_id: 7 }], { '': productPage([product(1, 'Tee')]) });
    const token = await launchToken(claimsFor(301, 'jti-301-a'));
    const res = await exports.default.fetch(`${ORIGIN}/launch?dz_launch=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^dz_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=900');
    const page = await exports.default.fetch(`${ORIGIN}/app`, { headers: { cookie: cookie.split(';')[0] } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Shop 301');
    const replay = await exports.default.fetch(`${ORIGIN}/launch?dz_launch=${token}`, { redirect: 'manual' });
    expect(replay.status).toBe(401);
  });

  it('refuses the wrong audience, an expired token and alg none', async () => {
    for (const token of [
      await launchToken(claimsFor(302, 'jti-302-a', { aud: 'dzapp_other' })),
      await launchToken(claimsFor(302, 'jti-302-b', { exp: now() - 1 })),
      await launchToken(claimsFor(302, 'jti-302-c'), 'none'),
    ]) {
      const res = await exports.default.fetch(`${ORIGIN}/launch?dz_launch=${token}`, { redirect: 'manual' });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('answers 401 on /app without a valid cookie and 404 for a store without a token', async () => {
    expect((await exports.default.fetch(`${ORIGIN}/app`)).status).toBe(401);
    expect((await exports.default.fetch(`${ORIGIN}/app`, { headers: { cookie: 'dz_session=301.forged' } })).status).toBe(401);
    const token = await launchToken(claimsFor(303, 'jti-303-a'));
    const res = await exports.default.fetch(`${ORIGIN}/launch?dz_launch=${token}`, { redirect: 'manual' });
    const page = await exports.default.fetch(`${ORIGIN}/app`, { headers: { cookie: res.headers.get('set-cookie')!.split(';')[0] } });
    expect(page.status).toBe(404);
  });
});

// Installs the app on one store and opens a launch session; returns the cookie header value.
async function openSession(storeId: number): Promise<string> {
  await install([{ store_id: storeId, install_id: 7 }]);
  const res = await exports.default.fetch(`${ORIGIN}/launch?dz_launch=${await launchToken(claimsFor(storeId, `jti-${storeId}`))}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('GET /app', () => {
  it('lists the products of every page by following next_cursor', async () => {
    const cookie = await openSession(501);
    const calls = stubPlatform(grant([{ store_id: 501, install_id: 7 }]), { '': productPage([product(1, 'Tee'), product(2, 'Cap')], 'c2'), c2: productPage([product(3, 'Bag')]) });
    const res = await exports.default.fetch(`${ORIGIN}/app`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const name of ['Tee', 'Cap', 'Bag']) expect(body).toContain(name);
    expect(body).toContain('href="/app/products.csv"');
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.dzbuild.app/v1/products?limit=200',
      'https://api.dzbuild.app/v1/products?limit=200&cursor=c2',
    ]);
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer tok_501_7');
  });

  it('stops at 200 products even when the platform has more', async () => {
    const cookie = await openSession(502);
    const items = Array.from({ length: 200 }, (_, i) => product(i + 1, `Product ${i + 1}`));
    const calls = stubPlatform(grant([{ store_id: 502, install_id: 7 }]), { '': productPage(items, 'c2') });
    const res = await exports.default.fetch(`${ORIGIN}/app`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await res.text()).toContain('Product 200');
  });
});

describe('GET /app/products.csv', () => {
  const decode = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());

  it('quotes names holding a quote, a comma or a newline and keeps Arabic intact', async () => {
    const cookie = await openSession(503);
    stubPlatform(grant([{ store_id: 503, install_id: 7 }]), {
      '': productPage([product(1, 'Say "hi", now'), product(2, '\u0642\u0645\u064a\u0635 \u0642\u0637\u0646', null)], 'c2'),
      c2: productPage([product(3, 'Line\nbreak')]),
    });
    const res = await exports.default.fetch(`${ORIGIN}/app/products.csv`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="products-503.csv"');
    expect(await decode(res)).toBe(
      'id,name,slug,sku,price,status\r\n' +
      '1,"Say ""hi"", now",p-1,SKU-1,1500,active\r\n' +
      '2,\u0642\u0645\u064a\u0635 \u0642\u0637\u0646,p-2,,1500,active\r\n' +
      '3,"Line\nbreak",p-3,SKU-3,1500,active\r\n',
    );
  });

  it('starts with a UTF-8 byte order mark so spreadsheet apps read the names', async () => {
    const cookie = await openSession(504);
    stubPlatform(grant([{ store_id: 504, install_id: 7 }]), { '': productPage([]) });
    const res = await exports.default.fetch(`${ORIGIN}/app/products.csv`, { headers: { cookie } });
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('exports past 200 rows', async () => {
    const cookie = await openSession(505);
    const items = Array.from({ length: 200 }, (_, i) => product(i + 1, `Product ${i + 1}`));
    stubPlatform(grant([{ store_id: 505, install_id: 7 }]), { '': productPage(items, 'c2'), c2: productPage([product(201, 'Product 201')]) });
    const res = await exports.default.fetch(`${ORIGIN}/app/products.csv`, { headers: { cookie } });
    expect((await decode(res)).split('\r\n')).toHaveLength(203);
  });

  it('answers the error page instead of a short file when a later page cannot be read', async () => {
    const cookie = await openSession(506);
    stubPlatform(grant([{ store_id: 506, install_id: 7 }]), { '': productPage([product(1, 'Tee')], 'c2'), c2: () => json(429, { error: { code: 'rate_limited', message: 'slow down', retry_after: 7 } }) });
    const res = await exports.default.fetch(`${ORIGIN}/app/products.csv`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('rate_limited');
  });

  it('answers 401 without a session and never calls the platform', async () => {
    const res = await exports.default.fetch(`${ORIGIN}/app/products.csv`);
    expect(res.status).toBe(401);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/dzbuild', () => {
  const eventRows = (id: string) => env.DB.prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE event_id = ?').bind(id).first<{ n: number }>();

  it('answers 200 to webhook.verify and records a signed event once', async () => {
    expect((await webhook({ id: 'evt_verify', event: 'webhook.verify', created_at: 't', store_id: 0, data: {} })).status).toBe(200);
    expect((await eventRows('evt_verify'))?.n).toBe(0);
    const body = { id: 'evt_' + '1'.repeat(24), event: 'order.created', created_at: 't', store_id: 401, data: { order: { id: 1 }, items: [] } };
    expect((await webhook(body)).status).toBe(200);
    expect((await webhook(body)).status).toBe(200);
    expect((await eventRows(body.id))?.n).toBe(1);
  });

  it('refuses a tampered body, a stale timestamp and a malformed header', async () => {
    const t = now();
    const raw = JSON.stringify({ id: 'evt_x', event: 'order.created', store_id: 402, data: {} });
    const sig = `t=${t},v1=${hex(await hmac(env.DZBUILD_SIGNING_SECRET, `${t}.${raw}`))}`;
    const post = (body: string, signature: string) =>
      exports.default.fetch(`${ORIGIN}/webhooks/dzbuild`, { method: 'POST', headers: { 'x-dz-signature': signature }, body });
    expect((await post(raw.replace('created', 'deleted'), sig)).status).toBe(401);
    expect((await webhook({ id: 'evt_old', event: 'order.created', store_id: 402, data: {} }, t - 301)).status).toBe(401);
    expect((await post(raw, 'v1=abc')).status).toBe(401);
    expect((await post(raw, '')).status).toBe(401);
    expect((await eventRows('evt_x'))?.n).toBe(0);
  });

  it('drops the token on app.uninstalled only for the install named in the notice', async () => {
    await install([{ store_id: 403, install_id: 7 }]);
    await install([{ store_id: 403, install_id: 9 }]);
    const notice = (id: string, installId: number) => ({ id, event: 'app.uninstalled', created_at: 't', store_id: 403, data: { install_id: installId, client_id: env.DZBUILD_CLIENT_ID, store_id: 403, uninstalled_at: '2026-09-30T12:00:00+00:00' } });
    expect((await webhook(notice('evt_un_7', 7))).status).toBe(200);
    expect((await installRows(403)).results).toEqual([{ install_id: 9, access_token: 'tok_403_9', uninstalled_at: null }]);
    expect((await webhook(notice('evt_un_9', 9))).status).toBe(200);
    expect((await installRows(403)).results).toEqual([{ install_id: 9, access_token: null, uninstalled_at: '2026-09-30T12:00:00+00:00' }]);
  });
});
