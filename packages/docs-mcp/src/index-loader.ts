import {readFileSync, statSync, writeFileSync, renameSync, rmSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as z from 'zod';

export const INDEX_URL = 'https://dzbuild.dev/kit/docs-index.json';
export const DOCS_ORIGIN = 'https://dzbuild.dev/';
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 5000;

const DocSchema = z.looseObject({
  id: z.string(),
  locale: z.string(),
  title: z.string(),
  description: z.string().optional(),
  url: z.string(),
  md_url: z.string().optional(),
  headings: z.array(z.string()),
  text: z.string(),
});

const ApiOperationSchema = z.looseObject({
  operationId: z.string(),
  method: z.string(),
  path: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  url: z.string().optional(),
});

const ExampleSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  language: z.string().optional(),
  code: z.string().optional(),
  url: z.string().optional(),
});

export const DocsIndexSchema = z.looseObject({
  kit_version: z.string(),
  openapi_info_version: z.string().optional(),
  docs: z.array(DocSchema),
  api: z.array(ApiOperationSchema),
  examples: z.array(ExampleSchema),
});

export type DocsIndex = z.infer<typeof DocsIndexSchema>;
export type IndexSource = 'cache' | 'network' | 'stale-cache' | 'bundled';

export interface LoaderOptions {
  fetch?: typeof globalThis.fetch;
  cachePath?: string;
  bundledPath?: string | URL;
  log?: (message: string) => void;
}

export async function loadIndex(options: LoaderOptions = {}): Promise<{index: DocsIndex; from: IndexSource}> {
  const {
    fetch = globalThis.fetch,
    cachePath = join(tmpdir(), 'dzbuild-docs-index.json'),
    bundledPath = new URL('../../data/docs-index.json', import.meta.url),
    log = console.error,
  } = options;
  const cached = readIndexFile(cachePath, log);
  if (cached && Date.now() - cached.mtimeMs < CACHE_TTL_MS) return {index: cached.index, from: 'cache'};
  try {
    const res = await fetch(INDEX_URL, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const index = DocsIndexSchema.parse(await res.json());
    writeCache(cachePath, index, log);
    return {index, from: 'network'};
  } catch (err) {
    log(`dzbuild-docs-mcp: could not refresh ${INDEX_URL}: ${errorMessage(err)}`);
  }
  if (cached) return {index: cached.index, from: 'stale-cache'};
  return {index: DocsIndexSchema.parse(JSON.parse(readFileSync(bundledPath, 'utf8'))), from: 'bundled'};
}

export async function fetchMarkdown(url: string, fetch = globalThis.fetch): Promise<string> {
  if (!url.startsWith(DOCS_ORIGIN)) throw new Error(`refusing ${url}: only ${DOCS_ORIGIN} documents are fetched`);
  const res = await fetch(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)});
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function readIndexFile(path: string, log: (message: string) => void): {index: DocsIndex; mtimeMs: number} | null {
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`dzbuild-docs-mcp: could not read cache ${path}: ${errorMessage(err)}`);
    return null;
  }
  try {
    return {index: DocsIndexSchema.parse(JSON.parse(raw)), mtimeMs};
  } catch (err) {
    log(`dzbuild-docs-mcp: ignoring unreadable cache ${path}: ${errorMessage(err)}`);
    return null;
  }
}

function writeCache(path: string, index: DocsIndex, log: (message: string) => void): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(index), {flag: 'wx'});
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, {force: true});
    log(`dzbuild-docs-mcp: could not write cache ${path}: ${errorMessage(err)}`);
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
