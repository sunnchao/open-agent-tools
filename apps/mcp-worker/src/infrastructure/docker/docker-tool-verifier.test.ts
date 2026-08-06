import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactInspectionJob, ManagedMcpManifest } from "@open-agent-tools/mcp-contracts";

import {
  DockerToolPackageVerifier,
  type VerificationContainer,
  type VerificationContainerCreateOptions,
  type VerificationDockerClient,
} from "./docker-tool-verifier.js";
import { NODE20_BUILD_IMAGE } from "./docker-build-command.js";
import { ToolPackageVerificationError } from "../../services/tool-build.js";

const manifest: ManagedMcpManifest = {
  schemaVersion: 1,
  runtime: { name: "nodejs", version: "20" },
  entry: "src/index.js",
  tools: [
    {
      name: "get_report",
      handler: "getReport",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ],
  prompts: [],
  limits: { timeoutMs: 30_000, memoryMb: 256, cpuMillis: 1_000, network: "none" },
};
const job: ArtifactInspectionJob = {
  buildJobId: "build-1",
  serviceId: "service-1",
  versionId: "version-1",
  versionRevision: 3,
  objectKey: "artifact.zip",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  artifactSize: 1024,
};

class FakeContainer implements VerificationContainer {
  removed = false;
  constructor(readonly statusCode: number) {}
  async start(): Promise<void> {}
  async wait() {
    return { StatusCode: this.statusCode };
  }
  async kill(): Promise<void> {}
  async remove(): Promise<void> {
    this.removed = true;
  }
}

test("BLD-003 verifies handlers and smoke results in a networkless non-root container", async () => {
  let options: VerificationContainerCreateOptions | undefined;
  const container = new FakeContainer(0);
  const docker: VerificationDockerClient = {
    createContainer: async (input) => {
      options = input;
      return container;
    },
  };
  await new DockerToolPackageVerifier(docker).verify("/tmp/build/package", manifest, job);

  assert.equal(options?.Image, NODE20_BUILD_IMAGE);
  assert.equal(options?.User, "node");
  assert.equal(options?.WorkingDir, "/workspace");
  assert.equal(options?.Cmd[0], "node");
  assert.deepEqual(options?.HostConfig, {
    AutoRemove: false,
    NetworkMode: "none",
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    PidsLimit: 64,
    Memory: 256 * 1024 * 1024,
    NanoCpus: 1_000_000_000,
    Binds: ["/tmp/build/package:/workspace:ro"],
    Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216" },
  });
  assert.equal(container.removed, true);
});

test("BLD-003 maps missing handlers and invalid smoke results to stable codes", async () => {
  for (const [statusCode, expectedCode] of [
    [42, "HANDLER_NOT_FOUND"],
    [43, "SMOKE_TEST_FAILED"],
  ] as const) {
    const docker: VerificationDockerClient = {
      createContainer: async () => new FakeContainer(statusCode),
    };
    await assert.rejects(
      new DockerToolPackageVerifier(docker).verify("/tmp/build/package", manifest, job),
      (error: unknown) =>
        error instanceof ToolPackageVerificationError && error.code === expectedCode,
    );
  }
});
