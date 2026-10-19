# open-agent-tools Enterprise Internal AI Tooling Platform

[中文](./README.md)

open-agent-tools is an AI tooling project for internal enterprise use: it consolidates the capabilities enterprises need most when adopting AI internally — agent chat, RAG knowledge bases, the knowledge graph, multi-source data Q&A, workflow orchestration, and MCP tool hosting and governance — into a single pnpm and TypeScript monorepo, so internal data, knowledge, and processes can be called directly by AI.

`apps/studio-web` is the unified visual surface where internal teams use these capabilities, bringing together Agent Chat, RAG knowledge bases, the knowledge graph, multi-source data Q&A, workflow orchestration, and MCP administration. Chat, workflow, data Q&A, and settings requests are served by `apps/server` (the Agent Server, default port `3000`). `apps/cli` and `apps/server` can also run independently as standalone Agent/Chat entry points.

Enterprises no longer have to juggle a set of isolated AI tools: connect data sources, build knowledge bases, orchestrate workflows, and host and authorize tools, then deliver the result to internal employees and business systems through chat, IM bots, and open APIs. The MCP management platform (Control Plane + Gateway + Worker) is the tool governance layer of this system, handling configuration, build, publish, rollback, and access authorization for managed MCP services. See "MCP tool hosting and governance" below for the details.

## Current capabilities

### AI workbench and applications (Studio Web and Agent Server)

- IM collaboration entry: configure Feishu/DingTalk bots visually in Studio Web "Settings → IM Channels" (multi-channel, encrypted secrets, knowledge base binding); @-mentioning a bot in a group answers from Agent Chat + RAG knowledge base.
- Multi-source data Q&A: Studio Web "Settings → Schema Sources" manages multiple read-only MySQL / PostgreSQL connections, collection scope, and the default route. The Q&A page isolates the catalog, relationship graph, and SQL execution per source, and records a staged audit of every question from data-source resolution to the final output. Audit records can be searched and replayed in the Q&A page's "Audit logs".
- RAG asset operations: fixed-size chunking and embedding-similarity semantic chunking. Document title/tags, content fingerprints, chunking parameters, versions, and update times are governed. Re-uploading a document with the same name replaces it atomically. Built-in dashboards show query volume, empty-recall rate, latency, top sources, and user feedback.
- MCP Gateway connection: Studio Web "Settings → MCP Gateway" configures the Gateway URL and API Key (stored encrypted) used by workflows and chat. Changes take effect on save; without a saved configuration, the environment variables are used as a fallback.
- Workflow orchestration: the node palette includes Start, User Input, Knowledge Retrieval, Graph Retrieval, SQL Query, LLM, MCP Tool, HTTP Request, Condition Branch, and End nodes. The editor provides run history with checkpoint resume, broken-reference repair, run-path highlighting, per-node execution policies, JSON import/export, multi-select editing, auto layout, and subgraph copy/paste. A draft can be published as an immutable version and invoked externally through a workflow-level API Key (rate-limited per minute), OpenAPI 3.1, and `/v1/workflows/{slug}/run`.
- Workflow HTTP Request node: six methods; JSON, plain-text, or multipart form (text fields only) request bodies; Basic, Bearer, and custom-header authentication; per-node timeout and retries. Multiple End nodes merge the final output in execution order, and a per-node debug trace is kept. Credentials are redacted in observations, and fixed credentials are removed on export and clipboard copy.
- Workflow SQL Query node: pick a schema data source (the default source is used when none is selected) and describe the question in natural language, optionally referencing input variables. It reuses the Q&A module's text-to-SQL, read-only validation, and audit. The "Default row count" (1–100, default 100) applies only when the question does not specify a count; when the question asks for the top N rows or all rows, the question wins, capped at 100 rows. Default outputs are `rows`, `sql`, `rowCount`, and `auditId`. If the question needs a business definition clarified, the node fails with the audit ID.
- Workflow Condition Branch node: configure IF / ELIF / ELSE branches visually. Each branch combines multiple rules with AND/OR, offers 14 operators filtered by variable type, and routes to its own next node on the canvas. At run time the first matching branch in order wins; a condition whose variable is missing or whose type does not match is treated as not satisfied and raises a warning. Run previews and node tests show which branch matched. A draft may be saved with incomplete conditions; variable references, operators, comparison value types, and each branch's next node are validated before running and publishing. The legacy expression mode is still supported.

