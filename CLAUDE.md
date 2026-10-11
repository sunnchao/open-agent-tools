# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a pnpm + TypeScript monorepo (`open-agent-tools`). It contains two independent areas:

1. **MCP Management Platform** — administrators configure, build, publish, and roll back managed MCP services. MCP clients access published Tools and Prompts through API Keys and fine-grained grants.
2. **Agent and Studio surfaces** — `apps/studio-web` unifies Agent Chat, MCP, RAG, and workflow UIs; `apps/cli` and `apps/server` remain standalone Agent/Chat surfaces.

The workspace globs are `apps/*`, `packages/*`, and `runtimes/*/*`.

## Architecture

The MCP platform is a layered system:

```text
Administrator
    |
    v
Studio Web (5173) ---> Control Plane (4200) ---> PostgreSQL
        |             -> RAG Server (4001) ---> SQLite
                          |                  -> Redis / BullMQ
                          |                  -> S3 / MinIO
                          v
                    MCP Worker ---> Docker / OCI Registry
                         |          -> Syft / Trivy
                         v
                    Tool Container

MCP Client ---> MCP Gateway (4100) ---> PostgreSQL
                      |                -> Redis / BullMQ
                      v
                  MCP Worker
```

| Component      | Package                               | Responsibility                                                                            |
| -------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Control Plane  | `@open-agent-tools/mcp-worker`        | Anonymous admin API, service versions, client Keys/Grants, upload and build orchestration |
| MCP Gateway    | `@open-agent-tools/mcp-server`        | MCP protocol endpoint, API Key auth, scope checks, Tool calls, Prompt rendering           |
| MCP Worker     | `@open-agent-tools/mcp-worker`        | ZIP inspection, dependency install, image build/scan, Tool container execution            |
| Studio Web     | `@open-agent-tools/studio-web`        | React administration console                                                              |
| RAG Server     | `@open-agent-tools/rag-server`        | Document ingestion, retrieval, and optional LLM answer API                                |
| Contracts      | `@open-agent-tools/mcp-contracts`     | Shared Zod contracts for manifests, Prompts, jobs, and Runner I/O                         |
| Auth           | `@open-agent-tools/mcp-auth`          | API Key generation, parsing, hashing, verification                                        |
| Database       | `@open-agent-tools/database`          | Unified database layer: PostgreSQL / MySQL / Redis / Elasticsearch connection helpers    |
| Node.js Runner | `@open-agent-tools/mcp-nodejs-runner` | Loads handlers inside Tool containers and validates MCP results                           |

Control Plane and Worker share `@open-agent-tools/mcp-worker`, not a process or permission boundary. Control Plane sources, including the admin entry, live in `apps/mcp-worker/src/control-plane/`; `src/control-plane/index.ts` compiles to `dist/control-plane/index.js`. The original `src/index.ts` -> `dist/index.js` remains background-only. BullMQ dispatch and isolated Tool containers are unchanged. The admin process needs no Docker socket, Runner image, or Registry access; only the background Worker receives those privileges. `apps/mcp-server` is outside the merge scope and remains structurally and behaviorally unchanged.

The former `apps/mcp-control-plane` is no longer a workspace/package or source tree. Its tracked contents are only README redirects and `drizzle -> ../mcp-worker/drizzle` for consumers of legacy migration paths; do not modify Gateway files to remove that compatibility dependency.

The `apps/cli` coding agent runs on a Pi Agent base (`@earendil-works/pi-coding-agent`). `apps/cli/src/app/piRuntime.ts` wraps `createAgentSession`, bridging Pi events to the CLI's streaming callbacks, with HITL permission gating (`tool_call` event), MCP tool loading (`tools/mcpPi.ts`), memory tools (`tools/memoryPi.ts`), and an isolated read-only `task` subagent (`tools/subagentPi.ts`).

## Key Concepts

