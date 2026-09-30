#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {loadIndex} from './index-loader.js';
import {createServer} from './index.js';

const {index, from} = await loadIndex();
console.error(`dzbuild-docs-mcp: docs index ${index.kit_version} (${from}): ${index.docs.length} pages, ${index.api.length} operations, ${index.examples.length} examples`);
await createServer(index).connect(new StdioServerTransport());