### MCP tool hosting and governance

- Manage the lifecycle of managed MCP services and versions: draft, validate, build, publish, roll back, disable/enable, and soft-delete. After a soft-delete, the slug can be reused by a new service.
- Configure Tool-only, Prompt-only, or mixed Tools + Prompts services.
- Add, update, and delete Tools and Prompts on draft versions. A published version can be forked into a new draft with "Create draft" and edited from there.
- Upload Node.js Tool ZIP archives, validate archive/npm package structure, run `npm ci`, and run an optional build.
- Build and push digest-addressed OCI images, generate CycloneDX SBOMs, and scan images with Trivy.
- Execute Tools in isolated Docker containers; validate and render Prompts directly in the Gateway.
- Service-level runtime environment variables: configure variables such as `TAVILY_API_KEY` for Tools under "MCP → Services → Environment variables". Values are write-only and never echoed back; a saved change takes effect on the next call, with no rebuild or republish.
- Per-version runtime limits: once a package has been inspected, adjust the timeout, memory, CPU, and network mode (`none` disables networking, `bridge` allows it) in the preview panel. Published versions are read-only.
- Keep Studio Web and the administration API temporarily anonymous, with every visitor acting as an administrator.
- Issue one-time-visible API Keys for MCP clients and authorize by service, scope, Tool name, and Prompt name.
- Expose `tools/list`, `tools/call`, `prompts/list`, and `prompts/get` over Streamable HTTP.
- Audit: Control Plane write operations and every Gateway MCP request are recorded in `mcp_audit_events` with the actor, action, result, duration, and redacted input, output, and context. Studio Web "MCP → Audit" filters by result and action and shows event details.
- Provide a React administration console covering services, Tools, Prompts, builds, versions, client authorization, and audit.
- Custom Function Tools: `packages/function-tools` collects MCP tool packages that can be packaged and uploaded independently. It currently contains `pinyin` (Chinese characters to pinyin, runs offline) and `web-search` (Tavily web search, requires `bridge` networking and `TAVILY_API_KEY`), plus an interactive packaging script.

The managed runtime currently supports Node.js 20, ESM, and npm only. Python, Java, managed MCP Resources, and remote MCP proxying are outside the currently runnable scope.

## Architecture

Studio Web is the unified workbench: it serves internal employees and business systems on one side, and connects to the Agent Server (chat, workflows, data Q&A) and the MCP management surface on the other. The diagram below shows the MCP tool hosting, gateway, and isolated execution chain, and how it relates to Studio Web and the RAG Server.

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

| Component          | Package                                | Responsibility                                                                                                                                               |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Control Plane      | `@open-agent-tools/mcp-worker`         | Anonymous admin API, service versions and runtime environment variables, client Keys/Grants, audit, upload and build orchestration                           |
| MCP Gateway        | `@open-agent-tools/mcp-server`         | MCP protocol endpoint, API Key authentication, scope checks, Tool calls, Prompt rendering, and request audit                                                 |
| MCP Worker         | `@open-agent-tools/mcp-worker`         | ZIP inspection, dependency installation, image build/scan, and Tool container execution                                                                      |
| Agent Server       | `@open-agent-tools/server`             | Agent Chat, workflow drafts/publishing/runs and the Service API, data Q&A, IM channels, and settings for Providers, schema data sources, and the MCP Gateway |
| Studio Web         | `@open-agent-tools/studio-web`         | Unified React workspace for Agent, MCP, RAG, graph, data Q&A, and workflows                                                                                  |
| RAG Server         | `@open-agent-tools/rag-server`         | Document ingestion, SQLite indexing, hybrid retrieval, and optional LLM answers                                                                              |
| Contracts          | `@open-agent-tools/mcp-contracts`      | Shared Zod contracts for manifests, Prompts, jobs, and Runner I/O                                                                                            |
| Workflow Contracts | `@open-agent-tools/workflow-contracts` | Shared validation contracts for workflow graphs, variable references, condition branches, and HTTP nodes (used by both Studio Web and the Agent Server)      |
| Auth               | `@open-agent-tools/mcp-auth`           | API Key generation, parsing, hashing, and verification                                                                                                       |
| Node.js Runner     | `@open-agent-tools/mcp-nodejs-runner`  | Loads handlers inside Tool containers and validates MCP results                                                                                              |