- **Service lifecycle**: draft → validate → build → publish → rollback → disable → soft-delete. Published versions are immutable; changes go through a new draft.
- **Tool packages**: uploaded as ZIP archives containing `mcp.json`, `package.json` (must be `"type": "module"`), `package-lock.json`, and `src/` or `dist/` with `index.js`. The entry module exports `handlers`.
- **Prompt-only services** need no ZIP, runtime, or execution image. Prompt templates support only `{{name}}` text interpolation for declared arguments — no expressions, helpers, loops, or arbitrary code.
- **Client auth**: raw API Keys are returned once; only a hash is stored. Grants support scopes `mcp:connect`, `tools:list`, `tools:call`, `prompts:list`, `prompts:get`, plus `toolNames`/`promptNames` allowlists.
- **Security**: uploaded code runs only in isolated build/execution environments. Tool containers are non-root, read-only rootfs, dropped capabilities, with networking selected by the published version's `limits.network` (`none` or `bridge`). Runner and Tool images must be referenced by SHA-256 digest. The Worker is privileged infrastructure and must not be exposed publicly.

## Development Commands

Root-level scripts (run from repo root):

```bash
pnpm build          # build all workspace packages
pnpm typecheck     # typecheck all packages
pnpm lint          # eslint .
pnpm test          # run tests in all packages
pnpm format:check  # prettier --check .
pnpm format        # prettier --write .
```

Run a single package's tests (MCP platform):

```bash
pnpm --filter @open-agent-tools/mcp-contracts test
pnpm --filter @open-agent-tools/mcp-auth test
pnpm --filter @open-agent-tools/mcp-server test
pnpm --filter @open-agent-tools/mcp-worker test
pnpm --filter @open-agent-tools/studio-web test
pnpm --filter @open-agent-tools/mcp-nodejs-runner test
```

The Worker package's test command covers both Control Plane and background Worker tests; do not run duplicate tests for the removed package.

Run a single test file with tsx:

```bash
pnpm --filter @open-agent-tools/mcp-worker test -- src/infrastructure/docker/docker-runtime.test.ts
```

PostgreSQL integration tests run only when `TEST_DATABASE_URL` is set. They drop and recreate the target database's `public` schema, so use a dedicated test database:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_test \
  pnpm --filter @open-agent-tools/mcp-worker test
```

Docker E2E tests require a local Docker daemon and a pre-built test Runner image.

## Local Startup

Each component starts separately for MCP-only workflows. Root `pnpm dev` runs `pnpm -r --parallel --if-present run "/^dev(:admin)?$/"`, starting the shared package's worker `dev` and `dev:admin` in separate processes plus unrelated apps' existing `dev` scripts, so avoid it for MCP-only startup:

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:admin    # admin API only, port 4200
pnpm --filter @open-agent-tools/mcp-server dev          # port 4100
pnpm --filter @open-agent-tools/rag-server dev             # port 4001
pnpm --filter @open-agent-tools/studio-web dev             # port 5173
```

The admin API requires PostgreSQL, Redis, and S3 configuration, but no Docker, Runner image, or Registry. Start the background Worker in another process only when inspection/build/execution is needed, after provisioning its dependencies:

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:worker
```

`dev`/`start` retain their worker-only behavior; `dev:worker`/`start:worker` are explicit aliases. `dev:admin`/`start:admin` start only the admin API. After building the shared package, use `start:admin` for the admin process and `start:worker` for the background process. One package never implies one process.

## Environment Variables

The unified template is `apps/mcp-worker/.env.example`. Create a local file only if it is absent:

```bash
test -e apps/mcp-worker/.env || cp apps/mcp-worker/.env.example apps/mcp-worker/.env
```

Local secret `.env` files may already exist in both former apps. Manually merge necessary former Control Plane values into `apps/mcp-worker/.env`, resolving conflicts without overwriting either existing file or secrets. The admin entry keeps the existing `dotenv` loading of the Worker's `.env` and does not read the old Control Plane `.env`. Worker `dev`/`dev:worker` load `.env` through `--env-file=.env`; Worker `start`/`start:worker` still require injected environment variables. In production, provide only each process's required secrets and privileges.

- **Control Plane**: `DATABASE_URL`, `REDIS_URL`, `ARTIFACT_S3_BUCKET`, `ARTIFACT_S3_ENDPOINT` (optional), AWS S3 credentials, `PORT` (default 4200).
- **Gateway**: `DATABASE_URL` (must match Control Plane exactly), `REDIS_URL`, `MCP_HTTP_PORT` (default 4100).
- **Worker**: `REDIS_URL`, `DATABASE_URL`, `TOOL_IMAGE_REPOSITORY`, `MCP_RUNNER_IMAGE` (must be `image@sha256:...`), `NPM_NETWORK`, `EXECUTION_CONCURRENCY` (default 4), `BUILD_CONCURRENCY` (default 2), `ARTIFACT_S3_BUCKET`, plus optional `DOCKER_SOCKET_PATH`, `BUILDX_ATTESTATIONS`, `ARTIFACT_S3_REGION`, `ARTIFACT_S3_ENDPOINT`.

## Database Migrations

The schema lives in `apps/mcp-worker/src/control-plane/db/schema.ts`; migrations live in `apps/mcp-worker/drizzle/`, with all existing SQL and the journal unchanged. Drizzle reads `DATABASE_URL` from the process environment. Set the same value as the Control Plane, then:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_management
pnpm --filter @open-agent-tools/mcp-worker db:migrate
```

