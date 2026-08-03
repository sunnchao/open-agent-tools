import assert from "node:assert/strict";
import test from "node:test";

import {
  DockerBuildCommandRunner,
  NODE20_BUILD_IMAGE,
  type BuildContainer,
  type BuildDockerClient,
  type BuildContainerCreateOptions,
} from "./docker-build-command.js";

class FakeContainer implements BuildContainer {
  started = false;
  killed = false;
  removed = false;
  constructor(readonly waitResult: Promise<{ StatusCode: number }>) {}

  async start(): Promise<void> {
    this.started = true;
  }

  wait(): Promise<{ StatusCode: number }> {
    return this.waitResult;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }

  async remove(): Promise<void> {
    this.removed = true;
  }
}

test("BLD-001 runs npm ci in a digest-pinned resource-limited container", async () => {
  let options: BuildContainerCreateOptions | undefined;
  const container = new FakeContainer(Promise.resolve({ StatusCode: 0 }));
  const docker: BuildDockerClient = {
    createContainer: async (input) => {
      options = input;
      return container;
    },
  };
  const result = await new DockerBuildCommandRunner(docker, {
    installNetwork: "mcp-npm-egress",
    timeoutMs: 30_000,
    memoryMb: 512,
    cpuMillis: 2_000,
  }).run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: "/tmp/build/package",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(options?.Image, NODE20_BUILD_IMAGE);
  assert.deepEqual(options?.Cmd, ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(options?.User, "node");
  assert.equal(options?.WorkingDir, "/workspace");
  assert.deepEqual(options?.HostConfig, {
    AutoRemove: false,
    NetworkMode: "mcp-npm-egress",
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    PidsLimit: 128,
    Memory: 512 * 1024 * 1024,
    NanoCpus: 2_000_000_000,
    Binds: ["/tmp/build/package:/workspace:rw"],
    Tmpfs: {
      "/tmp": "rw,noexec,nosuid,nodev,size=67108864",
      "/home/node/.npm": "rw,nosuid,nodev,size=268435456",
    },
  });
  assert.equal(container.started, true);
  assert.equal(container.removed, true);
});

test("BLD-001 removes network access for npm run build", async () => {
  let options: BuildContainerCreateOptions | undefined;
  const docker: BuildDockerClient = {
    createContainer: async (input) => {
      options = input;
      return new FakeContainer(Promise.resolve({ StatusCode: 0 }));
    },
  };
  await new DockerBuildCommandRunner(docker, { installNetwork: "mcp-npm-egress" }).run(
    "npm",
    ["run", "build"],
    { cwd: "/tmp/build/package" },
  );
  assert.equal(options?.HostConfig.NetworkMode, "none");
});

test("BLD-006 kills and removes a build container at its wall timeout", async () => {
  let resolveWait: ((value: { StatusCode: number }) => void) | undefined;
  const waitResult = new Promise<{ StatusCode: number }>((resolve) => {
    resolveWait = resolve;
  });
  const container = new FakeContainer(waitResult);
  container.kill = async () => {
    container.killed = true;
    resolveWait?.({ StatusCode: 137 });
  };
  const docker: BuildDockerClient = { createContainer: async () => container };
  const result = await new DockerBuildCommandRunner(docker, { timeoutMs: 1 }).run(
    "npm",
    ["run", "build"],
    { cwd: "/tmp/build/package" },
  );

  assert.equal(result.exitCode, 124);
  assert.equal(container.killed, true);
  assert.equal(container.removed, true);
});
