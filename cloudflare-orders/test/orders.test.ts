import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const ORIGIN = 'https://app.example.com';
const ORDERS_URL = 'https://api.dzbuild.app/v1/orders?';
const TELEGRAM_URL = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

async function hmac(secret: string, data: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(data));
}
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// The list envelope of ApiPaginator::format inside ApiResponse::ok: {data: {items, next_cursor, has_more}, meta}.
const page = (items: object[], paging: object = {}) => json(200, { data: { items, has_more: false, next_cursor: null, ...paging }, meta: {} });
const order = (id: number, createdAt: string, extra: object = {}) => ({
  id, order_number: `ORD-${id}`, status: 'pending', payment_status: 'unpaid', payment_method: 'cod', total: 4500,
  customer_name: 'Amine', customer_phone: '0550000000', wilaya_id: 16, commune: 'Alger', delivery_type: 'home', created_at: createdAt, ...extra,
});

interface Call { url: string; init?: RequestInit }
// Stubs the two outbound hosts; each answer is built inside the stub because a Response made in the
// test's request context cannot be read by the handler. Anything else is a test failure.
function stub(orders: (url: URL) => Response, telegram: () => Response = () => json(200, { ok: true, result: {} })): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith(ORDERS_URL)) return orders(new URL(url));
    if (url === TELEGRAM_URL) return telegram();
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}
const ordersCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith(ORDERS_URL));
const telegramCalls = (calls: Call[]) => calls.filter((c) => c.url === TELEGRAM_URL);

async function tick(overrides: Partial<Env> = {}): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '* * * * *' }), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
}

const seedInstall = (storeId: number, installedAt = '2026-09-30T10:00:00.000Z') =>
  env.DB.prepare('INSERT INTO installs (store_id, install_id, store_name, access_token, scopes, installed_at) VALUES (?, 1, ?, ?, ?, ?)')
    .bind(storeId, `Shop ${storeId}`, `tok_${storeId}`, 'orders:read', installedAt).run();
const seenRows = (storeId: number) =>
  env.DB.prepare('SELECT order_id, notified_at, attempts, last_error FROM seen_orders WHERE store_id = ? ORDER BY order_id').bind(storeId)
    .all<{ order_id: number; notified_at: number | null; attempts: number; last_error: string | null }>();
const installRow = (storeId: number) =>
  env.DB.prepare('SELECT access_token, uninstalled_at, orders_since FROM installs WHERE store_id = ?').bind(storeId)
    .first<{ access_token: string | null; uninstalled_at: string | null; orders_since: string | null }>();
const inboxRows = (storeId: number) =>
  env.DB.prepare('SELECT event_id, processed_at, attempts, last_error FROM webhook_inbox WHERE store_id = ?').bind(storeId)
    .all<{ event_id: string; processed_at: number | null; attempts: number; last_error: string | null }>();

async function webhook(body: object, overrides: Partial<Env> = {}): Promise<Response> {
  const raw = JSON.stringify(body);
  const t = now();
  const req = new Request(`${ORIGIN}/webhooks/dzbuild`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dz-signature': `t=${t},v1=${hex(await hmac(env.DZBUILD_SIGNING_SECRET, `${t}.${raw}`))}` },
    body: raw,
  });
  return worker.fetch(req, { ...env, ...overrides });
}
const orderEvent = (id: string, storeId: number, event = 'order.confirmed') => ({
  id, event, created_at: '2026-09-30T12:00:00+00:00', store_id: storeId,
  data: { order: { id: 9, order_number: 'ORD-9', status: event.slice('order.'.length) }, items: [], previous_status: 'pending' },
});

