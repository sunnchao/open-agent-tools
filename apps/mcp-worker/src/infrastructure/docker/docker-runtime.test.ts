import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import type { ToolExecutionJob } from "@open-agent-tools/mcp-contracts";
import {
  DockerToolContainerRuntime,
  type ContainerCreateOptions,
  type DockerClient,
  type DockerContainer,
} from "./docker-runtime.js";

const job: ToolExecutionJob = {
  requestId: "request-1",
  serviceId: "service-1",
  versionId: "version-1",
  imageDigest: `sha256:${"a".repeat(64)}`,
  toolName: "get_report",
  arguments: { id: "report-1" },
  context: {
    clientId: "client-1",
    deadlineAt: "2099-07-31T12:00:30.000Z",
  },
  limits: {
    timeoutMs: 30_000,
    memoryMb: 256,
    cpuMillis: 1_000,
    network: "none",
  },
};

function outputMount(options: ContainerCreateOptions): string {
  const binding = options.HostConfig.Binds.find((value) => value.endsWith(":/run/tool:rw"));
  assert.ok(binding);
  return binding.slice(0, -":/run/tool:rw".length);
}

test("RUN-001 and RUN-006 create a digest-pinned isolated container", async () => {
  let createdOptions: ContainerCreateOptions | undefined;
  const container: DockerContainer = {
    start: async () => {
      assert.ok(createdOptions);
      await writeFile(
        `${outputMount(createdOptions)}/output.json`,
        JSON.stringify({ content: [{ type: "text", text: "ok" }], isError: false }),
      );
    },
    wait: async () => ({ StatusCode: 0 }),
    kill: async () => undefined,
    remove: async () => undefined,
  };
  const docker: DockerClient = {
    createContainer: async (options) => {
      createdOptions = options;
      return container;
    },
  };

  const result = await new DockerToolContainerRuntime(docker, {
    imageRepository: "registry.example/mcp-tools",
  }).execute(job);

  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  assert.ok(createdOptions);
  assert.equal(createdOptions.Image, `registry.example/mcp-tools@sha256:${"a".repeat(64)}`);
  assert.equal(createdOptions.Name, "mcp-tool-get_report-request-1");
  assert.equal(createdOptions.User, "node");
  assert.equal(createdOptions.HostConfig.NetworkMode, "none");
  assert.equal(createdOptions.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(createdOptions.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(createdOptions.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(createdOptions.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(createdOptions.HostConfig.NanoCpus, 1_000_000_000);
  assert.equal(createdOptions.HostConfig.PidsLimit, 64);
  assert.equal(createdOptions.HostConfig.Binds.length, 2);
});

test("RUN-003 kills a container at its wall timeout", async () => {
  let finishWait: ((value: { StatusCode: number }) => void) | undefined;
  let killed = false;
  const container: DockerContainer = {
    start: async () => undefined,
    wait: () =>
      new Promise((resolve) => {
        finishWait = resolve;
      }),
    kill: async () => {
      killed = true;
      finishWait?.({ StatusCode: 137 });
    },
    remove: async () => undefined,
  };
  const docker: DockerClient = { createContainer: async () => container };
  const result = await new DockerToolContainerRuntime(
    docker,
    { imageRepository: "registry.example/mcp-tools" },
    { now: () => Date.parse("2026-07-31T12:00:00.000Z") },
  ).execute({
    ...job,
    context: { ...job.context, deadlineAt: "2026-07-31T12:00:00.010Z" },
    limits: { ...job.limits, timeoutMs: 10 },
  });

  assert.equal(killed, true);
  assert.equal(result.isError, true);
  assert.equal(
    (result._meta?.["open-agent-tools/error"] as { code?: string } | undefined)?.code,
    "TIMEOUT",
  );
});