Generate new migrations after schema changes with `pnpm --filter @open-agent-tools/mcp-worker db:generate`. The old `apps/mcp-control-plane/drizzle` path is only a compatibility symlink to the new migration directory, not a separate migration history or package.

Control Plane and Gateway must use the same database, or the Gateway cannot see published services and client grants.

## Administration API

All admin endpoints are under `/api/admin/mcp`:

- `/services` — service CRUD, disable, version listing
- `/services/:serviceId/versions/:versionId/tools` — Tool CRUD
- `/services/:serviceId/versions/:versionId/prompts` — Prompt CRUD and preview
- `/services/:serviceId/versions/:versionId/upload-url` — direct S3 upload URL
- `/services/:serviceId/versions/:versionId/complete-upload` — confirm upload, create inspection job
- `/services/:serviceId/versions/:versionId/build` — create build job
- `/services/:serviceId/versions/:versionId/validate` — validate Prompt-only or built versions
- `/services/:serviceId/versions/:versionId/publish` — publish version
- `/services/:serviceId/versions/:versionId/rollback` — rollback version
- `/clients`, `/clients/:id/keys`, `/clients/:id/grants` — client, Key, and Grant management

Write operations use `expectedRevision` for optimistic concurrency control.

## MCP Client Requests

```http
POST /mcp/services/{serviceSlug} HTTP/1.1
Host: localhost:4100
Authorization: Bearer <raw-api-key>
Content-Type: application/json
```

The Gateway uses stateless Streamable HTTP; `GET` and `DELETE` return `405 Method Not Allowed`.

## Current Limitations

- Managed Tools support Node.js 20 ESM/npm only. Python, Java, Yarn, pnpm Tool packages, Bun, and user-supplied Dockerfiles are not supported.
- Managed MCP Resources and remote MCP service proxying are not implemented.
- Studio Web and Control Plane have no identity authentication or user isolation — suitable only for localhost/trusted networks.
- No Docker Compose or Kubernetes deployment manifest is included.
- Node.js 20 has reached upstream end-of-life; production rollout requires a security exception or migration to a supported LTS.

## Design and Test Documents

- [MCP management platform Node.js design](./docs/superpowers/specs/2026-07-31-mcp-management-platform-nodejs-design.md)
- [MCP management platform test plan](./docs/superpowers/plans/2026-07-31-mcp-management-platform-nodejs-test-plan.md)

## Component READMEs

Component and role guides (Chinese and English) provide deeper detail:

- [Control Plane](./apps/mcp-worker/CONTROL_PLANE.md)
- [MCP Gateway](./apps/mcp-server/README.md)
- [MCP Worker](./apps/mcp-worker/README.md)
- [Studio Web](./apps/studio-web/README.md)
- [RAG Server](./apps/rag-server/README.md)
- [MCP Auth](./packages/mcp-auth/README.md)
- [MCP Contracts](./packages/mcp-contracts/README.md)
- [Node.js Runtime](./runtimes/nodejs/README.md)
