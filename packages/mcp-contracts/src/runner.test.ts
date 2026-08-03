import assert from "node:assert/strict";
import test from "node:test";

import { ToolRunnerInputSchema } from "./runner.js";

const input = {
  requestId: "req_123",
  toolName: "get_report",
  arguments: { id: "report-1" },
  context: {
    serviceId: "svc_123",
    versionId: "ver_3",
    clientId: "client_8",
    deadlineAt: "2026-07-31T12:00:30.000Z",
  },
};

test("RUN-007 accepts only the documented Tool invocation context", () => {
  assert.equal(ToolRunnerInputSchema.safeParse(input).success, true);
  assert.equal(
    ToolRunnerInputSchema.safeParse({
      ...input,
      context: { ...input.context, bearerToken: "secret" },
    }).success,
    false,
  );
});

test("RUN-007 rejects malformed invocation identifiers and deadlines", () => {
  for (const invalidInput of [
    { ...input, requestId: "" },
    { ...input, toolName: "invalid tool" },
    { ...input, context: { ...input.context, deadlineAt: "tomorrow" } },
  ]) {
    assert.equal(ToolRunnerInputSchema.safeParse(invalidInput).success, false);
  }
});
