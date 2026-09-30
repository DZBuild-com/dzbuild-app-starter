#!/usr/bin/env node
// Every cloudflare-*/src/dzbuild.ts is a byte-identical copy of one file. Exit 1 when any copy drifts.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const copies = readdirSync(root)
  .filter((name) => name.startsWith('cloudflare-'))
  .map((name) => join(name, 'src', 'dzbuild.ts'))
  .filter((file) => existsSync(join(root, file)));

if (copies.length === 0) {
  console.error('sync-check: no cloudflare-*/src/dzbuild.ts found');
  process.exit(1);
}
const digests = new Map();
for (const file of copies) {
  const sha = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  digests.set(file, sha);
  console.log(`${sha}  ${file}`);
}
if (new Set(digests.values()).size > 1) {
  console.error('sync-check: src/dzbuild.ts differs between presets; copy one file over the others');
  process.exit(1);
}
console.log(`sync-check: ${copies.length} identical copy(ies)`);
