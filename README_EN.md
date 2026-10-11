# open-agent-tools MCP Management Platform

[中文](./README.md)

This repository is a pnpm and TypeScript monorepo. This README focuses on the MCP management platform, where administrators configure, build, publish, and roll back managed MCP services. MCP clients access published Tools and Prompts through API Keys and fine-grained grants.

`apps/studio-web` is the unified visual surface for Agent Chat, MCP administration, RAG knowledge bases, and workflow orchestration. `apps/cli` and `apps/server` can still run independently.

## Current capabilities

- Manage the lifecycle of managed MCP services and versions: draft, validate, build, publish, roll back, disable, and soft-delete.
- Configure Tool-only, Prompt-only, or mixed Tools + Prompts services.
- Add, update, and delete Tools and Prompts on draft versions.
- Upload Node.js Tool ZIP archives, validate archive/npm package structure, run `npm ci`, and run an optional build.
- Build and push digest-addressed OCI images, generate CycloneDX SBOMs, and scan images with Trivy.
- Execute Tools in isolated Docker containers; validate and render Prompts directly in the Gateway.
- Keep Studio Web and the administration API temporarily anonymous, with every visitor acting as an administrator.
- Issue one-time-visible API Keys for MCP clients and authorize by service, scope, Tool name, and Prompt name.
- Expose `tools/list`, `tools/call`, `prompts/list`, and `prompts/get` over Streamable HTTP.
- Provide a React administration console for service, Tool, Prompt, build, and version workflows.
- IM collaboration entry: configure Feishu/DingTalk bots visually in Studio Web "Settings → IM Channels" (multi-channel, encrypted secrets, knowledge base binding); @-mentioning a bot in a group answers from Agent Chat + RAG knowledge base.

The managed runtime currently supports Node.js 20, ESM, and npm only. Python, Java, managed MCP Resources, and remote MCP proxying are outside the currently runnable scope.

## Architecture

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

| Component      | Package                               | Responsibility                                                                                |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Control Plane  | `@open-agent-tools/mcp-worker`        | Anonymous admin API, service versions, client Keys/Grants, upload and build orchestration     |
| MCP Gateway    | `@open-agent-tools/mcp-server`        | MCP protocol endpoint, API Key authentication, scope checks, Tool calls, and Prompt rendering |
| MCP Worker     | `@open-agent-tools/mcp-worker`        | ZIP inspection, dependency installation, image build/scan, and Tool container execution       |
| Studio Web     | `@open-agent-tools/studio-web`        | Unified React workspace for Agent, MCP, RAG, and workflows                                    |
| RAG Server     | `@open-agent-tools/rag-server`        | Document ingestion, SQLite indexing, hybrid retrieval, and optional LLM answers               |
| Contracts      | `@open-agent-tools/mcp-contracts`     | Shared Zod contracts for manifests, Prompts, jobs, and Runner I/O                             |
| Auth           | `@open-agent-tools/mcp-auth`          | API Key generation, parsing, hashing, and verification                                        |
| Node.js Runner | `@open-agent-tools/mcp-nodejs-runner` | Loads handlers inside Tool containers and validates MCP results                               |

The Control Plane and Worker share the `@open-agent-tools/mcp-worker` package, but remain separate processes and permission boundaries. The admin API dispatches work through BullMQ, and Tools still run in isolated containers. The admin API needs no Docker socket, Runner image, or Registry permissions; those capabilities belong only to the background Worker. `apps/mcp-server` is outside this merge's scope: its structure, role, and startup remain unchanged.

## Repository layout

