import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DockerCliToolImageBuilder,
  type PlatformCommandRunner,
  type SbomStorage,
} from "./tool-image-builder.js";

const digest = `sha256:${"b".repeat(64)}`;
const runnerImage = `registry.example.com/mcp-runner@sha256:${"c".repeat(64)}`;

class FakeCommands implements PlatformCommandRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  trivyExitCode = 0;
  dockerfileContents = "";

  async run(command: string, args: string[], options: { cwd?: string } = {}) {
    this.calls.push({ command, args, cwd: options.cwd });
    if (command === "docker") {
      const metadataPath = args[args.indexOf("--metadata-file") + 1]!;
      this.dockerfileContents = await readFile(args[args.indexOf("--file") + 1]!, "utf8");
      await writeFile(metadataPath, JSON.stringify({ "containerimage.digest": digest }));
    }
    if (command === "syft") {
      const output = args.find((arg) => arg.startsWith("cyclonedx-json="))!;
      await writeFile(output.slice("cyclonedx-json=".length), '{"bomFormat":"CycloneDX"}');
    }
    return { exitCode: command === "trivy" ? this.trivyExitCode : 0, stdout: "", stderr: "" };
  }
}

class FakeSbomStorage implements SbomStorage {
  uploads: Array<{ objectKey: string; contents: string }> = [];

  async upload(objectKey: string, path: string): Promise<void> {
    this.uploads.push({ objectKey, contents: await readFile(path, "utf8") });
  }
}

test("BLD-001 builds, pushes, scans, and stores SBOM for a digest-pinned image", async () => {
  const context = await mkdtemp(join(tmpdir(), "mcp-image-context-"));
  const commands = new FakeCommands();
  const sbom = new FakeSbomStorage();
  try {
    const result = await new DockerCliToolImageBuilder(commands, sbom, {
      imageRepository: "registry.example.com/mcp-tools",
      runnerImage,
      tempDirectory: context,
    }).build(context, "mcp-tool:build-1");

    assert.deepEqual(result, {
      imageDigest: digest,
      sbomObjectKey: "sbom/build-1.cdx.json",
    });
    const dockerCall = commands.calls[0]!;
    assert.equal(dockerCall.command, "docker");
    assert.ok(dockerCall.args.includes("buildx"));
    assert.ok(dockerCall.args.includes("--push"));
    assert.ok(dockerCall.args.includes("--provenance=true"));
    assert.ok(dockerCall.args.includes("--sbom=true"));
    assert.ok(dockerCall.args.includes("registry.example.com/mcp-tools:build-1"));
    assert.ok(
      dockerCall.args.includes(
        "PRUNE_IMAGE=node:20.20.2-alpine3.23@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293",
      ),
    );
    assert.match(commands.dockerfileContents, /FROM \$\{PRUNE_IMAGE\} AS prune/);
    assert.match(commands.dockerfileContents, /FROM \$\{RUNNER_IMAGE\}/);
    assert.match(commands.dockerfileContents, /RUN npm prune --omit=dev --no-audit --no-fund/);
    assert.match(
      commands.dockerfileContents,
      /COPY --from=prune --chown=node:node \/build \/app/,
    );
    assert.deepEqual(commands.calls.slice(1).map((call) => call.command), ["syft", "trivy"]);
    assert.deepEqual(sbom.uploads, [
      { objectKey: "sbom/build-1.cdx.json", contents: '{"bomFormat":"CycloneDX"}' },
    ]);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});

test("BLD-004 fails the image when the vulnerability policy rejects it", async () => {
  const context = await mkdtemp(join(tmpdir(), "mcp-image-context-"));
  const commands = new FakeCommands();
  commands.trivyExitCode = 1;
  const sbom = new FakeSbomStorage();
  try {
    await assert.rejects(
      new DockerCliToolImageBuilder(commands, sbom, {
        imageRepository: "registry.example.com/mcp-tools",
        runnerImage,
        tempDirectory: context,
      }).build(context, "mcp-tool:build-1"),
      /vulnerability/i,
    );
    assert.equal(sbom.uploads.length, 0);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});

test("BLD-001 can disable Buildx attestations for a local docker driver", async () => {
  const context = await mkdtemp(join(tmpdir(), "mcp-image-context-"));
  const commands = new FakeCommands();
  const sbom = new FakeSbomStorage();
  try {
    await new DockerCliToolImageBuilder(commands, sbom, {
      imageRepository: "localhost:5001/mcp-tools",
      runnerImage,
      attestations: false,
      tempDirectory: context,
    }).build(context, "mcp-tool:build-local");

    const dockerArgs = commands.calls[0]!.args;
    assert.equal(dockerArgs.includes("--provenance=true"), false);
    assert.equal(dockerArgs.includes("--sbom=true"), false);
    assert.deepEqual(commands.calls.slice(1).map((call) => call.command), ["syft", "trivy"]);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});