The Control Plane and Worker share the `@open-agent-tools/mcp-worker` package, but remain separate processes and permission boundaries. The admin API dispatches work through BullMQ, and Tools still run in isolated containers. The admin API needs no Docker socket, Runner image, or Registry permissions; those capabilities belong only to the background Worker. The Gateway (`apps/mcp-server`) is still a separate process. It uses the same PostgreSQL as the Control Plane and writes every MCP request to the audit table.

Studio Web's chat, workflow, data Q&A, and settings requests are handled by the Agent Server (in development, Vite proxies `/api` and `/v1` to `3000`). The Agent Server acts as an MCP client of the Gateway using the URL and API Key from "Settings → MCP Gateway", and retrieves knowledge through the RAG Server at `RAG_API_URL`. Conversations, workflows, and settings live in its own SQLite database (default `apps/server/data/chat.sqlite`).

## Repository layout

```text
apps/
  cli/                     Command-line coding agent (Pi Agent)
  mcp-server/              Dynamic MCP Gateway
  mcp-worker/              Shared Control Plane and background Worker package
    src/index.ts          Background Worker entry
    src/control-plane/    Control Plane sources and admin API entry index.ts
    drizzle/              PostgreSQL migration SQL and journal
  server/                  Agent Server: chat, workflows, data Q&A, IM channels, and settings
  studio-web/              Unified React workspace
  rag-server/              RAG HTTP API and SQLite data
packages/
  database/                PostgreSQL / MySQL / Redis / Elasticsearch connection helpers
  function-tools/          Custom MCP tool packages (pinyin, web-search) and packaging scripts
  mcp-auth/                MCP API Key contract
  mcp-contracts/           Cross-service data contracts
  observability/           Audit redaction and Langfuse/OpenTelemetry tracing
  query-resolver/          Pre-query term resolution for data Q&A (dates, organizations, costs, statuses)
  rag/                     RAG core library: chunking, ingestion, SQLite vector index, retrieval, CRAG, and knowledge graph
  schema-catalog/          MySQL / PostgreSQL schema collection and progressive loading
  workflow-contracts/      Shared contracts for workflow graphs, variables, condition branches, and HTTP nodes
runtimes/
  nodejs/
    Dockerfile             Digest-pinned, non-root Runner image
    runner/                Node.js Runner source
    fixtures/              Sample Tool package and invocation
docs/superpowers/
  specs/                   Design documents
  plans/                   Test plans
```

## Component documentation

| Component       | English                                                   | 中文文档                                            |
| --------------- | --------------------------------------------------------- | --------------------------------------------------- |
| CLI Agent       | [README_EN](./apps/cli/README_EN.md)                      | [README](./apps/cli/README.md)                      |
| Control Plane   | [CONTROL_PLANE_EN](./apps/mcp-worker/CONTROL_PLANE_EN.md) | [CONTROL_PLANE](./apps/mcp-worker/CONTROL_PLANE.md) |
| MCP Gateway     | [README_EN](./apps/mcp-server/README_EN.md)               | [README](./apps/mcp-server/README.md)               |
| MCP Worker      | [README_EN](./apps/mcp-worker/README_EN.md)               | [README](./apps/mcp-worker/README.md)               |
| Studio Web      | [README_EN](./apps/studio-web/README_EN.md)               | [README](./apps/studio-web/README.md)               |
| RAG Server      | [README](./apps/rag-server/README.md)                     | -                                                   |
| MCP Auth        | [README_EN](./packages/mcp-auth/README_EN.md)             | [README](./packages/mcp-auth/README.md)             |
| MCP Contracts   | [README_EN](./packages/mcp-contracts/README_EN.md)        | [README](./packages/mcp-contracts/README.md)        |
| Node.js Runtime | [README_EN](./runtimes/nodejs/README_EN.md)               | [README](./runtimes/nodejs/README.md)               |
| Function Tools  | -                                                         | [README](./packages/function-tools/README.md)       |

