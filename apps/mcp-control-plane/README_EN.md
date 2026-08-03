# MCP Control Plane

[中文](./README.md) | [Platform overview](../../README_EN.md)

`@open-agent-tools/mcp-control-plane` is the management service for the MCP platform. It manages services, versions, Tools, Prompts, upload/build jobs, and MCP Client API Keys and Grants. It does not execute uploaded code or handle MCP protocol requests directly.

## Responsibilities

- Currently map every `/api/admin/mcp` request to an anonymous `admin`, without login or a Bearer Token.
- Manage `MANAGED_MCP` services and immutable versions.
- Manage draft Tools, Prompts, and Prompt previews.
- Issue S3 presigned upload URLs and confirm ZIP size/SHA-256 metadata.
- Persist inspection/build jobs in PostgreSQL before dispatching them through BullMQ.
- Manage MCP Clients, one-time-visible API Keys, scopes, and name-filtered Grants.
- Query persistent Build Jobs and record/query administration mutation audit events.
- Enforce optimistic concurrency through `revision`/`expectedRevision`.
- Publish and roll back versions atomically in PostgreSQL transactions.

## Out of scope

- The Control Plane never extracts, installs, or executes user code in its own process.
- It does not serve `/mcp/services/:serviceSlug`; that endpoint belongs to the MCP Gateway.
- The current HTTP create endpoint accepts `MANAGED_MCP` only. Remote MCP management is not wired into the runtime entry point.

## Runtime dependencies

- PostgreSQL 16
- Redis/BullMQ
- S3-compatible object storage
- `@open-agent-tools/mcp-auth`
- `@open-agent-tools/mcp-contracts`

## Environment variables

Create a local configuration from the example:

```bash
cp .env.example .env
```

| Variable                | Required              | Description                                          |
| ----------------------- | --------------------- | ---------------------------------------------------- |
| `DATABASE_URL`          | Yes                   | MCP management database connection string            |
| `REDIS_URL`             | Yes                   | Artifact inspection/build queue                      |
| `ARTIFACT_S3_BUCKET`    | Yes                   | ZIP and SBOM bucket                                  |
| `ARTIFACT_S3_REGION`    | No                    | Default `us-east-1`                                  |
| `ARTIFACT_S3_ENDPOINT`  | No                    | Custom endpoint for MinIO; enables path-style access |
| `AWS_ACCESS_KEY_ID`     | Environment-dependent | S3 credentials                                       |
| `AWS_SECRET_ACCESS_KEY` | Environment-dependent | S3 credentials                                       |
| `PORT`                  | No                    | HTTP port, default `4200`                            |

## Database migrations

Drizzle reads `DATABASE_URL` from the process environment:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_management
pnpm --filter @open-agent-tools/mcp-control-plane db:migrate
```

Migration files:

- `drizzle/0000_mcp_management.sql`
- `drizzle/0001_mcp_client_access.sql`
- `drizzle/0002_mcp_build_jobs.sql`
- `drizzle/0003_mcp_audit_events.sql`

The Gateway and Worker must use the same migrated database.

## Running

From the repository root:

```bash
pnpm --filter @open-agent-tools/mcp-control-plane dev
```

Production build and start:

```bash
pnpm --filter @open-agent-tools/mcp-control-plane build
pnpm --filter @open-agent-tools/mcp-control-plane start
```

Health endpoint:

```text
GET http://localhost:4200/health
```

## Current access model and internal roles

The default entry point does not configure an authenticator. Any visitor can call `/api/admin/mcp`; requests run as `{ id: "anonymous", role: "admin" }`. MCP Web therefore requires no login and sends no administration Token.

This is a temporary development policy, not a production security boundary. The anonymous administration API can create Clients, issue API Keys, change Grants, publish code, and disable services. Deploy it only on localhost or a trusted network, and never expose it directly to the public internet.

The Control Plane retains this internal role model for tests and for a future authenticator integration:

| Capability                                      | admin | operator | auditor |
| ----------------------------------------------- | ----- | -------- | ------- |
| Read services and versions                      | Yes   | Yes      | Yes     |
| Create/edit services, Tools, and Prompts        | Yes   | Yes      | No      |
| Upload, validate, and create build jobs         | Yes   | Yes      | No      |
| Publish, roll back, disable, or delete services | Yes   | No       | No      |
| Create/revoke Client Keys and Grants            | Yes   | No       | No      |
| Read Client, Key metadata, and Grants           | Yes   | No       | Yes     |
| Read administration audit events                | Yes   | No       | Yes     |

The raw API Key appears only in the create response. Key listings expose neither the hash nor the original value.

The default anonymous mode always uses `admin` privileges. MCP Web currently provides no role selector.

## Service and version states

Service states:

```text
DRAFT -> ACTIVE -> DISABLED -> DELETED
```

Managed version states:

```text
DRAFT -> VALIDATING -> BUILDING -> READY -> PUBLISHED -> SUPERSEDED
                    \-> FAILED
