# @dzbuild/docs-mcp

An MCP server that gives a coding agent the DZBuild developer documentation over stdio: the pages of
[dzbuild.dev](https://dzbuild.dev), the operations of the API for apps, and the code examples of the
developer kit. It runs on your machine through `npx`, needs no account and no key, and reads one
public JSON file.

## Tools

| Tool | Input | Answer |
|---|---|---|
| `search_docs` | `query`, optional `locale` (`en`, `ar`, `fr`), optional `limit` (1 to 50, default 10) | Ranked pages with `id`, `locale`, `url`, `md_url`, `score` and a 160 character snippet |
| `get_document` | `id`, optional `locale` (default `en`) | The page as Markdown, fetched live from dzbuild.dev when reachable, otherwise the copy inside the index |
| `get_api_operation` | `operationId` | Method, path, scopes and description of one operation of the API for apps |
| `get_example` | `id` | One code example of the developer kit |

Every answer is JSON text and carries `kit_version` (the version of the docs index it came from) and
the source URLs. An unknown id answers an error that lists the known ids, so the agent can correct
itself without a second search.

## Install it in your client

Claude Code:

```bash
claude mcp add dzbuild-docs -- npx -y @dzbuild/docs-mcp
```

Cursor, in `.cursor/mcp.json` at the root of the project (or `~/.cursor/mcp.json` for every project):

```json
{"mcpServers":{"dzbuild-docs":{"command":"npx","args":["-y","@dzbuild/docs-mcp"]}}}
```

Codex:

```bash
codex mcp add dzbuild-docs -- npx -y @dzbuild/docs-mcp
```

Claude Desktop, in `claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{"mcpServers":{"dzbuild-docs":{"command":"npx","args":["-y","@dzbuild/docs-mcp"]}}}
```

Node.js 20 or newer must be on the PATH the client uses.

## Compatibility

"config validated" means the configuration above matches the client's documented format. "protocol
tested" means a scripted stdio client ran `initialize`, `tools/list` and `tools/call` against the
published entry point. "verified in client" means someone connected the real client and ran a search.

| Client | Status |
|---|---|
| Claude Code | protocol tested |
| Cursor | protocol tested |
| Codex | protocol tested |
| Claude Desktop | protocol tested |

## What leaves your machine

At start the server fetches one URL, `https://dzbuild.dev/kit/docs-index.json`, with a 5 second
timeout, validates it and keeps a copy in the system temporary directory for 24 hours. When
dzbuild.dev cannot be reached it uses the last copy, and failing that the index bundled in the package
(`data/docs-index.json`), so the tools keep working offline. `get_document` fetches the Markdown twin
of a page from dzbuild.dev to serve the live text and refuses any other host. Nothing else is fetched.

Search runs locally, so the only requests dzbuild.dev sees are for static files: the index and the
pages you open. The server sends no credentials, holds none, knows nothing about your stores and
cannot act on one. It is documentation only.

## The docs index

`data/docs-index.json` is the bundled copy of the live index. The server reads these fields and passes
any other field through unchanged:

```text
kit_version, openapi_info_version
docs[]      id, locale, title, description, url, md_url, headings[], text
api[]       operationId, method, path, summary, description, scopes[], url
examples[]  id, title, description, language, code, url
```

## Develop

```bash
npm ci
npm test              # compiles to dist/ and runs node --test
node dist/src/cli.js  # the server on stdio
npm run fetch-index   # refreshes data/docs-index.json from dzbuild.dev before a publish
```

`npm publish` runs the tests first through `prepublishOnly`.

## License

MIT.
