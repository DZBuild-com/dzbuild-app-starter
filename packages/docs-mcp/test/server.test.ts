import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../src/index.js';
import {DocsIndexSchema} from '../src/index-loader.js';

const index = DocsIndexSchema.parse(JSON.parse(readFileSync(new URL('../../test/fixtures/index.json', import.meta.url), 'utf8')));
const fetched: string[] = [];
let online = true;
const fetch = async (url: string | URL | Request) => {
  fetched.push(String(url));
  if (!online) throw new Error('offline');
  return new Response(`# Live ${url}\n`, {status: 200});
};

const server = createServer(index, {fetch});
const client = new Client({name: 'docs-mcp-test', version: '0.0.0'});
type ToolResult = {content: {type: string; text: string}[]; isError?: boolean};
const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({name, arguments: args})) as ToolResult;
  assert.equal(result.content[0].type, 'text');
  return {result, json: result.isError ? null : JSON.parse(result.content[0].text)};
};

before(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});
after(async () => {
  await client.close();
  await server.close();
});

test('tools/list names exactly the four tools', async () => {
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['get_api_operation', 'get_document', 'get_example', 'search_docs']);
});

test('search_docs answers JSON with kit_version and source URLs', async () => {
  const {json} = await call('search_docs', {query: 'PKCE'});
  assert.equal(json.kit_version, index.kit_version);
  assert.equal(json.results.length, 3);
  assert.ok(json.results.every((r: {url: string}) => r.url.startsWith('https://')));
});

test('search_docs honours locale and limit', async () => {
  const {json} = await call('search_docs', {query: 'PKCE', locale: 'fr', limit: 1});
  assert.deepEqual(json.results.map((r: {locale: string}) => r.locale), ['fr']);
});

test('get_document serves the live Markdown when dzbuild.dev answers', async () => {
  fetched.length = 0;
  const {json} = await call('get_document', {id: 'oauth', locale: 'ar'});
  assert.equal(json.kit_version, index.kit_version);
  assert.equal(json.content_from, 'md_url');
  assert.equal(json.content, '# Live https://dzbuild.dev/ar/oauth.md\n');
  assert.equal(json.url, 'https://dzbuild.dev/ar/oauth');
  assert.deepEqual(fetched, ['https://dzbuild.dev/ar/oauth.md']);
});

test('get_document falls back to the index text offline and defaults to en', async () => {
  online = false;
  try {
    const {json} = await call('get_document', {id: 'oauth'});
    assert.equal(json.locale, 'en');
    assert.equal(json.content_from, 'index');
    assert.match(json.content, /code_verifier/);
  } finally {
    online = true;
  }
});

test('get_document never fetches a Markdown twin outside dzbuild.dev', async () => {
  fetched.length = 0;
  const {json} = await call('get_document', {id: 'outside'});
  assert.equal(json.content_from, 'index');
  assert.deepEqual(fetched, []);
});

test('unknown ids answer isError with the known ids', async () => {
  const doc = await call('get_document', {id: 'nope'});
  assert.equal(doc.result.isError, true);
  assert.match(doc.result.content[0].text, /oauth/);
  const op = await call('get_api_operation', {operationId: 'nope'});
  assert.equal(op.result.isError, true);
  assert.match(op.result.content[0].text, /whoami/);
  const ex = await call('get_example', {id: 'nope'});
  assert.equal(ex.result.isError, true);
  assert.match(ex.result.content[0].text, /first-call-whoami/);
});

test('get_api_operation and get_example return the entry with kit_version', async () => {
  const op = await call('get_api_operation', {operationId: 'whoami'});
  assert.equal(op.json.path, '/v1/whoami');
  assert.equal(op.json.kit_version, index.kit_version);
  assert.equal(op.json.openapi_info_version, '1.8');
  const ex = await call('get_example', {id: 'first-call-whoami'});
  assert.match(ex.json.code, /whoami/);
  assert.equal(ex.json.kit_version, index.kit_version);
});
