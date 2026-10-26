# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Changed

- Regroup `apps/rag-server/server` into `http/`, `knowledge/`, `analytics/`, `routes/` and `eval/`. `index.ts`, `app.ts`, `runtime.ts` and `config.ts` stay at the top level because they are startup/assembly/config, and moving them would change the `import.meta.dirname` depth that resolves `.env`, `rag.db` and `rag-graph.db`. No HTTP path, middleware order or runtime behavior changed.
- Split the 631-line `analytics.ts` into `analytics/{types,store,dashboard,replay}.ts` behind an unchanged `RagAnalyticsStore` facade, so every caller keeps its existing method surface. Each extracted method body was diffed statement-by-statement against the original.
- Widen the rag-server test glob from `server/*.test.ts` to `server/**/*.test.ts`. The old single-level glob would have silently skipped every test after the regroup (87 tests would have reported 0 with exit code 0).

- Reorganized `apps/server/src` from layer-first (`routes/`, loose root modules) to feature-first: `features/*` (chat, workflow, query, im, apps, resources, providers, connectors, reports, memory, branding, audit, rag, mcpGateway), `platform/*` (db, auth, usage, workspace, export, crypto, trace, config), and `http/*` (health, sse, errors). All 231 source files were moved with history preserved and 646 relative imports rewritten. No HTTP path, middleware order, table schema, or runtime behavior changed.
- Split workflow code into `features/workflow/runtime` (execution engine) and `features/workflow/library` (drafts, versions, API keys, run history), removing the `workflow/` vs `workflows/` naming ambiguity.
- Renamed the shared text-to-SQL engine from `oneapiDemo/` to `features/query/text2sql/` and the DTMS vertical from `aiQuery/` to `features/query/dtms/`, so directory names match responsibility.
- Moved `ai_query_messages` DDL and persistence out of the route file into `features/query/dtms/store.ts`.
- Merge the two workflow routers into a single `features/workflow/routes.ts`. All 22 endpoints keep their exact paths, middleware order and handlers; only the file boundary changed. Verified by diffing the Express route table before and after (128 routes, byte-identical).
- Unify the three auth modules on shared primitives: `identity-mode.ts` is now the only place `PUBLISHED_APP_IDENTITY_MODE` is parsed, `groups.ts` holds one group-normalization rule with explicit strict/lenient modes, `constant-time.ts` holds the single constant-time comparison, and `resolveDeploymentToken()` is the only reader of `STUDIO_API_TOKEN`/`SERVER_API_TOKEN`. `requireStudioAdmin` no longer re-derives auth state from raw env; it reads the resolved `studioAuthRequired` local and fails closed if the auth middleware never ran.
- Split `platform/db.ts` schema ownership into `platform/schema/*`: each domain owns its DDL and column migrations, and `schema/registry.ts` holds the explicit build and migration order. `db.ts` keeps the singleton, `getDbPath`, `closeDb` and the session/message CRUD. Verified by diffing `sqlite_master` for a fresh database and for the existing `apps/server/data/chat.sqlite` against the pre-change build: identical in both cases.

### Removed

- Removed empty `src/llm/` and `src/utils/` directories, the deprecated `oneapiDemo/schemaGraph.ts` re-export shim (its test now targets `features/query/schema/runtime.ts`), three orphaned `apps/server/test/MCP*Test.ts` scripts that were outside both `tsconfig` and the test glob, unused `studioApiToken`/`studioAuthEnabled` exports, and the `encryptProviderKey`/`decryptProviderKey`/`maskProviderKey` aliases.
- Removed an unused `haystack` binding in the memory search that failed lint.

### Fixed

- Copy static assets during `pnpm --filter @open-agent-tools/server build`; `dist/` previously lacked `oneapi-demo.html`, so `GET /oneapi-demo` returned 404 in a built deployment.
- Correct the relative depth used to locate `packages/schema-catalog/schema-catalog.enriched.json`, which was wrong under both `src/` and `dist/`.

### Added

- Added HTTP workflow nodes with six methods, structured JSON and text bodies, text multipart forms, Basic/Bearer/custom header authentication, per-node TLS verification, timeout and transient retries. Deep object and array references are supported in templates and output selectors.
- Redact HTTP credentials in request traces, node observations, final outputs and history input views. Remove fixed credentials and credential entry defaults from portable JSON and clipboard definitions; imported drafts can be edited before credentials are re-entered.
- Expanded the workflow editor with persistent run history, invalid-reference repair, runtime edge highlighting, release notes, validated JSON import/export, multi-select editing, node execution policies, shared graph contracts, checkpoint resume, automatic layout, and system clipboard subgraph copy/paste.

### Fixed

- Merge final end-node variables in execution order, including duplicate-name overrides, across Studio SSE, public blocking/SSE APIs and run history. Keep full node snapshots in `run_done.nodeOutputs`.
- Validate pasted node bindings against both the existing workflow and the newly pasted subgraph, preserving valid internal references after node IDs are regenerated.
- Retry transient MCP SDK HTTP errors whose status is stored in the numeric `code` field; keep HTTP 400/401 failures non-retryable.
- Clear the canvas selection after confirming a checkpoint resume so the editor displays the current run preview.
- Give the node timeout number input an accessible label.
