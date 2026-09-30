// The DZBuild contract in one file: PKCE, the authorize URL, the token exchange, webhook and
// launch-token verification, and API calls. Web Crypto only, so it runs in workerd and in Node.
// Facts come from https://dzbuild.dev/llms.txt.

export const AUTHORIZE_URL = 'https://dzbuild.com/oauth/apps/authorize';
export const TOKEN_URL = 'https://dzbuild.com/oauth/apps/token';
export const API_BASE = 'https://api.dzbuild.app/v1';
// Workers fetch sends no User-Agent, and the dzbuild.com edge challenges a POST that has none.
const USER_AGENT = 'dzbuild-app/1.0 (+https://dzbuild.dev)';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{1,64}$/;
const encoder = new TextEncoder();

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  scope: string;
  store_id: number;
  install_id: number;
  stores: { store_id: number; store_name: string; install_id: number; access_token: string }[];
}

export interface LaunchClaims {
  iss: 'dzbuild';
  aud: string;
  sub: string;
  store_id: number;
  install_id: number;
  is_owner: boolean;
  iat: number;
  exp: number;
  jti: string;
}

interface ApiEnvelope {
  error?: { code?: string; message?: string; retry_after?: number };
  meta?: { request_id?: string };
}

export class DZBuildError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  retryAfter?: number;

  constructor(status: number, code?: string, message?: string, requestId?: string, retryAfter?: number) {
    super(`${status} ${code || 'error'}: ${message || ''}`.trim());
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64url(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJson(b64: string): Record<string, unknown> | null {
  const bytes = fromB64url(b64);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return {} as T;
  }
}

export async function challengeFor(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await challengeFor(verifier) };
}

export function authorizeUrl(p: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export async function exchangeCode(
  fetchImpl: typeof fetch,
  p: { code: string; verifier: string; redirectUri: string; clientId: string; clientSecret: string },
): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
      client_id: p.clientId,
      client_secret: p.clientSecret,
    }),
  });
  const body = await readJson<{ error?: string; error_description?: string }>(res);
  if (!res.ok) throw new DZBuildError(res.status, body.error, body.error_description);
  return body as TokenResponse;
}

// True only when v1 is the HMAC-SHA256 of "<t>.<raw body>" and t is within the window (300 s).
export async function verifyWebhook(rawBody: string, header: string | null, secret: string, now = Date.now() / 1000): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const pair of (header ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) parts[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  const { t, v1 } = parts;
  if (!t || !/^\d+$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const signature = Uint8Array.from({ length: 32 }, (_, i) => parseInt(v1.slice(i * 2, i * 2 + 2), 16));
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, encoder.encode(`${t}.${rawBody}`));
  return valid && Math.abs(now - Number(t)) <= 300;
}

// Claims of a valid dz_launch token, or null. The caller still refuses a jti seen in the last 5 minutes.
export async function verifyLaunchToken(jwt: string | null, secret: string, clientId: string, now = Math.floor(Date.now() / 1000)): Promise<LaunchClaims | null> {
  const parts = (jwt ?? '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const signature = fromB64url(sig);
  if (!signature || !(await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, encoder.encode(`${head}.${body}`)))) return null;
  const header = decodeJson(head);
  const claims = decodeJson(body) as LaunchClaims | null;
  if (!header || !claims) return null;
  if (header.alg !== 'HS256' || claims.iss !== 'dzbuild' || claims.aud !== clientId) return null;
  if (!Number.isInteger(claims.exp) || claims.exp < now || claims.iat > now + 60) return null;
  return claims;
}

// One call to https://api.dzbuild.app/v1. Writes need an idempotencyKey; reuse it on every retry.
export async function api<T = unknown>(fetchImpl: typeof fetch, token: string, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': USER_AGENT };
  if (WRITE_METHODS.has(method)) {
    const key = idempotencyKey ?? '';
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw new Error('An Idempotency-Key is required for POST, PATCH and DELETE: at most 64 characters of A-Z a-z 0-9 _ - : .');
    }
    headers['idempotency-key'] = key;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetchImpl(`${API_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await readJson<ApiEnvelope>(res);
  if (!res.ok) {
    throw new DZBuildError(res.status, json.error?.code, json.error?.message, json.meta?.request_id, json.error?.retry_after);
  }
  return json as T;
}
