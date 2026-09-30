CREATE TABLE installs (
  store_id INTEGER PRIMARY KEY,
  install_id INTEGER NOT NULL,
  store_name TEXT,
  access_token TEXT,
  scopes TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  uninstalled_at TEXT
);
CREATE TABLE oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE launch_jti (jti TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, event TEXT NOT NULL, store_id INTEGER NOT NULL, received_at INTEGER NOT NULL);
