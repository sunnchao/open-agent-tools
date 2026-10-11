# MCP Worker

[中文](./README.md) | [Platform overview](../../README_EN.md) | [Control Plane admin API](./CONTROL_PLANE_EN.md)

`@open-agent-tools/mcp-worker` contains both the Control Plane admin API and the trusted background Worker, with separate entries, processes, and permissions. This guide covers the background Worker; see the [Control Plane guide](./CONTROL_PLANE_EN.md) for admin API responsibilities, endpoints, and access policy. One background Worker process consumes both artifact inspection/build jobs and Tool execution jobs while isolating untrusted user code with Docker.

The Worker can access Docker, object storage, the Registry, PostgreSQL, and Redis. It must run on an isolated restricted network and must never be exposed publicly.

The admin API only dispatches jobs through BullMQ. It does not start the background Worker or require Docker, a Runner image, or Registry permissions. Sharing a package does not combine processes or change the BullMQ and isolated Tool container boundaries. `apps/mcp-server` is outside this merge's scope; its structure and role remain unchanged.

## Code structure

Background Worker sources are layered by dependency direction: entry → queue → services → infrastructure. Admin API sources are organized separately under `control-plane/`.

```
src/
├── index.ts                     # Background Worker entry (composition root)
├── control-plane/               # Control Plane sources (separate admin API process)
│   ├── index.ts                 # Admin API entry, default port 4200
│   └── db/schema.ts             # Drizzle schema
├── workers/                     # BullMQ queue consumers
│   ├── build-queue.ts           # Build queue: artifact inspection and Tool builds
│   └── execution-queue.ts       # Execution queue: run published Tool images
├── services/                    # Domain services (workflow orchestration + port interfaces)
│   ├── artifact-inspection.ts   # Artifact inspection service
│   └── tool-build.ts            # Tool build service
└── infrastructure/              # Infrastructure adapters (concrete implementations)
    ├── archive.ts               # ZIP inspection and safe extraction
    ├── node-package.ts          # Node.js package and manifest validation
    ├── docker/                  # Docker: execution runtime, build commands, smoke verification, image building
    ├── platform/                # Platform command execution (spawn)
    ├── repository/              # PostgreSQL persistence
    └── storage/                 # S3 object storage (artifact download, SBOM upload)
```

Background Worker dependencies flow from `infrastructure` (providing port implementations) up through `services` (orchestration) to `workers` (queue consumption); layers never depend backwards. `control-plane/` has a separate entry and is not started by the background entry.

## Worker modes

The process creates two BullMQ Workers:

| Queue           | Constant             | Work                                      |
| --------------- | -------------------- | ----------------------------------------- |
| Build queue     | `mcp-tool-build`     | Artifact inspection and Tool image builds |
| Execution queue | `mcp-tool-execution` | Run published Tool images                 |

The build queue dispatches `INSPECT` or `BUILD` according to the durable PostgreSQL job kind, allowing redelivery to be handled idempotently.

## Artifact inspection flow

1. Stream the ZIP from S3/MinIO into a private temporary directory.
2. Verify the actual byte count and SHA-256 against Control Plane metadata.
3. Inspect ZIP entries, paths, file types, compression methods, and limits.
4. Extract safely while rejecting traversal, links, special files, and path conflicts.
5. Read and validate `mcp.json`, `package.json`, and `package-lock.json`.
6. Enforce Node.js 20, ESM, npm lockfile, and entry-file constraints.
7. Import manifest Tools/Prompts into the associated draft version.
8. Persist the outcome and stable failure code in PostgreSQL.

Default ZIP limits:

| Item                | Limit   |
| ------------------- | ------- |
| Compressed size     | 50 MiB  |
| Total expanded size | 200 MiB |
| Entries             | 10,000  |
| Individual file     | 25 MiB  |

## Tool build flow

1. Re-download and verify the artifact.
2. Repeat ZIP and Node.js package validation to prevent post-inspection drift.
3. Run `npm ci --ignore-scripts --no-audit --no-fund` in an isolated build container.
4. Run the only permitted build command, `npm run build`, when declared.
5. Load the entry in a verification container, check every handler, and run a smoke test.
6. Build the Tool image from a digest-pinned Runner base image.
7. Push to `TOOL_IMAGE_REPOSITORY` and read the Registry digest.
8. Generate a CycloneDX SBOM with Syft.
9. Scan `HIGH,CRITICAL` vulnerabilities with Trivy; a failed scan fails the build.
10. Upload the SBOM and persist `imageDigest`/`sbomObjectKey` in PostgreSQL.