## Prerequisites

- Node.js 22.5 or later (required by `engines` in the root `package.json`; the Agent Server, RAG Server, and CLI use `node:sqlite`). The managed Tool runtime is fixed to Node.js 20 and is provided by the Runner image.
- pnpm 10.32.1.
- PostgreSQL 16. The Control Plane and Gateway must use the same database.
- Redis 7 or a compatible service.
- An S3-compatible object store, such as AWS S3 or MinIO, with a pre-created artifact bucket.
- Docker Engine, Docker Buildx, and a Docker daemon accessible to the Worker.
- An OCI Registry, with the Worker environment already authenticated.
- `syft` and `trivy` installed on the Worker host.

The repository has no full Docker Compose setup. `scripts/docker-compose.yml` contains only a MinIO service for local development (API `9000`, Console `9001`, default credentials `minioadmin` / `minioadmin`, for local use only). Start it with `docker compose -f scripts/docker-compose.yml up -d`, then create the artifact bucket in the Console. PostgreSQL, Redis, and the Registry must be provisioned separately.

Starting only the admin API requires PostgreSQL, Redis, and S3 configuration, not Docker, Buildx, a Runner image, a Registry, Syft, or Trivy. The latter dependencies are needed only for background Worker Tool builds/execution.

## Installation

```bash
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
```

Build all workspace packages:

```bash
pnpm build
```

To start only the Studio Web and Agent Server development servers, first build at least the shared packages with `pnpm build:deps` (`mcp-auth`, `mcp-contracts`, `database`, `workflow-contracts`, and `observability`).

## Configuration

### Shared Control Plane and Worker configuration

The unified example is `apps/mcp-worker/.env.example`. Create `.env` only if it does not exist:

```bash
test -e apps/mcp-worker/.env || cp apps/mcp-worker/.env.example apps/mcp-worker/.env
```

The former `apps/mcp-control-plane` directory has been removed from the repository, and the admin API reads only `apps/mcp-worker/.env`. If you still have a local `.env` in the old directory, manually merge the values you need into the new file, checking database, Redis, S3 credential, and port conflicts. Never overwrite existing `.env` files or secrets. Production deployments should still inject only the variables and permissions each process needs; sharing a package does not grant the admin API Docker/Registry access.

### Control Plane

`dev:admin` and `start:admin` load `apps/mcp-worker/.env` through the existing `dotenv` setup and start only the admin API, on port `4200` by default.

Important variables:

| Variable                                      | Description                                                  |
| --------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                                | MCP management database connection string                    |
| `REDIS_URL`                                   | Redis used by build/inspection BullMQ queues                 |
| `ARTIFACT_S3_BUCKET`                          | Bucket containing Tool ZIP archives and SBOMs                |
| `ARTIFACT_S3_ENDPOINT`                        | Optional endpoint for MinIO or another S3-compatible service |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 credentials                                               |
| `PORT`                                        | Control Plane port, default `4200`                           |

### MCP Gateway

```bash
cp apps/mcp-server/.env.example apps/mcp-server/.env
```

Change `DATABASE_URL` so it exactly matches the MCP management database used by the Control Plane. The Gateway uses:

