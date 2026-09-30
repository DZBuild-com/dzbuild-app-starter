#!/usr/bin/env node
import {writeFileSync} from 'node:fs';

const out = new URL('../data/docs-index.json', import.meta.url);
const loader = await import('../dist/src/index-loader.js').catch(() => {
  console.error('dist/ is missing: run `npm run build` first');
  process.exit(1);
});
const {INDEX_URL, DocsIndexSchema} = loader;

const res = await fetch(INDEX_URL, {signal: AbortSignal.timeout(10_000)});
if (!res.ok) {
  console.error(`${INDEX_URL} answered HTTP ${res.status}; data/docs-index.json left untouched`);
  process.exit(1);
}
const parsed = DocsIndexSchema.safeParse(await res.json());
if (!parsed.success) {
  console.error(`${INDEX_URL} does not match the schema; data/docs-index.json left untouched`);
  console.error(JSON.stringify(parsed.error.issues, null, 2));
  process.exit(1);
}
const {data} = parsed;
writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
console.log(`data/docs-index.json refreshed: kit ${data.kit_version}, ${data.docs.length} pages, ${data.api.length} operations, ${data.examples.length} examples`);