Build failures use stable codes such as `NPM_INSTALL_FAILED`, `BUILD_COMMAND_FAILED`, `HANDLER_NOT_FOUND`, `SMOKE_TEST_FAILED`, and `IMAGE_BUILD_FAILED`.

## Tool execution flow

1. Read and validate a `ToolExecutionJob` from BullMQ.
2. Resolve the immutable `TOOL_IMAGE_REPOSITORY@sha256:...` image.
3. Create a read-only input file and output directory.
4. Load the service environment from the management database and inject it through Docker `Env` into a non-root, read-only-root container. Select `none` or `bridge` according to the published version's `limits.network`. Values do not pass through the queue or enter build containers.
5. Apply memory, CPU, PID, capability, log, and wall-clock limits.
6. The Runner reads `/run/tool/input.json`, invokes the handler, and writes `/run/tool/output.json`.
7. Validate output size and MCP `CallToolResult`, then return it to the Gateway.
8. Remove the container and temporary directory after every outcome.

Tool failures return protocol-safe `isError: true` results without stacks, host paths, or Docker details.

The Studio preview panel shows timeout, memory, CPU, and network limits and supports editing DRAFT, FAILED, and unpublished READY versions. Package inspection imports the initial `mcp.json` values; builds preserve subsequent panel edits. Processing and published versions are read-only. `bridge` enables network access without a domain allowlist. Build and smoke verification isolation is unchanged.

## Runtime requirements

- Docker Engine and an accessible Docker daemon
- Docker Buildx
- PostgreSQL 16
- Redis 7
- S3-compatible object storage
- A push/pull-capable OCI Registry
- `syft`
- `trivy`
- A controlled npm egress Docker network

## Environment variables

The unified example is `apps/mcp-worker/.env.example`. Run this from the repository root to create `.env` only if it is absent:

```bash
test -e apps/mcp-worker/.env || cp apps/mcp-worker/.env.example apps/mcp-worker/.env
```

If the former `apps/mcp-control-plane/.env` and Worker `.env` already exist, manually merge necessary former Control Plane values into the Worker's `.env` and resolve conflicts. Never overwrite existing environment files or secrets. The admin API no longer reads `.env` from the old directory.

Background `dev`/`dev:worker` load the Worker's `.env` through Node.js `--env-file=.env`; `start`/`start:worker` still require variables injected by the process manager or shell. Admin `dev:admin`/`start:admin` retain the existing `dotenv` loading from the same directory. Production deployments should inject each process's required variables separately and grant only its required privileges; give the admin API no Docker socket or Registry permissions.

