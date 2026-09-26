import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {api, authorizeUrl, challengeFor, DZBuildError, pkcePair, verifyLaunchToken, verifyWebhook} from '../src/dzbuild.js';

const SECRET = 'a'.repeat(64);
const CLIENT_ID = 'dzapp_0123456789abcdef0123';

test('PKCE challenge matches the RFC 7636 test vector', () => {
  assert.equal(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('pkcePair gives a 43 character base64url verifier and a 43 character challenge', () => {
  const {verifier, challenge} = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9\-_]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9\-_]{43}$/);
  assert.equal(challengeFor(verifier), challenge);
});

test('authorizeUrl carries every required parameter, encoded', () => {
  const url = new URL(authorizeUrl({
    clientId: CLIENT_ID, redirectUri: 'https://app.example.com/callback', scope: 'orders:read products:read',
    state: 'abc', challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  }));
  assert.equal(url.origin + url.pathname, 'https://dzbuild.com/oauth/apps/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'orders:read products:read');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.search.includes('redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback'));
});

function sign(rawBody, t) {
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.`).update(rawBody).digest('hex');
  return `t=${t},v1=${v1}`;
}

test('verifyWebhook accepts a fresh signed body', () => {
  const raw = Buffer.from('{"id":"evt_1","event":"order.created"}');
  assert.equal(verifyWebhook({secret: SECRET, signatureHeader: sign(raw, 1000), rawBody: raw, now: 1010}), true);
});

test('verifyWebhook refuses a body that changed by one byte', () => {
  const raw = Buffer.from('{"id":"evt_1","event":"order.created"}');
  const tampered = Buffer.from('{"id":"evt_1","event":"order.deleted"}');
  assert.equal(verifyWebhook({secret: SECRET, signatureHeader: sign(raw, 1000), rawBody: tampered, now: 1010}), false);
});

test('verifyWebhook refuses a timestamp outside the 5 minute window', () => {
  const raw = Buffer.from('{}');
  assert.equal(verifyWebhook({secret: SECRET, signatureHeader: sign(raw, 1000), rawBody: raw, now: 1301}), false);
  assert.equal(verifyWebhook({secret: SECRET, signatureHeader: sign(raw, 1000), rawBody: raw, now: 1300}), true);
});

test('verifyWebhook refuses a malformed header', () => {
  const raw = Buffer.from('{}');
  assert.equal(verifyWebhook({secret: SECRET, signatureHeader: 'v1=abc', rawBody: raw}), false);
  assert.equal(verifyWebhook({secret: SECRET, signatureHeader: '', rawBody: raw}), false);
});

function launchToken(claims, {alg = 'HS256', secret = SECRET} = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({alg, typ: 'JWT'});
  const body = b64(claims);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const now = 1_700_000_000;
const goodClaims = {iss: 'dzbuild', aud: CLIENT_ID, sub: '15', store_id: 141, install_id: 7, is_owner: true, iat: now, exp: now + 300, jti: '0123456789abcdef'};

test('verifyLaunchToken returns the claims of a valid token', () => {
  const claims = verifyLaunchToken({jwt: launchToken(goodClaims), secret: SECRET, clientId: CLIENT_ID, now});
  assert.equal(claims.store_id, 141);
  assert.equal(claims.install_id, 7);
});

test('verifyLaunchToken refuses the wrong audience, an expired token, a wrong alg and a bad signature', () => {
  assert.equal(verifyLaunchToken({jwt: launchToken({...goodClaims, aud: 'dzapp_other'}), secret: SECRET, clientId: CLIENT_ID, now}), null);
  assert.equal(verifyLaunchToken({jwt: launchToken(goodClaims), secret: SECRET, clientId: CLIENT_ID, now: now + 301}), null);
  assert.equal(verifyLaunchToken({jwt: launchToken(goodClaims, {alg: 'none'}), secret: SECRET, clientId: CLIENT_ID, now}), null);
  assert.equal(verifyLaunchToken({jwt: launchToken(goodClaims, {secret: 'b'.repeat(64)}), secret: SECRET, clientId: CLIENT_ID, now}), null);
});

test('api sends the bearer token and turns the error envelope into DZBuildError', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, init});
    return {ok: false, status: 403, json: async () => ({error: {code: 'forbidden', message: 'Missing scope: orders:write'}, meta: {request_id: 'r1', api_version: 'v1'}})};
  };
  await assert.rejects(
    api('dzpk_live_x', 'GET', '/orders', {fetchImpl}),
    (e) => e instanceof DZBuildError && e.status === 403 && e.code === 'forbidden' && e.requestId === 'r1',
  );
  assert.equal(calls[0].url, 'https://api.dzbuild.app/v1/orders');
  assert.equal(calls[0].init.headers.authorization, 'Bearer dzpk_live_x');
});

test('api refuses a write without an Idempotency-Key and sends it when given', async () => {
  await assert.rejects(api('t', 'POST', '/orders', {body: {}, fetchImpl: async () => ({ok: true, status: 200, json: async () => ({})})}), /idempotencyKey is required/);
  let seen;
  await api('t', 'POST', '/orders', {body: {a: 1}, idempotencyKey: 'job-42', fetchImpl: async (_url, init) => { seen = init; return {ok: true, status: 200, json: async () => ({data: {}})}; }});
  assert.equal(seen.headers['idempotency-key'], 'job-42');
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.equal(seen.body, '{"a":1}');
});