```

- Prompt-only drafts can validate to `READY` without an image.
- Versions containing Tools require a built `imageDigest` before becoming `READY`.
- Only `READY` versions can be published.
- Published versions are immutable.
- Rollback switches to an existing `READY` or `SUPERSEDED` version without rebuilding it.

## API groups

All administration APIs start with `/api/admin/mcp`.

### Services

```text
GET    /services
POST   /services
GET    /services/:serviceId
PATCH  /services/:serviceId
DELETE /services/:serviceId
POST   /services/:serviceId/disable
GET    /services/:serviceId/versions
```

### Tools and Prompts

```text
GET|POST          /services/:serviceId/versions/:versionId/tools
PATCH|DELETE      /services/:serviceId/versions/:versionId/tools/:toolId
GET|POST          /services/:serviceId/versions/:versionId/prompts
PATCH|DELETE      /services/:serviceId/versions/:versionId/prompts/:promptId
POST              /services/:serviceId/versions/:versionId/prompts/:promptId/preview
```

### Upload, build, and publication

```text
POST /services/:serviceId/versions/:versionId/upload-url
POST /services/:serviceId/versions/:versionId/complete-upload
POST /services/:serviceId/versions/:versionId/build
POST /services/:serviceId/versions/:versionId/validate
POST /services/:serviceId/versions/:versionId/publish
POST /services/:serviceId/versions/:versionId/rollback
```

### Client access

```text
GET|POST     /clients
GET|POST     /clients/:clientId/keys
DELETE       /clients/:clientId/keys/:keyId
GET          /clients/:clientId/grants
PUT|DELETE   /clients/:clientId/grants/:serviceId
```

Grant scopes are `mcp:connect`, `tools:list`, `tools:call`, `prompts:list`, and `prompts:get`. Every Grant must contain `mcp:connect`; `toolNames`/`promptNames` can further restrict capability names.

For example, if a service contains Tools `A`, `B`, and `C`, configure Client 1 with `toolNames: ["A", "B"]` and Client 2 with `toolNames: ["C"]`. With both `tools:list` and `tools:call` granted, each API Key can list and invoke only the Tools in its own allowlist.

### Builds and audit

```text
GET /builds?limit=100
GET /audit?limit=100&outcome=FAILED&action=POST
```

Build queries return persistent `INSPECT`/`BUILD` Jobs with stage, status, attempt count, and error code. Audit queries support outcome and action filters and are readable by administrators and auditors.

The audit middleware records the actor, HTTP action, target path, status code, duration, and Request ID for non-GET administration requests. It never records request bodies, API Keys, Tool inputs/results, or Prompt content.

## Error and concurrency contract

Stable management error codes include:

- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `CONFLICT`
- `IMMUTABLE_VERSION`
- `INVALID_STATE`

Mutation requests carry a positive `expectedRevision`. Revision mismatches return `409 CONFLICT`. Publication and rollback also use database transactions and row locks so each service has exactly one `PUBLISHED` version.

## Testing

```bash
pnpm --filter @open-agent-tools/mcp-control-plane test
pnpm --filter @open-agent-tools/mcp-control-plane typecheck
pnpm --filter @open-agent-tools/mcp-control-plane lint
```

PostgreSQL tests run only when `TEST_DATABASE_URL` is set. They drop and recreate the target database's `public` schema, so always use a dedicated test database:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_test \
  pnpm --filter @open-agent-tools/mcp-control-plane test
```

## Current limitations

- The administration API currently has no identity authentication or user isolation and is suitable only for local development or a trusted network.
- The create endpoint does not yet support `REMOTE_MCP`.
- Full automatic draft forking from a published version still needs to be completed.
- No Execution query API is available; Build and Audit queries currently return at most 200 records.
- Audit export, archival, retention policies, and distributed Gateway cache invalidation are not integrated yet.
