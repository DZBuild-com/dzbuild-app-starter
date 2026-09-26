// The DZBuild contract in one file: PKCE, the authorize URL, the token exchange, webhook and
// launch-token verification, and API calls. Facts come from https://dzbuild.dev/llms.txt.
import crypto from 'node:crypto';

export const AUTHORIZE_URL = 'https://dzbuild.com/oauth/apps/authorize';
export const TOKEN_URL = 'https://dzbuild.com/oauth/apps/token';
export const API_BASE = 'https://api.dzbuild.app/v1';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{1,64}$/;

export class DZBuildError extends Error {
  constructor(status, code, message, requestId, retryAfter) {
    super(`${status} ${code || 'error'}: ${message || ''}`.trim());
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

export function challengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return {verifier, challenge: challengeFor(verifier)};
}

export function authorizeUrl({clientId, redirectUri, scope, state, challenge}) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export async function exchangeCode({code, verifier, redirectUri, clientId, clientSecret, fetchImpl = fetch}) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'},
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new DZBuildError(res.status, body.error, body.error_description);
  return body;
}

function parseSignature(header) {
  const parts = {};
  for (const pair of String(header || '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) parts[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return parts;
}

// True only when v1 is the HMAC-SHA256 of "<t>.<raw body>" and t is within the window (300 s).
export function verifyWebhook({secret, signatureHeader, rawBody, now = Date.now() / 1000, window = 300}) {
  const {t, v1} = parseSignature(signatureHeader);
  if (!t || !v1 || !/^\d+$/.test(t)) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  if (v1.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) return false;
  return Math.abs(now - Number(t)) <= window;
}

// Claims of a valid dz_launch token, or null. The caller still refuses a jti seen in the last 5 minutes.
export function verifyLaunchToken({jwt, secret, clientId, now = Math.floor(Date.now() / 1000)}) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256' || claims.iss !== 'dzbuild' || claims.aud !== clientId) return null;
  if (!Number.isInteger(claims.exp) || claims.exp < now || claims.iat > now + 60) return null;
  return claims;
}

// One call to https://api.dzbuild.app/v1. Writes need an idempotencyKey; reuse it on every retry.
export async function api(token, method, path, {body, idempotencyKey, fetchImpl = fetch} = {}) {
  const headers = {authorization: `Bearer ${token}`, accept: 'application/json'};
  if (WRITE_METHODS.has(method)) {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey || '')) {
      throw new Error('idempotencyKey is required for POST, PATCH and DELETE: at most 64 characters of A-Z a-z 0-9 _ - : .');
    }
    headers['idempotency-key'] = idempotencyKey;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetchImpl(`${API_BASE}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  const json = await res.json();
  if (!res.ok) {
    throw new DZBuildError(res.status, json.error?.code, json.error?.message, json.meta?.request_id, json.error?.retry_after);
  }
  return json;
}
