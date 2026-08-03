import assert from "node:assert/strict";
import test from "node:test";

import type { ToolExecutionJob } from "@open-agent-tools/mcp-contracts";
import { createDockerClient, DockerToolContainerRuntime } from "./docker-runtime.js";

const imageDigest = process.env.TEST_TOOL_IMAGE_DIGEST;

test("RUN-001 executes a Tool in a real isolated container", { skip: !imageDigest }, async () => {
  const docker = await createDockerClient();
  let diagnostic: unknown;
  const runtime = new DockerToolContainerRuntime(
    docker,
    { imageRepository: "" },
    { onError: (error) => (diagnostic = error) },
  );
  const job: ToolExecutionJob = {
    requestId: "request-docker-e2e",
    serviceId: "service-1",
    versionId: "version-1",
    imageDigest: imageDigest!,
    toolName: "echo",
    arguments: { value: "docker-e2e-ok" },
    context: {
      clientId: "client-1",
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    },
    limits: {
      timeoutMs: 30_000,
      memoryMb: 256,
      cpuMillis: 1_000,
      network: "none",
    },
  };

  const result = await runtime.execute(job);

  assert.deepEqual(
    result.content,
    [{ type: "text", text: "docker-e2e-ok" }],
    `${JSON.stringify(result)} ${String(diagnostic)}`,
  );
  assert.deepEqual(result.structuredContent, { requestId: "request-docker-e2e" });
  assert.equal(result.isError, false);
});
