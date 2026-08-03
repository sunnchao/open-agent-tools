# MCP Worker

[中文](./README.md) | [Platform overview](../../README_EN.md)

`@open-agent-tools/mcp-worker` is the trusted background execution component of the MCP platform. One Worker process consumes both artifact inspection/build jobs and Tool execution jobs while isolating untrusted user code with Docker.

The Worker can access Docker, object storage, the Registry, PostgreSQL, and Redis. It must run on an isolated restricted network and must never be exposed publicly.

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
4. Create a non-root, network-disabled, read-only-root container.
5. Apply memory, CPU, PID, capability, log, and wall-clock limits.
6. The Runner reads `/run/tool/input.json`, invokes the handler, and writes `/run/tool/output.json`.
7. Validate output size and MCP `CallToolResult`, then return it to the Gateway.
8. Remove the container and temporary directory after every outcome.

Tool failures return protocol-safe `isError: true` results without stacks, host paths, or Docker details.

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

```bash
cp .env.example .env
```

The development script loads variables from `.env` through Node.js `--env-file`; production startup still requires variables injected by the process manager or shell:

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

## Running

Bash/Zsh example:

```bash
pnpm --filter @open-agent-tools/mcp-worker dev
```

Production build:

```bash
pnpm --filter @open-agent-tools/mcp-worker build
pnpm --filter @open-agent-tools/mcp-worker start
```

The process has no HTTP port. Monitor process liveness, BullMQ Worker state, queue metrics, and PostgreSQL job heartbeats.

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

Some tests require:

- PostgreSQL: set a dedicated `TEST_DATABASE_URL`; related tests drop and recreate the target database's `public` schema.
- Docker E2E: a local Docker daemon and pre-built test Runner/fixture images.
- Production S3, Registry, Syft, and Trivy integrations should be verified in the deployment pipeline.

## Current limitations

- Node.js 20, ESM, and npm lockfiles only.
- npm lifecycle scripts are disabled with `--ignore-scripts`; packages that require them cannot build.
- Tool execution is network-disabled only.
- Inspection, build, and execution Workers currently share one process; production may split entry points for permissions and scaling.
- Registry signing, remote attestation, and Kubernetes sandboxes are not integrated.
