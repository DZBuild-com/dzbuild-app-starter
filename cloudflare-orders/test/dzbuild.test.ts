import { describe, expect, it } from 'vitest';
import { api, authorizeUrl, challengeFor, DZBuildError, exchangeCode, pkce, verifyLaunchToken, verifyWebhook } from '../src/dzbuild';

const SECRET = 'a'.repeat(64);
const CLIENT_ID = 'dzapp_0123456789abcdef0123';
const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(data));
}
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (s: string | ArrayBuffer) =>
  btoa(typeof s === 'string' ? s : String.fromCharCode(...new Uint8Array(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(rawBody: string, t: number, secret = SECRET): Promise<string> {
  return `t=${t},v1=${hex(await hmac(secret, `${t}.${rawBody}`))}`;
}

async function launchToken(claims: object, { alg = 'HS256', secret = SECRET } = {}): Promise<string> {
  const head = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(await hmac(secret, `${head}.${body}`))}`;
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('pkce', () => {
  it('matches the RFC 7636 test vector', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('gives a 43 character base64url verifier and its challenge', async () => {
    const { verifier, challenge } = await pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await challengeFor(verifier)).toBe(challenge);
  });
});

describe('authorizeUrl', () => {
  it('carries every required parameter, encoded', () => {
    const url = new URL(authorizeUrl({
      clientId: CLIENT_ID, redirectUri: 'https://app.example.com/oauth/callback', scope: 'orders:read products:read',
      state: 'abc', challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    }));
    expect(url.origin + url.pathname).toBe('https://dzbuild.com/oauth/apps/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe('orders:read products:read');
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.search).toContain('redirect_uri=https%3A%2F%2Fapp.example.com%2Foauth%2Fcallback');
  });
});

describe('exchangeCode', () => {
  const params = { code: 'c0de', verifier: 'v'.repeat(43), redirectUri: 'https://app.example.com/oauth/callback', clientId: CLIENT_ID, clientSecret: 'dzas_x' };

  it('posts a form-encoded body to the token URL and returns the grant', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const grant = { access_token: 't1', token_type: 'Bearer', scope: 'orders:read', store_id: 11, install_id: 7, stores: [] };
    const fetchImpl: typeof fetch = async (url, init) => { seen = { url: String(url), init: init! }; return jsonResponse(200, grant); };
    expect(await exchangeCode(fetchImpl, params)).toEqual(grant);
    expect(seen!.url).toBe('https://dzbuild.com/oauth/apps/token');
    expect(seen!.init.method).toBe('POST');
    expect(new Headers(seen!.init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(seen!.init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('c0de');
    expect(body.get('code_verifier')).toBe('v'.repeat(43));
    expect(body.get('redirect_uri')).toBe(params.redirectUri);
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe('dzas_x');
  });

  it('turns an OAuth error into DZBuildError', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'code used' });
    await expect(exchangeCode(fetchImpl, params)).rejects.toMatchObject({ status: 400, code: 'invalid_grant' });
  });
});

describe('verifyWebhook', () => {
  const raw = '{"id":"evt_1","event":"order.created"}';

  it('accepts a fresh signed body', async () => {
    expect(await verifyWebhook(raw, await sign(raw, 1000), SECRET, 1010)).toBe(true);
  });

  it('refuses a body that changed by one byte', async () => {
    const tampered = '{"id":"evt_1","event":"order.deleted"}';
    expect(await verifyWebhook(tampered, await sign(raw, 1000), SECRET, 1010)).toBe(false);
  });

  it('refuses a timestamp 301 seconds away and accepts 300', async () => {
    const header = await sign(raw, 1000);
    expect(await verifyWebhook(raw, header, SECRET, 1301)).toBe(false);
    expect(await verifyWebhook(raw, header, SECRET, 1300)).toBe(true);
    expect(await verifyWebhook(raw, header, SECRET, 699)).toBe(false);
  });

  it('refuses a malformed, empty or missing header', async () => {
    expect(await verifyWebhook(raw, 'v1=abc', SECRET, 1000)).toBe(false);
    expect(await verifyWebhook(raw, 't=1000,v1=zz', SECRET, 1000)).toBe(false);
    expect(await verifyWebhook(raw, '', SECRET, 1000)).toBe(false);
    expect(await verifyWebhook(raw, null, SECRET, 1000)).toBe(false);
  });
});

describe('verifyLaunchToken', () => {
  const now = 1_700_000_000;
  const claims = { iss: 'dzbuild', aud: CLIENT_ID, sub: '15', store_id: 141, install_id: 7, is_owner: true, iat: now, exp: now + 300, jti: '0123456789abcdef' };

  it('returns the claims of a valid token', async () => {
    const got = await verifyLaunchToken(await launchToken(claims), SECRET, CLIENT_ID, now);
    expect(got).toMatchObject({ store_id: 141, install_id: 7, jti: '0123456789abcdef' });
  });

  it('refuses the wrong audience, an expired token, alg none, a bad signature and no token', async () => {
    expect(await verifyLaunchToken(await launchToken({ ...claims, aud: 'dzapp_other' }), SECRET, CLIENT_ID, now)).toBeNull();
    expect(await verifyLaunchToken(await launchToken(claims), SECRET, CLIENT_ID, now + 301)).toBeNull();
    expect(await verifyLaunchToken(await launchToken(claims, { alg: 'none' }), SECRET, CLIENT_ID, now)).toBeNull();
    expect(await verifyLaunchToken(await launchToken(claims, { secret: 'b'.repeat(64) }), SECRET, CLIENT_ID, now)).toBeNull();
    expect(await verifyLaunchToken(null, SECRET, CLIENT_ID, now)).toBeNull();
    expect(await verifyLaunchToken('a.b', SECRET, CLIENT_ID, now)).toBeNull();
  });
});

describe('api', () => {
  it('sends the bearer token and turns the error envelope into DZBuildError', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init! };
      return jsonResponse(403, { error: { code: 'forbidden', message: 'Missing scope: orders:write' }, meta: { request_id: 'r1' } });
    };
    await expect(api(fetchImpl, 'tok', 'GET', '/orders')).rejects.toSatisfy(
      (e: unknown) => e instanceof DZBuildError && e.status === 403 && e.code === 'forbidden' && e.requestId === 'r1',
    );
    expect(seen!.url).toBe('https://api.dzbuild.app/v1/orders');
    expect(new Headers(seen!.init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('reads retry_after from a 429 envelope', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(429, { error: { code: 'rate_limited', message: 'slow down', retry_after: 7 } });
    await expect(api(fetchImpl, 'tok', 'GET', '/orders')).rejects.toMatchObject({ status: 429, retryAfter: 7 });
  });

  it('refuses a write without an Idempotency-Key and sends it when given', async () => {
    const ok: typeof fetch = async () => jsonResponse(200, { data: {} });
    await expect(api(ok, 'tok', 'POST', '/orders', {})).rejects.toThrow(/Idempotency-Key/);
    let seen: RequestInit | undefined;
    const capture: typeof fetch = async (_url, init) => { seen = init; return jsonResponse(200, { data: {} }); };
    await api(capture, 'tok', 'POST', '/orders', { a: 1 }, 'job-42');
    const headers = new Headers(seen!.headers);
    expect(headers.get('idempotency-key')).toBe('job-42');
    expect(headers.get('content-type')).toBe('application/json');
    expect(seen!.body).toBe('{"a":1}');
  });
});
