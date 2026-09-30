import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {search, tokenize, type Doc} from '../src/search.js';

const index = JSON.parse(readFileSync(new URL('../../test/fixtures/index.json', import.meta.url), 'utf8'));
const docs: Doc[] = index.docs;

test('tokenize keeps Arabic and accented letters and lowercases', () => {
  assert.deepEqual(tokenize('Flux PKCE éphémère, التطبيق 2.0'), ['flux', 'pkce', 'éphémère', 'التطبيق', '2', '0']);
  assert.deepEqual(tokenize('   '), []);
});

test('search finds every locale of a page by a shared token', () => {
  const hits = search(docs, {query: 'pkce'});
  assert.deepEqual(hits.map(h => `${h.locale}/${h.id}`).sort(), ['ar/oauth', 'en/oauth', 'fr/oauth']);
});

test('a title hit outranks a text-only hit', () => {
  const hits = search(docs, {query: 'webhooks'});
  assert.equal(hits[0].id, 'webhooks');
  assert.ok(hits[0].score > hits[1].score);
});

test('locale filter keeps one locale', () => {
  assert.deepEqual(search(docs, {query: 'PKCE', locale: 'fr'}).map(h => h.locale), ['fr']);
});

test('an Arabic query reaches the Arabic page', () => {
  assert.equal(search(docs, {query: 'التطبيق'})[0].locale, 'ar');
});

test('limit caps the result count', () => {
  assert.equal(search(docs, {query: 'PKCE', limit: 1}).length, 1);
});

test('no match and an empty query give an empty list', () => {
  assert.deepEqual(search(docs, {query: 'zzzzqqq'}), []);
  assert.deepEqual(search(docs, {query: ' '}), []);
});

test('snippet is at most 160 characters and carries the match', () => {
  const [hit] = search(docs, {query: 'X-DZ-Signature'});
  assert.ok(hit.snippet.length <= 160, hit.snippet);
  assert.match(hit.snippet, /X-DZ-Signature/);
});

test('a result carries the source URLs', () => {
  const [hit] = search(docs, {query: 'retries'});
  assert.equal(hit.url, 'https://dzbuild.dev/webhooks');
  assert.equal(hit.md_url, 'https://dzbuild.dev/webhooks.md');
});