// Storage is isolated per test file, not per test, so every test starts from empty tables.
beforeEach(async () => {
  await env.DB.batch(['installs', 'seen_orders', 'webhook_inbox', 'webhook_events'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('scheduled polling', () => {
  it('records an order once across two ticks and sends one Telegram message', async () => {
    await seedInstall(501);
    const calls = stub(() => page([order(1, '2026-09-30 12:00:00')]));
    await tick();
    await tick();
    expect(ordersCalls(calls)).toHaveLength(2);
    expect(telegramCalls(calls)).toHaveLength(1);
    const rows = (await seenRows(501)).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ order_id: 1, attempts: 0, last_error: null });
    expect(rows[0].notified_at).toBeGreaterThan(0);
    const sent = telegramCalls(calls)[0].init!;
    expect(sent.method).toBe('POST');
    const body = JSON.parse(String(sent.body));
    expect(body.chat_id).toBe(env.TELEGRAM_CHAT_ID);
    expect(body.parse_mode).toBeUndefined();
    for (const part of ['Shop 501', 'ORD-1', 'Amine', '4500', 'pending']) expect(body.text).toContain(part);
  });

  it('asks for orders since installed_at, then since the newest created_at seen', async () => {
    await seedInstall(502, '2026-09-30T10:00:00.000Z');
    const calls = stub(() => page([order(4, '2026-09-30 12:20:00'), order(3, '2026-09-30 12:10:00')]));
    await tick();
    const first = new URL(ordersCalls(calls)[0].url);
    expect(first.searchParams.get('since')).toBe('2026-09-30T10:00:00.000Z');
    expect(first.searchParams.get('limit')).toBe('50');
    expect(first.searchParams.has('cursor')).toBe(false);
    expect((await installRow(502))?.orders_since).toBe('2026-09-30 12:20:00');
    await tick();
    expect(new URL(ordersCalls(calls)[1].url).searchParams.get('since')).toBe('2026-09-30 12:20:00');
  });

  it('follows next_cursor when a page is full so a burst loses no order', async () => {
    await seedInstall(503);
    const calls = stub((url) => (url.searchParams.get('cursor') === 'c2'
      ? page([order(5, '2026-09-30 12:00:00')])
      : page([order(6, '2026-09-30 12:01:00')], { has_more: true, next_cursor: 'c2' })));
    await tick();
    expect(ordersCalls(calls)).toHaveLength(2);
    expect(new URL(ordersCalls(calls)[1].url).searchParams.get('cursor')).toBe('c2');
    expect((await seenRows(503)).results.map((r) => r.order_id)).toEqual([5, 6]);
  });

  it('counts a failed Telegram send and stops after five attempts', async () => {
    await seedInstall(504);
    const calls = stub(() => page([order(7, '2026-09-30 12:00:00')]), () => json(500, { ok: false, description: 'Internal Server Error' }));
    await tick();
    expect((await seenRows(504)).results[0]).toMatchObject({ order_id: 7, notified_at: null, attempts: 1, last_error: '500 Internal Server Error' });
    for (let i = 0; i < 5; i++) await tick();
    expect((await seenRows(504)).results[0]).toMatchObject({ notified_at: null, attempts: 5 });
    expect(telegramCalls(calls)).toHaveLength(5);
  });

  it('treats ok: false as a failure even with a 200 status', async () => {
    await seedInstall(508);
    stub(() => page([order(8, '2026-09-30 12:00:00')]), () => json(200, { ok: false, description: 'Bad Request: chat not found' }));
    await tick();
    expect((await seenRows(508)).results[0]).toMatchObject({ notified_at: null, attempts: 1, last_error: '200 Bad Request: chat not found' });
  });

  it('marks the store uninstalled when its token answers 401 and stops polling it', async () => {
    await seedInstall(505);
    const calls = stub(() => json(401, { error: { code: 'unauthorized', message: 'Invalid token' }, meta: {} }));
    await tick();
    const row = await installRow(505);
    expect(row?.access_token).toBeNull();
    expect(row?.uninstalled_at).toMatch(/^2026-/);
    await tick();
    expect(ordersCalls(calls)).toHaveLength(1);
    expect(telegramCalls(calls)).toHaveLength(0);
  });

  it('leaves the store untouched on 429 and 403', async () => {
    await seedInstall(506);
    for (const answer of [{ status: 429, code: 'rate_limited' }, { status: 403, code: 'app_plan_required' }]) {
      stub(() => json(answer.status, { error: { code: answer.code, retry_after: 7 }, meta: {} }));
      await tick();
      expect((await seenRows(506)).results).toHaveLength(0);
      expect(await installRow(506)).toEqual({ access_token: 'tok_506', uninstalled_at: null, orders_since: null });
    }
  });

  it('records orders without calling Telegram while the bot is not configured', async () => {
    await seedInstall(507);
    const calls = stub(() => page([order(9, '2026-09-30 12:00:00')]));
    await tick({ TELEGRAM_CHAT_ID: '' });
    await tick({ TELEGRAM_BOT_TOKEN: '' });
    expect(telegramCalls(calls)).toHaveLength(0);
    expect((await seenRows(507)).results[0]).toMatchObject({ order_id: 9, notified_at: null, attempts: 0 });
    await tick();
    expect(telegramCalls(calls)).toHaveLength(1);
    expect((await seenRows(507)).results[0].notified_at).toBeGreaterThan(0);
  });

  it('sends at most 30 messages per tick across orders and inbox rows', async () => {
    await seedInstall(509);
    await env.DB.batch(Array.from({ length: 31 }, (_, i) =>
      env.DB.prepare('INSERT INTO seen_orders (store_id, order_id, created_at, summary, first_seen) VALUES (509, ?, ?, ?, ?)')
        .bind(i + 1, '2026-09-30 12:00:00', JSON.stringify(order(i + 1, '2026-09-30 12:00:00')), i)));
    await webhook(orderEvent('evt_cap', 509), { WEBHOOKS: 'on' });
    const calls = stub(() => page([]));
    await tick();
    expect(telegramCalls(calls)).toHaveLength(30);
    expect((await inboxRows(509)).results[0].processed_at).toBeNull();
    await tick();
    expect(telegramCalls(calls)).toHaveLength(32);
    expect((await inboxRows(509)).results[0].processed_at).toBeGreaterThan(0);
  });

  it('polls at most 15 stores per tick', async () => {
    for (let id = 701; id <= 716; id++) await seedInstall(id);
    const calls = stub(() => page([]));
    await tick();
    expect(ordersCalls(calls)).toHaveLength(15);
  });
});

describe('webhook inbox', () => {
  it('drops order events while WEBHOOKS is off but still handles app.uninstalled', async () => {
    await seedInstall(601);
    expect((await webhook(orderEvent('evt_off_1', 601))).status).toBe(200);
    expect((await inboxRows(601)).results).toHaveLength(0);
    const notice = { id: 'evt_off_un', event: 'app.uninstalled', created_at: 't', store_id: 601, data: { install_id: 1, client_id: env.DZBUILD_CLIENT_ID, store_id: 601, uninstalled_at: '2026-09-30T12:00:00+00:00' } };
    expect((await webhook(notice)).status).toBe(200);
    expect((await installRow(601))?.access_token).toBeNull();
  });

  it('stores an order event once while WEBHOOKS is on and the cron sends one message per row', async () => {
    await seedInstall(602);
    const on = { WEBHOOKS: 'on' };
    expect((await webhook(orderEvent('evt_on_1', 602), on)).status).toBe(200);
    expect((await webhook(orderEvent('evt_on_1', 602), on)).status).toBe(200);
    expect((await inboxRows(602)).results).toEqual([{ event_id: 'evt_on_1', processed_at: null, attempts: 0, last_error: null }]);
    const calls = stub(() => page([]));
    await tick();
    await tick();
    expect(telegramCalls(calls)).toHaveLength(1);
    const text = JSON.parse(String(telegramCalls(calls)[0].init!.body)).text as string;
    for (const part of ['Shop 602', 'ORD-9', 'pending', 'confirmed']) expect(text).toContain(part);
    expect((await inboxRows(602)).results[0].processed_at).toBeGreaterThan(0);
  });

  it('counts a failed send on an inbox row', async () => {
    await seedInstall(603);
    await webhook(orderEvent('evt_on_2', 603), { WEBHOOKS: 'on' });
    stub(() => page([]), () => json(500, { ok: false, description: 'Internal Server Error' }));
    await tick();
    expect((await inboxRows(603)).results[0]).toMatchObject({ processed_at: null, attempts: 1, last_error: '500 Internal Server Error' });
  });
});
