import {readFileSync} from 'node:fs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import {errorMessage, fetchMarkdown, type DocsIndex} from './index-loader.js';
import {search} from './search.js';

const {version} = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const LOCALES = ['en', 'ar', 'fr'] as const;
const readOnly = {readOnlyHint: true};

export interface ServerOptions {
  fetch?: typeof globalThis.fetch;
}

export function createServer(index: DocsIndex, {fetch = globalThis.fetch}: ServerOptions = {}): McpServer {
  const server = new McpServer({name: 'dzbuild-docs', version});
  const answer = (payload: object) => ({
    content: [{type: 'text' as const, text: JSON.stringify({kit_version: index.kit_version, ...payload}, null, 2)}],
  });
  const refuse = (text: string) => ({content: [{type: 'text' as const, text}], isError: true});

  server.registerTool(
    'search_docs',
    {
      title: 'Search the DZBuild developer docs',
      description: 'Full-text search over the DZBuild developer documentation at dzbuild.dev. Returns page ids, locales, URLs and a snippet. Call get_document with an id to read a whole page.',
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        locale: z.enum(LOCALES).optional().describe('Restrict to one locale; every locale when omitted'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 10'),
      }),
      annotations: readOnly,
    },
    async ({query, locale, limit}) => answer({query, locale: locale ?? 'all', results: search(index.docs, {query, locale, limit})})
  );

  server.registerTool(
    'get_document',
    {
      title: 'Read a DZBuild docs page',
      description: 'Returns one documentation page as Markdown: fetched live from dzbuild.dev when reachable, otherwise the copy inside the docs index. locale defaults to en.',
      inputSchema: z.object({id: z.string().min(1).max(100), locale: z.enum(LOCALES).optional()}),
      annotations: readOnly,
    },
    async ({id, locale = 'en'}) => {
      const doc = index.docs.find(d => d.id === id && d.locale === locale);
      if (!doc) return refuse(`No page "${id}" in locale ${locale}. Known ids: ${[...new Set(index.docs.map(d => d.id))].join(', ')}`);
      let content = doc.text;
      let content_from: 'md_url' | 'index' = 'index';
      let live_error = doc.md_url ? undefined : 'the index carries no md_url for this page';
      if (doc.md_url) {
        try {
          content = await fetchMarkdown(doc.md_url, fetch);
          content_from = 'md_url';
        } catch (err) {
          live_error = errorMessage(err);
        }
      }
      return answer({id, locale, title: doc.title, description: doc.description, url: doc.url, md_url: doc.md_url, content_from, live_error, content});
    }
  );

  server.registerTool(
    'get_api_operation',
    {
      title: 'Describe an API operation',
      description: 'Returns one operation of the DZBuild API for apps by its OpenAPI operationId: method, path, scopes and description.',
      inputSchema: z.object({operationId: z.string().min(1).max(100)}),
      annotations: readOnly,
    },
    async ({operationId}) => {
      const operation = index.api.find(a => a.operationId === operationId);
      if (!operation) return refuse(`No operation "${operationId}". Known operationIds: ${index.api.map(a => a.operationId).join(', ')}`);
      return answer({openapi_info_version: index.openapi_info_version, ...operation});
    }
  );

  server.registerTool(
    'get_example',
    {
      title: 'Get a code example',
      description: 'Returns one code example from the DZBuild developer kit by id.',
      inputSchema: z.object({id: z.string().min(1).max(100)}),
      annotations: readOnly,
    },
    async ({id}) => {
      const example = index.examples.find(e => e.id === id);
      if (!example) return refuse(`No example "${id}". Known ids: ${index.examples.map(e => e.id).join(', ')}`);
      return answer(example);
    }
  );

  return server;
}
