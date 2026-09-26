// One record per store_id in data/tokens.json. Replace with your database; encrypt tokens at rest.
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(process.env.DZBUILD_TOKEN_FILE || 'data/tokens.json');

export function loadStores() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

export function saveStore(record) {
  const stores = loadStores();
  stores[record.store_id] = {...stores[record.store_id], ...record};
  fs.mkdirSync(path.dirname(FILE), {recursive: true});
  fs.writeFileSync(FILE, JSON.stringify(stores, null, 2) + '\n', {mode: 0o600});
}
