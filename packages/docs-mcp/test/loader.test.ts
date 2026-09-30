import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, utimesSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadIndex, fetchMarkdown, DocsIndexSchema, INDEX_URL, CACHE_TTL_MS} from '../src/index-loader.js';

const fixturePath = new URL('../../test/fixtures/index.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'dzbuild-docs-mcp-test-'));
after(() => rmSync(dir, {recursive: true, force: true}));

let n = 0;
const cacheFile = () => join(dir, `cache-${++n}.json`);
const quiet = () => {};
const indexWith = (kit_version: string) => ({...fixture, kit_version});
const serving = (body: unknown, status = 200) => async (url: string | URL | Request, init?: RequestInit) => {
  assert.equal(String(url), INDEX_URL);
  assert.ok(init?.signal instanceof AbortSignal, 'fetch carries a timeout signal');
  return new Response(JSON.stringify(body), {status});
};
const offline = async () => { throw new Error('offline'); };
const neverCalled = async () => { throw new Error('fetch must not be called'); };
const backdate = (file: string) => {
  const old = (Date.now() - CACHE_TTL_MS - 60_000) / 1000;
  utimesSync(file, old, old);
};
const opts = (cachePath: string, fetch: typeof globalThis.fetch) => ({cachePath, fetch, bundledPath: fixturePath, log: quiet});

test('a cache younger than 24 h wins without fetching', async () => {
  const cachePath = cacheFile();
  writeFileSync(cachePath, JSON.stringify(indexWith('cached')));
  const {index, from} = await loadIndex(opts(cachePath, neverCalled));
  assert.equal(from, 'cache');
  assert.equal(index.kit_version, 'cached');
});

test('an expired cache is refetched and rewritten', async () => {
  const cachePath = cacheFile();
  writeFileSync(cachePath, JSON.stringify(indexWith('cached')));
  backdate(cachePath);
  const {index, from} = await loadIndex(opts(cachePath, serving(indexWith('network'))));
  assert.equal(from, 'network');
  assert.equal(index.kit_version, 'network');
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).kit_version, 'network');
});

test('a fetch failure falls back to the stale cache', async () => {
  const cachePath = cacheFile();
  writeFileSync(cachePath, JSON.stringify(indexWith('cached')));
  backdate(cachePath);
  const {index, from} = await loadIndex(opts(cachePath, offline));
  assert.equal(from, 'stale-cache');
  assert.equal(index.kit_version, 'cached');
});

test('a fetch failure with no cache falls back to the bundled index', async () => {
  const cachePath = cacheFile();
  const {index, from} = await loadIndex(opts(cachePath, offline));
  assert.equal(from, 'bundled');
  assert.equal(index.kit_version, fixture.kit_version);
  assert.equal(existsSync(cachePath), false);
});

test('a non-2xx answer and an invalid body count as failures', async () => {
  assert.equal((await loadIndex(opts(cacheFile(), serving({}, 500)))).from, 'bundled');
  assert.equal((await loadIndex(opts(cacheFile(), serving({kit_version: 1, docs: 'no'})))).from, 'bundled');
});

test('a corrupt cache file is treated as a miss', async () => {
  const cachePath = cacheFile();
  writeFileSync(cachePath, '{not json');
  const {from} = await loadIndex(opts(cachePath, serving(indexWith('network'))));
  assert.equal(from, 'network');
});

test('fetchMarkdown only ever fetches https://dzbuild.dev/ URLs', async () => {
  const seen: string[] = [];
  const fake = async (url: string | URL | Request) => { seen.push(String(url)); return new Response('# OAuth\n', {status: 200}); };
  assert.equal(await fetchMarkdown('https://dzbuild.dev/oauth.md', fake), '# OAuth\n');
  await assert.rejects(fetchMarkdown('https://example.org/outside.md', fake), /dzbuild\.dev/);
  await assert.rejects(fetchMarkdown('http://dzbuild.dev/oauth.md', fake), /dzbuild\.dev/);
  await assert.rejects(fetchMarkdown('https://dzbuild.dev.example.org/oauth.md', fake), /dzbuild\.dev/);
  await assert.rejects(fetchMarkdown('https://dzbuild.dev/missing.md', async () => new Response('', {status: 404})), /404/);
  assert.deepEqual(seen, ['https://dzbuild.dev/oauth.md']);
});

test('the bundled data/docs-index.json validates against the schema', () => {
  const bundled = JSON.parse(readFileSync(new URL('../../data/docs-index.json', import.meta.url), 'utf8'));
  const parsed = DocsIndexSchema.safeParse(bundled);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.ok(parsed.data!.docs.length >= 3);
  assert.ok(parsed.data!.api.some(a => a.operationId === 'whoami'));
});