| Variable        | Description                                                                             |
| --------------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`  | Database containing published services, API Keys, and Grants                            |
| `REDIS_URL`     | Tool execution queue; without it, only Prompt paths that require no executor are usable |
| `MCP_HTTP_PORT` | Gateway port, default `4100`                                                            |

### MCP Worker

Use the shared `.env` described earlier. `dev` and `dev:worker` load `apps/mcp-worker/.env` through `--env-file=.env` and start only the background Worker:

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:worker
```

`start` and `start:worker` retain their previous behavior: they read environment variables injected by the process manager or shell and do not automatically load `.env`.

In addition to PostgreSQL, Redis, and S3 settings, the Worker requires:

| Variable                | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `TOOL_IMAGE_REPOSITORY` | OCI repository for Tool images, without a digest                   |
| `MCP_RUNNER_IMAGE`      | Runner image in the required `image@sha256:...` form               |
| `NPM_NETWORK`           | Controlled Docker network used while installing build dependencies |
| `EXECUTION_CONCURRENCY` | Tool execution concurrency, default `4`                            |
| `BUILD_CONCURRENCY`     | Inspection/build concurrency, default `2`                          |

### Agent Server

```bash
test -e apps/server/.env || cp apps/server/.env.example apps/server/.env
```

`apps/server` reads `apps/server/.env` on startup (`.env.local` overrides it) and listens on `3000` by default. Model Providers are no longer injected through environment variables; configure them in Studio Web "Settings". Important variables:

| Variable                                  | Description                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_SECRETS_ENCRYPTION_KEY`           | 64 hex characters (32 bytes) used to encrypt stored model Provider keys, IM credentials, schema data source connection strings, and the MCP Gateway API Key. Without it these settings cannot be saved. Generate one with `openssl rand -hex 32`. The legacy name `PROVIDER_KEYS_ENCRYPTION_KEY` is still accepted. |
| `PORT`                                    | Agent Server port, default `3000`                                                                                                                                                                                                                                                                                   |
| `WEB_ORIGIN`                              | Allowed Studio Web origin, default `http://localhost:5173`                                                                                                                                                                                                                                                          |
| `RAG_API_URL`                             | RAG Server URL, default `http://localhost:4001/api`                                                                                                                                                                                                                                                                 |
| `MCP_GATEWAY_URL` / `MCP_GATEWAY_API_KEY` | Fallback used only when "Settings → MCP Gateway" has no saved configuration                                                                                                                                                                                                                                         |
| `WORKFLOW_HTTP_ALLOWLIST`                 | Optional comma-separated hostname allowlist restricting the targets (including redirects) of workflow HTTP nodes. When unset, any HTTP/HTTPS target is allowed.                                                                                                                                                     |
| `SQLITE_PATH`                             | Optional, default `apps/server/data/chat.sqlite`                                                                                                                                                                                                                                                                    |

Other variables, such as Langfuse, Feishu IM, the data Q&A LLM, and the reporting databases, are documented in `apps/server/.env.example`.

### Studio Web

The development server proxies `/api` and `/v1` to the Agent Server (`3000`), and proxies the MCP administration API, Gateway, and RAG API to ports `4200`, `4100`, and `4001` respectively:

```bash
pnpm --filter @open-agent-tools/studio-web dev
```

Studio Web currently performs no authentication and reads no browser Token. The Control Plane also handles every administration request as an anonymous `admin`, and the Agent Server's management endpoints have no identity authentication either (the public `/v1/workflows/{slug}/run` endpoint uses a workflow API Key). This mode is suitable only for local development or a trusted network and must not be exposed directly to the public internet.

## Database migrations