The following variables are for the background Worker; see the [Control Plane guide](./CONTROL_PLANE_EN.md#environment-variables) for admin API configuration:

| Variable                | Required              | Description                                                                               |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `REDIS_URL`             | Yes                   | Both BullMQ queues                                                                        |
| `DATABASE_URL`          | Yes                   | Same management database as the Control Plane                                             |
| `TOOL_IMAGE_REPOSITORY` | Yes                   | Tool image repository                                                                     |
| `MCP_RUNNER_IMAGE`      | Yes                   | Must be `repository@sha256:...`                                                           |
| `NPM_NETWORK`           | No                    | Docker network for dependency installation, default `bridge`                              |
| `DOCKER_SOCKET_PATH`    | No                    | Absolute Docker socket path; required for non-default contexts such as OrbStack           |
| `BUILDX_ATTESTATIONS`   | No                    | Buildx provenance/SBOM attestations, default `true`; local docker drivers may set `false` |
| `EXECUTION_CONCURRENCY` | No                    | Tool concurrency, default `4`                                                             |
| `BUILD_CONCURRENCY`     | No                    | Inspection/build concurrency, default `2`                                                 |
| `ARTIFACT_S3_BUCKET`    | Yes                   | Artifact and SBOM bucket                                                                  |
| `ARTIFACT_S3_REGION`    | No                    | Default `us-east-1`                                                                       |
| `ARTIFACT_S3_ENDPOINT`  | No                    | Custom endpoint for MinIO or similar                                                      |
| `AWS_ACCESS_KEY_ID`     | Environment-dependent | S3 credentials                                                                            |
| `AWS_SECRET_ACCESS_KEY` | Environment-dependent | S3 credentials                                                                            |

## Database migrations

The Drizzle schema is `src/control-plane/db/schema.ts`, and migrations are in this package's `drizzle/` directory (`apps/mcp-worker/drizzle/` from the repository root). Existing SQL and the journal are unchanged. Drizzle reads `DATABASE_URL` from the process environment:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_management
pnpm --filter @open-agent-tools/mcp-worker db:migrate
```

Use `pnpm --filter @open-agent-tools/mcp-worker db:generate` to generate new migrations after schema changes. The former `apps/mcp-control-plane` is no longer a workspace package or source tree; only README redirects and `drizzle -> ../mcp-worker/drizzle` remain for consumers of the legacy migration path. Do not modify `apps/mcp-server`.

## Running

### Background Worker

Start the background process from the repository root (it has no HTTP port):

```bash
pnpm --filter @open-agent-tools/mcp-worker dev
```

`dev:worker` is the explicit alias. Both `dev` and `dev:worker` run only `src/index.ts` and do not start the admin API.

Production build and background startup (with environment variables injected first):

```bash
pnpm --filter @open-agent-tools/mcp-worker build
pnpm --filter @open-agent-tools/mcp-worker start
```

`start:worker` is the explicit alias; both scripts run only `dist/index.js`. Monitor background process liveness, BullMQ Worker state, queue metrics, and PostgreSQL job heartbeats.

### Admin API (Control Plane)

With PostgreSQL, Redis, S3 configuration, and migrations ready, start the admin API independently. Docker, a Runner image, a Registry, Syft, and Trivy are not required:

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:admin
```

This script runs only `src/control-plane/index.ts`. Production build and admin startup:

```bash
pnpm --filter @open-agent-tools/mcp-worker build
pnpm --filter @open-agent-tools/mcp-worker start:admin
```

`start:admin` runs only `dist/control-plane/index.js`, with the default health endpoint at `http://localhost:4200/health`. Start the background Worker in a separate process for full Tool workflows. None of these package-level startup scripts starts both roles.

## Runner image

Build and push the Runner from the repository root:

```bash
docker build -f runtimes/nodejs/Dockerfile -t registry.example.com/mcp-runner:local .
docker push registry.example.com/mcp-runner:local
docker inspect --format='{{index .RepoDigests 0}}' registry.example.com/mcp-runner:local
```

Set `MCP_RUNNER_IMAGE` to the resulting `repository@sha256:...`. The Worker rejects Runner images that are not digest-pinned.

## Docker security configuration

Execution containers use:

- `NetworkMode: none`
- Non-root Runner user
- `ReadonlyRootfs: true`
- Tmpfs for `/tmp` and `/run/tool`
- `CapDrop: ALL`
- `no-new-privileges`
- Maximum 64 PIDs
- No host mounts or Docker socket mount
- Manifest-defined memory, CPU, and timeout limits

The Worker itself needs Docker socket access, but user Tool containers must never receive that socket.

## Testing

```bash
pnpm --filter @open-agent-tools/mcp-worker test
pnpm --filter @open-agent-tools/mcp-worker typecheck
pnpm --filter @open-agent-tools/mcp-worker lint
```

The same test command covers background Worker tests and admin API tests under `src/control-plane/`; do not repeat tests for the removed Control Plane package.

Some tests require:

- PostgreSQL: set a dedicated `TEST_DATABASE_URL`; related tests drop and recreate the target database's `public` schema.
- Docker E2E: a local Docker daemon and pre-built test Runner/fixture images.
- Production S3, Registry, Syft, and Trivy integrations should be verified in the deployment pipeline.

## Current limitations

- Node.js 20, ESM, and npm lockfiles only.
- npm lifecycle scripts are disabled with `--ignore-scripts`; packages that require them cannot build.
- Tool execution is network-disabled only.
- Inspection, build, and execution Workers still share one background process, separate from the admin API process; production may further split background entry points for permissions and scaling.
- Registry signing, remote attestation, and Kubernetes sandboxes are not integrated.
