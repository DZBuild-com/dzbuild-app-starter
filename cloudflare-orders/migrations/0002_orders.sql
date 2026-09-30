CREATE TABLE seen_orders (
  store_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  notified_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (store_id, order_id)
);
ALTER TABLE installs ADD COLUMN orders_since TEXT;
CREATE TABLE webhook_inbox (
  event_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  store_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
