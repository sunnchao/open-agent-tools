# MCP Web

[中文](./README.md) | [Platform overview](../../README_EN.md)

`@open-agent-tools/mcp-web` is the React administration console for the MCP platform. It manages services, Tools, Prompts, artifacts, builds, and version lifecycles through the Control Plane API.

## Technology

- React 19
- TypeScript
- Vite 5
- Lucide React
- Vitest, Testing Library, and JSDOM

## Current features

- Browse and refresh the MCP service registry.
- Create and update managed service metadata.
- View service state, current version, and version history.
- Add, update, and delete Tools on draft versions.
- Add, update, and delete Prompts on draft versions.
- Preview Prompts using the actual Control Plane renderer.
- Calculate ZIP SHA-256, request a presigned URL, and upload directly to object storage.
- Create Tool build jobs.
- View recent inspection/build jobs and filter them by status.
- Create MCP Clients and issue or revoke one-time-visible API Keys.
- Configure per-client Service Grants, scopes, and Tool/Prompt name allowlists.
- View administration audit events and filter them by outcome or action.
- Validate Prompt-only versions.
- Allow administrators to publish, roll back, disable, or delete services.
- Allow access without login and show all administration actions by default.
- Provide responsive desktop and narrow-screen layouts.

## Layout

```text
src/
  App.tsx             Administration page, forms, and state flow
  operations.tsx      Builds, Clients/Access, and Audit operational views
  api.ts              Control Plane API client and DTOs
  styles.css          Responsive visual styles
  main.tsx            Browser entry point
  App.test.tsx        Administration workflow component tests
  api.test.ts         API client tests
vite.config.ts        Vite and local API proxy
```

## Runtime dependencies

- Node.js 20+
- A running MCP Control Plane
- For Tool uploads, S3/MinIO presigned URLs must allow cross-origin browser PUTs

## Local development

Vite proxies `/api` to `http://localhost:4200` by default:

```bash
pnpm --filter @open-agent-tools/mcp-web dev
```

Open:

```text
http://localhost:4300
```

## Access model

MCP Web currently performs no identity authentication. Anyone who can reach its URL can enter the administration console. The default `McpApiClient` reads no browser Token and sends no `Authorization` header to `/api/admin/mcp`; the Control Plane handles the request as an anonymous `admin`.

`App` retains its `role` prop for component tests and future integrations, but the production entry point uses the default `admin` role and exposes no role selector.

This mode is suitable only for local development or a trusted network. Do not expose MCP Web or the Control Plane directly to the public internet: any visitor can modify services, publish Tools, issue MCP Client API Keys, and change Grants.

Anonymous access applies only to the administration plane. An MCP Client that lists or invokes Tools must still submit a Bearer API Key to the Gateway and remains subject to scopes and the `toolNames` allowlist.

## Tool editor

The Tool form configures:

- MCP name
- Description
- JavaScript handler export name
- JSON Object Input Schema

Only draft versions are editable. Versions containing Tools also require a compliant Node.js ZIP upload and successful build.

## Prompt editor

The Prompt form configures:

- Name, title, and description
- Argument name, description, and required flag
- Ordered `user`/`assistant` text messages
- `{{argumentName}}` placeholders

The preview dialog collects Prompt arguments and calls the server-side preview endpoint so results match Gateway `prompts/get`.

## Artifact upload

Browser upload flow:

1. Calculate file SHA-256 with Web Crypto.
2. Request `/upload-url` with the digest and file size.
3. PUT directly to S3/MinIO using the returned method, headers, and URL.
4. Call `/complete-upload` with object key, digest, size, and `expectedRevision`.
5. The Control Plane creates a durable `INSPECT` job.

Object-store CORS must allow the Web origin, `PUT`, signed headers, and required preflight requests.

## API client

`src/api.ts` exports:

- `McpApiClient`
- `McpApiError`
- The `McpAdminApi` interface
- Service, version, Tool, Prompt, Build, Client, Grant, and Audit DTOs

Component tests inject an `McpAdminApi` fake to isolate network dependencies. The production entry point uses the default `McpApiClient`.

## Build and preview

```bash
pnpm --filter @open-agent-tools/mcp-web build
pnpm --filter @open-agent-tools/mcp-web preview
```

Production deployment must reverse-proxy `/api` to the Control Plane and serve both the page and API over HTTPS.

## Testing

```bash
pnpm --filter @open-agent-tools/mcp-web test
pnpm --filter @open-agent-tools/mcp-web typecheck
pnpm --filter @open-agent-tools/mcp-web lint
```

Tests cover API URLs/bodies, error mapping, role actions, Prompt preview, rollback and disable controls, Build queries, Client/API Key workflows, Tool allowlist Grants, and Audit filters.

## Current limitations

- The administration plane has no identity authentication or user isolation and is suitable only for local development or a trusted network.
- No service or Client search, service type/status filters, or server-side pagination.
- No dedicated Executions page; Builds and Audit currently load the latest 100 records each.
- Audit export, archival, and retention-policy configuration are not implemented.
- Artifact uploads have no resume or multipart support.
- The operation for creating a new draft from a published version is not wired in yet.
