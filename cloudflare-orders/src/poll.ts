// The cron: fetch the new orders of every installed store, then send one Telegram message per
// order and per stored webhook event. Every step converges on retry, so a crashed tick repeats safely.
import { api, DZBuildError } from './dzbuild';

const STORES_PER_TICK = 15;
const PAGE_SIZE = 50;
const MAX_PAGES = 5;
const MESSAGES_PER_TICK = 30;
const MAX_ATTEMPTS = 5;

interface OrderSummary {
  id: number;
  order_number: string | null;
  status: string;
  total: number;
  customer_name: string | null;
  created_at: string;
}

interface OrdersPage {
  data: { items: OrderSummary[]; has_more?: boolean; next_cursor?: string | null };
}

interface StoreRow {
  store_id: number;
  access_token: string;
  since: string;
}

interface DueOrder {
  store_id: number;
  order_id: number;
  summary: string;
  store_name: string | null;
}

interface DueEvent {
  event_id: string;
  event: string;
  body: string;
  store_id: number;
  store_name: string | null;
}

interface OrderEnvelope {
  data?: { order?: { id?: number; order_number?: string | null; status?: string }; previous_status?: string };
}

interface Job {
  text: string;
  sent: D1PreparedStatement;
  failed: (error: string) => D1PreparedStatement;
}

const unix = () => Math.floor(Date.now() / 1000);
const label = (name: string | null, storeId: number) => name ?? `Store ${storeId}`;

export async function scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  await pollOrders(env);
  await notify(env);
}

async function pollOrders(env: Env): Promise<void> {
  // The first 15 stores by id every minute; past 15 stores, add a polled_at column and order by it.
  const { results: stores } = await env.DB.prepare(
    'SELECT store_id, access_token, COALESCE(orders_since, installed_at) AS since FROM installs WHERE access_token IS NOT NULL ORDER BY store_id LIMIT ?',
  ).bind(STORES_PER_TICK).all<StoreRow>();
  for (const store of stores) {
    try {
      await pollStore(env, store);
    } catch (err) {
      if (err instanceof DZBuildError && err.status === 401) {
        await env.DB.prepare('UPDATE installs SET access_token = NULL, uninstalled_at = ? WHERE store_id = ? AND access_token = ?')
          .bind(new Date().toISOString(), store.store_id, store.access_token).run();
        console.error(`store ${store.store_id}: token refused (401), marked uninstalled`);
        continue;
      }
      console.error(`store ${store.store_id}: poll skipped this tick`, err);
    }
  }
}

// The list is newest first, so a full page is followed through next_cursor before the boundary moves.
async function pollStore(env: Env, store: StoreRow): Promise<void> {
  const query = new URLSearchParams({ since: store.since, limit: String(PAGE_SIZE) });
  const orders: OrderSummary[] = [];
  for (let pages = 1; ; pages++) {
    const { data: page } = await api<OrdersPage>(fetch, store.access_token, 'GET', `/orders?${query}`);
    orders.push(...page.items);
    if (!page.has_more || !page.next_cursor) break;
    if (pages === MAX_PAGES) {
      console.error(`store ${store.store_id}: more than ${MAX_PAGES * PAGE_SIZE} new orders in one tick, the older ones are skipped`);
      break;
    }
    query.set('cursor', page.next_cursor);
  }
  if (orders.length === 0) return;
  const seenAt = unix();
  const newest = orders.reduce((max, o) => (o.created_at > max ? o.created_at : max), orders[0].created_at);
  await env.DB.batch([
    ...orders.map((o) => env.DB.prepare('INSERT OR IGNORE INTO seen_orders (store_id, order_id, created_at, summary, first_seen) VALUES (?, ?, ?, ?, ?)')
      .bind(store.store_id, o.id, o.created_at, JSON.stringify(o), seenAt)),
    env.DB.prepare('UPDATE installs SET orders_since = ? WHERE store_id = ?').bind(newest, store.store_id),
  ]);
}

async function notify(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error('Telegram is off: set the TELEGRAM_BOT_TOKEN secret and the TELEGRAM_CHAT_ID variable. Orders are still recorded.');
    return;
  }
  const { results: orders } = await env.DB.prepare(
    `SELECT o.store_id, o.order_id, o.summary, i.store_name FROM seen_orders o LEFT JOIN installs i ON i.store_id = o.store_id
     WHERE o.notified_at IS NULL AND o.attempts < ? ORDER BY o.first_seen LIMIT ?`,
  ).bind(MAX_ATTEMPTS, MESSAGES_PER_TICK).all<DueOrder>();
  const { results: events } = await env.DB.prepare(
    `SELECT w.event_id, w.event, w.body, w.store_id, i.store_name FROM webhook_inbox w LEFT JOIN installs i ON i.store_id = w.store_id
     WHERE w.processed_at IS NULL AND w.attempts < ? ORDER BY w.received_at LIMIT ?`,
  ).bind(MAX_ATTEMPTS, MESSAGES_PER_TICK).all<DueEvent>();
  const jobs: Job[] = [
    ...orders.map((row) => ({
      text: orderText(label(row.store_name, row.store_id), JSON.parse(row.summary) as OrderSummary),
      sent: env.DB.prepare('UPDATE seen_orders SET notified_at = ? WHERE store_id = ? AND order_id = ?').bind(unix(), row.store_id, row.order_id),
      failed: (error: string) => env.DB.prepare('UPDATE seen_orders SET attempts = attempts + 1, last_error = ? WHERE store_id = ? AND order_id = ?').bind(error, row.store_id, row.order_id),
    })),
    ...events.map((row) => ({
      text: eventText(label(row.store_name, row.store_id), row.event, JSON.parse(row.body) as OrderEnvelope),
      sent: env.DB.prepare('UPDATE webhook_inbox SET processed_at = ? WHERE event_id = ?').bind(unix(), row.event_id),
      failed: (error: string) => env.DB.prepare('UPDATE webhook_inbox SET attempts = attempts + 1, last_error = ? WHERE event_id = ?').bind(error, row.event_id),
    })),
  ];
  // 15 order requests plus 30 messages stay under the free plan's 50 external subrequests per run.
  for (const job of jobs.slice(0, MESSAGES_PER_TICK)) {
    const error = await sendTelegram(env, job.text);
    if (error !== null) console.error(`telegram: ${error}`);
    await (error === null ? job.sent : job.failed(error)).run();
  }
}

function orderText(store: string, o: OrderSummary): string {
  const customer = o.customer_name ? `\nCustomer: ${o.customer_name}` : '';
  return `New order ${o.order_number ?? `#${o.id}`} at ${store}${customer}\nTotal: ${o.total} DZD, status: ${o.status}`;
}

function eventText(store: string, event: string, envelope: OrderEnvelope): string {
  const order = envelope.data?.order ?? {};
  const from = envelope.data?.previous_status ? `${envelope.data.previous_status} to ` : '';
  return `Order ${order.order_number ?? `#${order.id ?? '?'}`} at ${store}: ${from}${order.status ?? event.slice('order.'.length)} (${event})`;
}

// null on success, else one line for last_error. Telegram answers ok: false with a description on every refusal.
async function sendTelegram(env: Env, text: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    return body.ok === true ? null : `${res.status} ${body.description ?? 'unexpected answer'}`;
  } catch (err) {
    return `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