Set the same `DATABASE_URL` used by the Control Plane, then run:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_management
pnpm --filter @open-agent-tools/mcp-worker db:migrate
```

The schema is `apps/mcp-worker/src/control-plane/db/schema.ts`, and migrations are stored in `apps/mcp-worker/drizzle/`. To generate a new migration after a schema change, use `pnpm --filter @open-agent-tools/mcp-worker db:generate`.

When upgrading an existing deployment, run `db:migrate` first, then restart the Control Plane, Gateway, and Worker. Recent migrations: `0004` adds service runtime environment variables, `0005` allows the slug of a soft-deleted service to be reused, and `0006` adds the source (Control Plane or Gateway), input, output, and context fields to audit events.

The former `apps/mcp-control-plane` directory and its `drizzle` compatibility link have been removed; the migration history lives only in `apps/mcp-worker/drizzle/`. Do not point the Control Plane and Gateway at different databases, or the Gateway will not see published services and client grants.

## Building the Node.js Runner image

```bash
docker build \
  -f runtimes/nodejs/Dockerfile \
  -t registry.example.com/mcp-nodejs-runner:local \
  .

docker push registry.example.com/mcp-nodejs-runner:local
docker inspect --format='{{index .RepoDigests 0}}' registry.example.com/mcp-nodejs-runner:local
```

Set `MCP_RUNNER_IMAGE` to the resulting `repository@sha256:...` reference. Mutable tags must not be used in production.

## Local startup

After provisioning PostgreSQL, Redis, and S3 configuration and applying migrations, start the admin API and other services separately. The admin API does not require Docker, a Runner image, or a Registry:

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:admin
pnpm --filter @open-agent-tools/mcp-server dev
pnpm --filter @open-agent-tools/rag-server dev
pnpm --filter @open-agent-tools/server dev
pnpm --filter @open-agent-tools/studio-web dev
```

The Agent Server needs `apps/server/.env` (see above) and a prior `pnpm build:deps`.

When artifact inspection, Tool builds, or Tool execution are needed, prepare Docker, the Runner image, the Registry, and other Worker dependencies, then start a separate process:

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:worker
```

The compatibility script `dev` remains worker-only, equivalent to `dev:worker`, and does not start the admin API. After building, use `pnpm --filter @open-agent-tools/mcp-worker start:admin` for the admin API and `start:worker` (or compatibility `start`) for the background Worker with injected environment variables. Neither starts the other role. The background entry remains `src/index.ts` -> `dist/index.js`; the admin entry is `src/control-plane/index.ts` -> `dist/control-plane/index.js`.

Default endpoints:

| Service              | URL                                                |
| -------------------- | -------------------------------------------------- |
| Studio Web           | `http://localhost:5173`                            |
| RAG Server Health    | `http://localhost:4001/api/health`                 |
| Agent Server Health  | `http://localhost:3000/health`                     |
| Control Plane Health | `http://localhost:4200/health`                     |
| MCP Gateway Health   | `http://localhost:4100/health`                     |
| MCP Service Endpoint | `http://localhost:4100/mcp/services/{serviceSlug}` |

Root-level `pnpm dev` now runs `pnpm -r --parallel --if-present run "/^dev(:admin)?$/"`. It therefore still starts the shared package's background `dev` and admin `dev:admin` as separate processes after the former Control Plane package is removed, while continuing to run other applications' `dev` scripts. Avoid root `pnpm dev` for MCP-only workflows; use the package-level commands instead.

## Typical workflow

1. An administrator creates a `MANAGED_MCP` service, which also creates the v1 draft.
2. Configure Tools and Prompts in the draft, or upload a ZIP and import initial values from `mcp.json`.
3. Validate Prompt-only versions directly. Versions containing Tools first inspect the artifact, install dependencies, and build an image.
4. An administrator publishes a `READY` version, making the service `ACTIVE`.
5. Create an MCP Client, issue an API Key, and configure a service Grant and scopes.
6. The MCP Client connects to the Gateway with the Bearer API Key and lists or invokes permitted Tools/Prompts.
7. An administrator can roll back to a historical version or disable the service to reject new MCP requests immediately. A disabled service can be enabled again.

Published versions are immutable. To change a Tool or Prompt, click "Create draft" in Studio Web on a published or superseded version (the `fork-draft` endpoint). The new draft copies the Tools, Prompts, runtime limits, and artifact references, and clears the image digest. A draft that contains Tools must be rebuilt before it can be validated and published, but the ZIP does not need to be uploaded again.