```text
apps/
  mcp-control-plane/       README redirects and legacy drizzle symlink (no workspace package)
  mcp-server/              Dynamic MCP Gateway
  mcp-worker/              Shared Control Plane and background Worker package
    src/index.ts          Background Worker entry
    src/control-plane/    Control Plane sources and admin API entry index.ts
    drizzle/              PostgreSQL migration SQL and journal
  studio-web/              Unified React workspace
  rag-server/              RAG HTTP API and SQLite data
packages/
  mcp-auth/                MCP API Key contract
  mcp-contracts/           Cross-service data contracts
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

| Component       | English                                            | 中文文档                                     |
| --------------- | -------------------------------------------------- | -------------------------------------------- |
| CLI Agent       | [README_EN](./apps/cli/README_EN.md)               | [README](./apps/cli/README.md)               |
| Control Plane   | [CONTROL_PLANE_EN](./apps/mcp-worker/CONTROL_PLANE_EN.md) | [CONTROL_PLANE](./apps/mcp-worker/CONTROL_PLANE.md) |
| MCP Gateway     | [README_EN](./apps/mcp-server/README_EN.md)        | [README](./apps/mcp-server/README.md)        |
| MCP Worker      | [README_EN](./apps/mcp-worker/README_EN.md)        | [README](./apps/mcp-worker/README.md)        |
| Studio Web      | [README_EN](./apps/studio-web/README_EN.md)        | [README](./apps/studio-web/README.md)        |
| RAG Server      | [README](./apps/rag-server/README.md)              | -                                            |
| MCP Auth        | [README_EN](./packages/mcp-auth/README_EN.md)      | [README](./packages/mcp-auth/README.md)      |
| MCP Contracts   | [README_EN](./packages/mcp-contracts/README_EN.md) | [README](./packages/mcp-contracts/README.md) |
| Node.js Runtime | [README_EN](./runtimes/nodejs/README_EN.md)        | [README](./runtimes/nodejs/README.md)        |

## Prerequisites

- Node.js 20 or later. The managed Tool runtime contract is fixed to Node.js 20.
- pnpm 10.32.1.
- PostgreSQL 16. The Control Plane and Gateway must use the same database.
- Redis 7 or a compatible service.
- An S3-compatible object store, such as AWS S3 or MinIO, with a pre-created artifact bucket.
- Docker Engine, Docker Buildx, and a Docker daemon accessible to the Worker.
- An OCI Registry, with the Worker environment already authenticated.
- `syft` and `trivy` installed on the Worker host.

The repository does not currently include Docker Compose. PostgreSQL, Redis, object storage, and the Registry must be provisioned separately.

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

## Configuration

### Shared Control Plane and Worker configuration

The unified example is `apps/mcp-worker/.env.example`. Create `.env` only if it does not exist:

```bash
test -e apps/mcp-worker/.env || cp apps/mcp-worker/.env.example apps/mcp-worker/.env
```

If both the former `apps/mcp-control-plane/.env` and `apps/mcp-worker/.env` already contain local settings, manually merge the necessary former Control Plane values into the Worker's `.env`, checking database, Redis, S3 credential, and port conflicts. Never overwrite existing `.env` files or secrets. The admin API no longer reads `.env` from the old directory. Production deployments should still inject only the variables and permissions each process needs; sharing a package does not grant the admin API Docker/Registry access.

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

### Studio Web

The development server proxies the MCP administration API, Gateway, and RAG API to ports `4200`, `4100`, and `4001` respectively:

```bash
pnpm --filter @open-agent-tools/studio-web dev
```

Studio Web currently performs no authentication and reads no browser Token. The Control Plane also handles every administration request as an anonymous `admin`. This mode is suitable only for local development or a trusted network and must not be exposed directly to the public internet.

## Database migrations

Set the same `DATABASE_URL` used by the Control Plane, then run:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_management
pnpm --filter @open-agent-tools/mcp-worker db:migrate
```

The schema is `apps/mcp-worker/src/control-plane/db/schema.ts`, and migrations are stored in `apps/mcp-worker/drizzle/`. Existing SQL and the journal are unchanged. To generate a new migration after a schema change, use `pnpm --filter @open-agent-tools/mcp-worker db:generate`.

The former `apps/mcp-control-plane` is no longer a workspace package or source tree. Only README redirects and the `drizzle -> ../mcp-worker/drizzle` symlink remain to preserve consumers' legacy migration paths; `apps/mcp-server` is entirely untouched. Do not point the Control Plane and Gateway at different databases, or the Gateway will not see published services and client grants.

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
pnpm --filter @open-agent-tools/studio-web dev
```

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
7. An administrator can roll back to a historical version or disable the service to reject new MCP requests immediately.

Published versions are immutable. Tool or Prompt changes should be made in a new draft version. Full automatic draft forking from an existing published version is still being completed in the current administration API.

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

- `/services`: service CRUD, disable, and version listing.
- `/services/:serviceId/versions/:versionId/tools`: Tool CRUD.
- `/services/:serviceId/versions/:versionId/prompts`: Prompt CRUD and preview.
- `/services/:serviceId/versions/:versionId/upload-url`: direct S3 upload URL.
- `/services/:serviceId/versions/:versionId/complete-upload`: confirm upload and create an inspection job.
- `/services/:serviceId/versions/:versionId/build`: create a build job.
- `/services/:serviceId/versions/:versionId/validate`: validate Prompt-only or already built versions.
- `/services/:serviceId/versions/:versionId/publish`: publish a version.
- `/services/:serviceId/versions/:versionId/rollback`: roll back a version.
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
- Production deployments require TLS, backups, key rotation, rate limiting, and audit policies for PostgreSQL, Redis, S3, and the Registry.
- Keep the current anonymous administration plane on localhost or a trusted network. Restore identity authentication and authorization before exposing it publicly.

## Current limitations

- Managed Tools support Node.js 20 ESM/npm only. Python, Java, Yarn, pnpm Tool packages, Bun, and user-supplied Dockerfiles are not supported.
- Managed MCP Resources and remote MCP service proxying are not implemented.
- The administration console now provides Builds, Clients/Access, and Audit views; a dedicated Executions page is still pending.
- Studio Web and the Control Plane currently have no identity authentication or user isolation and must not be exposed directly to the public internet.
- The repository has no one-command Docker Compose or Kubernetes deployment manifest.
- Node.js 20 has reached upstream end-of-life. Production rollout requires a security exception or migration to a supported LTS with a corresponding runtime-contract update.

## Design and test documents

- [Node.js MCP management platform design](./docs/superpowers/specs/2026-07-31-mcp-management-platform-nodejs-design.md)
- [MCP management platform test plan](./docs/superpowers/plans/2026-07-31-mcp-management-platform-nodejs-test-plan.md)
