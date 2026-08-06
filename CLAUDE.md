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
| Control Plane  | `@open-agent-tools/mcp-control-plane` | Anonymous admin API, service versions, client Keys/Grants, upload and build orchestration |
| MCP Gateway    | `@open-agent-tools/mcp-server`        | MCP protocol endpoint, API Key auth, scope checks, Tool calls, Prompt rendering           |
| MCP Worker     | `@open-agent-tools/mcp-worker`        | ZIP inspection, dependency install, image build/scan, Tool container execution            |
| Studio Web     | `@open-agent-tools/studio-web`        | React administration console                                                              |
| RAG Server     | `@open-agent-tools/rag-server`        | Document ingestion, retrieval, and optional LLM answer API                                |
| Contracts      | `@open-agent-tools/mcp-contracts`     | Shared Zod contracts for manifests, Prompts, jobs, and Runner I/O                         |
| Auth           | `@open-agent-tools/mcp-auth`          | API Key generation, parsing, hashing, verification                                        |
| Pg             | `@open-agent-tools/pg`                | Shared PostgreSQL connection helpers (pg Pool, Drizzle database, error codes)             |
| Node.js Runner | `@open-agent-tools/mcp-nodejs-runner` | Loads handlers inside Tool containers and validates MCP results                           |

The `packages/deepagent` package is a LangGraph-driven Deep Agent adapter used by `apps/cli`. It wraps `createDeepAgent` from `deepagents`, adds HITL interrupt handling, tool-call streaming callbacks, and MCP/time/memory tools.

## Key Concepts

- **Service lifecycle**: draft → validate → build → publish → rollback → disable → soft-delete. Published versions are immutable; changes go through a new draft.
- **Tool packages**: uploaded as ZIP archives containing `mcp.json`, `package.json` (must be `"type": "module"`), `package-lock.json`, and `src/` or `dist/` with `index.js`. The entry module exports `handlers`.
- **Prompt-only services** need no ZIP, runtime, or execution image. Prompt templates support only `{{name}}` text interpolation for declared arguments — no expressions, helpers, loops, or arbitrary code.
- **Client auth**: raw API Keys are returned once; only a hash is stored. Grants support scopes `mcp:connect`, `tools:list`, `tools:call`, `prompts:list`, `prompts:get`, plus `toolNames`/`promptNames` allowlists.
- **Security**: uploaded code runs only in isolated build/execution environments. Tool containers are non-root, read-only rootfs, no network, dropped capabilities. Runner and Tool images must be referenced by SHA-256 digest. The Worker is privileged infrastructure and must not be exposed publicly.

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
pnpm --filter @open-agent-tools/mcp-control-plane test
pnpm --filter @open-agent-tools/mcp-server test
pnpm --filter @open-agent-tools/mcp-worker test
pnpm --filter @open-agent-tools/studio-web test
pnpm --filter @open-agent-tools/mcp-nodejs-runner test
```

Run a single test file with tsx:

```bash
pnpm --filter @open-agent-tools/mcp-worker test -- src/docker-runtime.test.ts
```

PostgreSQL integration tests run only when `TEST_DATABASE_URL` is set. They drop and recreate the target database's `public` schema, so use a dedicated test database:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_test \
  pnpm --filter @open-agent-tools/mcp-control-plane test
```

Docker E2E tests require a local Docker daemon and a pre-built test Runner image.

## Local Startup

Each component starts separately (root `pnpm dev` also starts unrelated demos, so avoid it for the MCP platform):

```bash
pnpm --filter @open-agent-tools/mcp-control-plane dev   # port 4200
pnpm --filter @open-agent-tools/mcp-server dev          # port 4100
pnpm --filter @open-agent-tools/rag-server dev             # port 4001
pnpm --filter @open-agent-tools/studio-web dev             # port 5173
```

The Worker reads process env directly (not `.env`). In Bash/Zsh:

```bash
set -a
source apps/mcp-worker/.env
set +a
pnpm --filter @open-agent-tools/mcp-worker dev
```

## Environment Variables

- **Control Plane**: `DATABASE_URL`, `REDIS_URL`, `ARTIFACT_S3_BUCKET`, `ARTIFACT_S3_ENDPOINT` (optional), AWS S3 credentials, `PORT` (default 4200).
- **Gateway**: `DATABASE_URL` (must match Control Plane exactly), `REDIS_URL`, `MCP_HTTP_PORT` (default 4100).
- **Worker**: `REDIS_URL`, `DATABASE_URL`, `TOOL_IMAGE_REPOSITORY`, `MCP_RUNNER_IMAGE` (must be `image@sha256:...`), `NPM_NETWORK`, `EXECUTION_CONCURRENCY` (default 4), `BUILD_CONCURRENCY` (default 2), `ARTIFACT_S3_BUCKET`, plus optional `DOCKER_SOCKET_PATH`, `BUILDX_ATTESTATIONS`, `ARTIFACT_S3_REGION`, `ARTIFACT_S3_ENDPOINT`.

## Database Migrations

Migrations live in `apps/mcp-control-plane/drizzle/`. Set the same `DATABASE_URL` as the Control Plane, then:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_management
pnpm --filter @open-agent-tools/mcp-control-plane db:migrate
```

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

Each component has its own README (Chinese and English) with deeper detail:

- [Control Plane](./apps/mcp-control-plane/README.md)
- [MCP Gateway](./apps/mcp-server/README.md)
- [MCP Worker](./apps/mcp-worker/README.md)
- [Studio Web](./apps/studio-web/README.md)
- [RAG Server](./apps/rag-server/README.md)
- [MCP Auth](./packages/mcp-auth/README.md)
- [MCP Contracts](./packages/mcp-contracts/README.md)
- [Node.js Runtime](./runtimes/nodejs/README.md)