## Node.js Tool package contract

Uploads must be ZIP archives. A Tool package contains at least:

```text
tool-package.zip
  mcp.json
  package.json          must contain "type": "module"
  package-lock.json     required
  src/ or dist/
    index.js
```

Minimal `mcp.json`:

```json
{
  "schemaVersion": 1,
  "runtime": { "name": "nodejs", "version": "20" },
  "entry": "src/index.js",
  "tools": [
    {
      "name": "echo",
      "description": "Echo one value",
      "handler": "echoHandler",
      "inputSchema": {
        "type": "object",
        "properties": { "value": { "type": "string" } },
        "required": ["value"],
        "additionalProperties": false
      }
    }
  ],
  "prompts": [
    {
      "name": "summarize",
      "arguments": [{ "name": "text", "required": true }],
      "messages": [
        {
          "role": "user",
          "content": { "type": "text", "text": "Summarize {{text}}." }
        }
      ]
    }
  ],
  "limits": {
    "timeoutMs": 30000,
    "memoryMb": 256,
    "cpuMillis": 1000,
    "network": "none"
  }
}
```

The entry module exports `handlers`:

```js
export const handlers = {
  async echoHandler(args, context) {
    return {
      content: [{ type: "text", text: args.value }],
      structuredContent: { requestId: context.requestId },
    };
  },
};
```

`limits.network` must be `none` (networking disabled) or `bridge` (networking allowed). A Tool that calls an external API should declare `bridge` and keep its secrets in the service's "Environment variables", not in the package or in Tool arguments. The Worker reads these variables before every execution and injects them into the container, so updates need no rebuild.

Prompt-only services require no ZIP archive, Node.js runtime, dependency installation, or execution image. Prompt templates support only `{{name}}` text interpolation for declared arguments. They do not execute expressions, helpers, loops, conditions, or arbitrary code.

## Client authentication and authorization

Raw API Keys issued by the admin API are returned once. Only a hash is stored in the database. Grants support these scopes:

- `mcp:connect`
- `tools:list`
- `tools:call`
- `prompts:list`
- `prompts:get`

Grants can further restrict visibility with `toolNames` and `promptNames`.

For example, for a service publishing Tools `A`, `B`, and `C`:

| MCP Client Token | Grant scopes                              | `toolNames` | Listable and callable |
| ---------------- | ----------------------------------------- | ----------- | --------------------- |
| token1           | `mcp:connect`, `tools:list`, `tools:call` | `A`, `B`    | A and B only          |
| token2           | `mcp:connect`, `tools:list`, `tools:call` | `C`         | C only                |

`tools/list` and `tools/call` use the same name allowlist. An unauthorized Tool is omitted from listings, treated as not found on direct invocation, and never creates a Worker execution job.

MCP clients send requests as follows:

```http
POST /mcp/services/{serviceSlug} HTTP/1.1
Host: localhost:4100
Authorization: Bearer <raw-api-key>
Content-Type: application/json
```

The Gateway uses stateless Streamable HTTP. `GET` and `DELETE` return `405 Method Not Allowed`.

## Administration API overview

All administration endpoints are under `/api/admin/mcp`. Major endpoint groups include:

- `/services`: service CRUD, disable/enable, and version listing.
- `/services/:serviceId/environment`: read (variable names only) and update Tool runtime environment variables.
- `/services/:serviceId/versions/:versionId/limits`: update a version's timeout, memory, CPU, and network mode.
- `/services/:serviceId/versions/:versionId/tools`: Tool CRUD.
- `/services/:serviceId/versions/:versionId/prompts`: Prompt CRUD and preview.
- `/services/:serviceId/versions/:versionId/upload-url`: direct S3 upload URL.
- `/services/:serviceId/versions/:versionId/complete-upload`: confirm upload and create an inspection job.
- `/services/:serviceId/versions/:versionId/build`: create a build job.
- `/services/:serviceId/versions/:versionId/validate`: validate Prompt-only or already built versions.
- `/services/:serviceId/versions/:versionId/reset-to-draft`: return an unpublished `READY` version to draft.
- `/services/:serviceId/versions/:versionId/fork-draft`: create a new draft from a published or superseded version.
- `/services/:serviceId/versions/:versionId/publish`: publish a version.
- `/services/:serviceId/versions/:versionId/rollback`: roll back a version.
- `/builds`: list inspection and build jobs.
- `/audit` and `/audit/:eventId`: list audit events and show event details.
- `/clients`, `/clients/:id/keys`, and `/clients/:id/grants`: manage clients, Keys, and Grants.

