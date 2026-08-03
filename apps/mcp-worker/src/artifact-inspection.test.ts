import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import type { ArtifactInspectionJob, ManagedMcpManifest } from "@open-agent-tools/mcp-contracts";
import { ZipFile } from "yazl";

import {
  ArtifactInspectionService,
  type ArtifactDownloadStorage,
  type ArtifactInspectionRepository,
  type InspectionFailureCode,
} from "./artifact-inspection.js";

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
  prompts: [
    {
      name: "summarize_report",
      arguments: [{ name: "reportId", required: true }],
      messages: [
        {
          role: "user",
          content: { type: "text", text: "Summarize {{reportId}}." },
        },
      ],
    },
  ],
  limits: {
    timeoutMs: 30_000,
    memoryMb: 256,
    cpuMillis: 1_000,
    network: "none",
  },
};

const packageJson = {
  name: "report-tools",
  version: "1.0.0",
  type: "module",
};

const packageLock = {
  name: "report-tools",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: { "": { name: "report-tools", version: "1.0.0" } },
};

async function createZip(
  entries: Record<string, string> = {
    "mcp.json": JSON.stringify(manifest),
    "package.json": JSON.stringify(packageJson),
    "package-lock.json": JSON.stringify(packageLock),
    "src/index.js": "export const handlers = {};\n",
  },
): Promise<Buffer> {
  const archive = new ZipFile();
  for (const [name, contents] of Object.entries(entries)) {
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

function replaceEntryName(archive: Buffer, originalName: string, replacementName: string): Buffer {
  assert.equal(Buffer.byteLength(originalName), Buffer.byteLength(replacementName));
  const updated = Buffer.from(archive);
  const original = Buffer.from(originalName);
  const replacement = Buffer.from(replacementName);
  let replacements = 0;
  for (let offset = 0; offset <= updated.length - original.length; offset += 1) {
    if (updated.subarray(offset, offset + original.length).equals(original)) {
      replacement.copy(updated, offset);
      replacements += 1;
      offset += original.length - 1;
    }
  }
  assert.equal(replacements, 2);
  return updated;
}

function jobFor(archive: Buffer): ArtifactInspectionJob {
  return {
    buildJobId: "build-1",
    serviceId: "service-1",
    versionId: "version-1",
    versionRevision: 2,
    objectKey: "service-1/version-1/artifact.zip",
    artifactDigest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    artifactSize: archive.length,
  };
}

class FakeRepository implements ArtifactInspectionRepository {
  starts: ArtifactInspectionJob[] = [];
  completions: Array<{ job: ArtifactInspectionJob; manifest: ManagedMcpManifest }> = [];
  failures: Array<{ job: ArtifactInspectionJob; code: InspectionFailureCode }> = [];

  async startInspection(job: ArtifactInspectionJob): Promise<"STARTED" | "ALREADY_COMPLETED"> {
    this.starts.push(job);
    return "STARTED";
  }

  async completeInspection(
    job: ArtifactInspectionJob,
    importedManifest: ManagedMcpManifest,
  ): Promise<void> {
    this.completions.push({ job, manifest: importedManifest });
  }

  async failInspection(job: ArtifactInspectionJob, code: InspectionFailureCode): Promise<void> {
    this.failures.push({ job, code });
  }
}

class BufferStorage implements ArtifactDownloadStorage {
  constructor(readonly contents: Buffer | Error) {}

  async download(): Promise<Readable> {
    if (this.contents instanceof Error) throw this.contents;
    return Readable.from(this.contents);
  }
}

test("ZIP-001 inspects a verified Node.js package and imports its Tools and Prompts", async () => {
  const archive = await createZip();
  const repository = new FakeRepository();
  const result = await new ArtifactInspectionService(
    new BufferStorage(archive),
    repository,
  ).inspect(jobFor(archive));

  assert.deepEqual(result, { status: "SUCCEEDED" });
  assert.equal(repository.starts.length, 1);
  assert.equal(repository.failures.length, 0);
  assert.equal(repository.completions.length, 1);
  assert.equal(repository.completions[0]?.manifest.tools[0]?.name, "get_report");
  assert.equal(repository.completions[0]?.manifest.prompts[0]?.name, "summarize_report");
});

test("ZIP-002 rejects downloaded bytes whose size or digest differs from the queued job", async () => {
  const archive = await createZip();

  for (const [queued, expectedCode] of [
    [{ ...jobFor(archive), artifactSize: archive.length + 1 }, "ARTIFACT_SIZE_MISMATCH"],
    [
      { ...jobFor(archive), artifactDigest: `sha256:${"0".repeat(64)}` },
      "ARTIFACT_DIGEST_MISMATCH",
    ],
  ] as const) {
    const repository = new FakeRepository();
    const result = await new ArtifactInspectionService(
      new BufferStorage(archive),
      repository,
    ).inspect(queued);

    assert.deepEqual(result, { status: "FAILED", errorCode: expectedCode });
    assert.equal(repository.completions.length, 0);
    assert.equal(repository.failures[0]?.code, expectedCode);
  }
});

test("ZIP-003 records a stable archive validation code without importing a manifest", async () => {
  const safeArchive = await createZip({ "aa/escape.js": "malicious" });
  const archive = replaceEntryName(safeArchive, "aa/escape.js", "../escape.js");
  const repository = new FakeRepository();
  const result = await new ArtifactInspectionService(
    new BufferStorage(archive),
    repository,
  ).inspect(jobFor(archive));

  assert.deepEqual(result, { status: "FAILED", errorCode: "UNSAFE_PATH" });
  assert.equal(repository.completions.length, 0);
  assert.equal(repository.failures[0]?.code, "UNSAFE_PATH");
});

test("ZIP-005 records stable package and download failures", async () => {
  const invalidPackage = await createZip({ "mcp.json": JSON.stringify(manifest) });
  const packageRepository = new FakeRepository();
  const packageResult = await new ArtifactInspectionService(
    new BufferStorage(invalidPackage),
    packageRepository,
  ).inspect(jobFor(invalidPackage));
  assert.deepEqual(packageResult, { status: "FAILED", errorCode: "MISSING_REQUIRED_FILE" });

  const downloadRepository = new FakeRepository();
  const downloadResult = await new ArtifactInspectionService(
    new BufferStorage(new Error("object storage unavailable")),
    downloadRepository,
  ).inspect(jobFor(invalidPackage));
  assert.deepEqual(downloadResult, {
    status: "FAILED",
    errorCode: "ARTIFACT_DOWNLOAD_FAILED",
  });
});
