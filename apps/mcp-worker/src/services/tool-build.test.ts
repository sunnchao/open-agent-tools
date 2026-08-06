import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { ArtifactInspectionJob, ManagedMcpManifest } from "@open-agent-tools/mcp-contracts";
import { ZipFile } from "yazl";

import {
  ToolBuildService,
  ToolPackageVerificationError,
  type BuildCommandRunner,
  type BuildJobRepository,
  type ToolImageBuilder,
  type ToolPackageVerifier,
} from "./tool-build.js";

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

const packageJson = { name: "report-tools", version: "1.0.0", type: "module" };
const packageLock = {
  name: "report-tools",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: { "": { name: "report-tools", version: "1.0.0" } },
};

async function createZip(overrides: Record<string, string> = {}): Promise<Buffer> {
  const archive = new ZipFile();
  const files = {
    "mcp.json": JSON.stringify(manifest),
    "package.json": JSON.stringify(packageJson),
    "package-lock.json": JSON.stringify(packageLock),
    "src/index.js":
      "export const handlers = { getReport: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };\n",
    ...overrides,
  };
  for (const [name, contents] of Object.entries(files)) {
    archive.addBuffer(Buffer.from(contents), name);
  }
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
  });
  archive.end();
  return completed;
}

function jobFor(archive: Buffer): ArtifactInspectionJob {
  return {
    buildJobId: "build-1",
    serviceId: "service-1",
    versionId: "version-1",
    versionRevision: 3,
    objectKey: "service-1/version-1/artifact.zip",
    artifactDigest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    artifactSize: archive.length,
  };
}

class FakeStorage {
  constructor(readonly archive: Buffer) {}

  async download(): Promise<Readable> {
    return Readable.from(this.archive);
  }
}

class FakeRepository implements BuildJobRepository {
  started: ArtifactInspectionJob[] = [];
  completed: Array<{ job: ArtifactInspectionJob; digest: string }> = [];
  failed: Array<{ job: ArtifactInspectionJob; code: string }> = [];

  async startBuild(job: ArtifactInspectionJob): Promise<"STARTED" | "ALREADY_COMPLETED"> {
    this.started.push(job);
    return "STARTED";
  }

  async completeBuild(job: ArtifactInspectionJob, imageDigest: string): Promise<void> {
    this.completed.push({ job, digest: imageDigest });
  }

  async failBuild(job: ArtifactInspectionJob, code: string): Promise<void> {
    this.failed.push({ job, code });
  }
}

class FakeCommands implements BuildCommandRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  readonly modes: Array<{ root: number; entry: number }> = [];
  constructor(readonly exitCode = 0) {}

  async run(command: string, args: string[], options: { cwd: string }) {
    this.calls.push({ command, args, cwd: options.cwd });
    this.modes.push({
      root: (await stat(options.cwd)).mode & 0o777,
      entry: (await stat(join(options.cwd, "src/index.js"))).mode & 0o777,
    });
    return { exitCode: this.exitCode, stdout: "", stderr: "" };
  }
}

class FakeImages implements ToolImageBuilder {
  calls: Array<{ context: string; imageTag: string }> = [];

  async build(context: string, imageTag: string) {
    this.calls.push({ context, imageTag });
    return { imageDigest: `sha256:${"b".repeat(64)}`, sbomObjectKey: "sbom/build-1.json" };
  }
}

class FakeVerifier implements ToolPackageVerifier {
  calls = 0;
  constructor(readonly failure?: "HANDLER_NOT_FOUND" | "SMOKE_TEST_FAILED") {}

  async verify(): Promise<void> {
    this.calls += 1;
    if (this.failure) throw new ToolPackageVerificationError(this.failure);
  }
}

async function runBuild(
  archive: Buffer,
  dependencies: {
    commands?: FakeCommands;
    images?: FakeImages;
    verifier?: FakeVerifier;
  } = {},
) {
  const repository = new FakeRepository();
  const commands = dependencies.commands ?? new FakeCommands();
  const images = dependencies.images ?? new FakeImages();
  const verifier = dependencies.verifier ?? new FakeVerifier();
  const result = await new ToolBuildService(
    new FakeStorage(archive),
    repository,
    commands,
    verifier,
    images,
  ).build(jobFor(archive));
  return { result, repository, commands, verifier, images };
}

test("BLD-001 runs npm ci, verifies handlers, smoke-tests, and records the pinned image digest", async () => {
  const archive = await createZip();
  const { result, repository, commands, verifier, images } = await runBuild(archive);

  assert.deepEqual(result, { status: "SUCCEEDED", imageDigest: `sha256:${"b".repeat(64)}` });
  assert.deepEqual(
    commands.calls.map((call) => [call.command, ...call.args]),
    [["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
  );
  assert.equal(images.calls.length, 1);
  assert.equal(images.calls[0]?.imageTag, "mcp-tool:get_report-build-1");
  assert.equal(verifier.calls, 1);
  assert.deepEqual(commands.modes[0], { root: 0o777, entry: 0o666 });
  assert.equal(repository.completed[0]?.digest, `sha256:${"b".repeat(64)}`);
  assert.equal(repository.failed.length, 0);
});

test("BLD-001 runs npm run build when declared before checking the built entry", async () => {
  const buildManifest = JSON.stringify({
    ...manifest,
    entry: "dist/index.js",
    build: { command: "npm run build" },
  });
  const archive = await createZip({
    "mcp.json": buildManifest,
    "package.json": JSON.stringify({ ...packageJson, scripts: { build: "node build.js" } }),
    "dist/index.js":
      "export const handlers = { getReport: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };\n",
  });
  const { result, commands } = await runBuild(archive);

  assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
  assert.deepEqual(
    commands.calls.map((call) => [call.command, ...call.args]),
    [
      ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      ["npm", "run", "build"],
    ],
  );
});

test("BLD-002 records stable install, handler, and smoke failures without an image", async () => {
  const installFailure = await runBuild(await createZip(), { commands: new FakeCommands(1) });
  assert.deepEqual(installFailure.result, { status: "FAILED", errorCode: "NPM_INSTALL_FAILED" });
  assert.equal(installFailure.images.calls.length, 0);

  const missingHandler = await runBuild(await createZip(), {
    verifier: new FakeVerifier("HANDLER_NOT_FOUND"),
  });
  assert.deepEqual(missingHandler.result, { status: "FAILED", errorCode: "HANDLER_NOT_FOUND" });
  assert.equal(missingHandler.images.calls.length, 0);
  assert.equal(missingHandler.repository.failed[0]?.code, "HANDLER_NOT_FOUND");
});