Write operations use `expectedRevision` for optimistic concurrency control.

## Development and testing

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

Run only MCP platform tests:

```bash
pnpm --filter @open-agent-tools/mcp-contracts test
pnpm --filter @open-agent-tools/mcp-auth test
pnpm --filter @open-agent-tools/mcp-server test
pnpm --filter @open-agent-tools/mcp-worker test
pnpm --filter @open-agent-tools/studio-web test
pnpm --filter @open-agent-tools/mcp-nodejs-runner test
```

`mcp-worker test` covers both the merged Control Plane and background Worker tests; there is no separate test command for the removed package.

PostgreSQL integration tests run only when `TEST_DATABASE_URL` is set. They drop and recreate the target database's `public` schema, so use a dedicated test database:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_test \
  pnpm --filter @open-agent-tools/mcp-worker test
```

Docker E2E tests also require a local Docker daemon and a pre-built test Runner image.

## Security notes

- Uploaded code is processed only in isolated build/execution environments and must never be imported by the Web, Control Plane, or Gateway processes.
- Tool containers run as non-root with a read-only root filesystem, resource limits, and dropped capabilities. The published version's `limits.network` selects disabled networking (`none`) or network access (`bridge`).
- The Worker is a privileged infrastructure component. Deploy it on an isolated network and never expose it publicly.
- Runner and Tool images must be referenced by SHA-256 digest.
- API Keys, S3/Registry credentials, full Tool inputs/results, and rendered Prompt values must not appear in normal logs.
- Audit events store redacted requests and responses. Sensitive field names, `mcp.*` API Keys, Bearer tokens, URL credentials, and service environment variable values are masked, but business content such as Tool inputs and outputs may still contain sensitive data. The audit table is a controlled exception to the previous rule: expose it only to maintainers, and plan retention and archival.
- Secrets for networked Tools (`limits.network: "bridge"`) belong only in service environment variables. The values are never written to queue jobs or images, and they are masked in audit content.
- Without `WORKFLOW_HTTP_ALLOWLIST`, the workflow HTTP Request node can reach any HTTP/HTTPS target. Configure a hostname allowlist in production.
- Production deployments require TLS, backups, key rotation, rate limiting, and audit policies for PostgreSQL, Redis, S3, and the Registry.
- Keep the current anonymous administration plane on localhost or a trusted network. Restore identity authentication and authorization before exposing it publicly.

## Current limitations

- Managed Tools support Node.js 20 ESM/npm only. Python, Java, Yarn, pnpm Tool packages, Bun, and user-supplied Dockerfiles are not supported.
- Managed MCP Resources and remote MCP service proxying are not implemented.
- The administration console now provides Builds, Clients/Access, and Audit views; a dedicated Executions page is still pending.
- Studio Web, the Control Plane, and the Agent Server currently have no identity authentication or user isolation and must not be exposed directly to the public internet.
- The repository has no one-command Docker Compose or Kubernetes deployment manifest.
- Node.js 20 has reached upstream end-of-life. Production rollout requires a security exception or migration to a supported LTS with a corresponding runtime-contract update.

## Design and test documents

- [Node.js MCP management platform design](./docs/superpowers/specs/2026-07-31-mcp-management-platform-nodejs-design.md)
- [MCP management platform test plan](./docs/superpowers/plans/2026-07-31-mcp-management-platform-nodejs-test-plan.md)
