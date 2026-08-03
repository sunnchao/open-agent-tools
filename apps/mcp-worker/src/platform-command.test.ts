import assert from "node:assert/strict";
import test from "node:test";

import { SpawnPlatformCommandRunner } from "./platform-command.js";

test("BLD-001 executes platform commands without a shell and captures bounded output", async () => {
  const result = await new SpawnPlatformCommandRunner({ timeoutMs: 5_000 }).run(
    process.execPath,
    ["-e", "process.stdout.write('ok'); process.stderr.write('warning')"],
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "ok", stderr: "warning" });
});

test("BLD-006 terminates a platform command at its wall timeout", async () => {
  const result = await new SpawnPlatformCommandRunner({ timeoutMs: 10 }).run(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /timed out/i);
});

test("BLD-006 terminates a platform command that exceeds its output limit", async () => {
  const result = await new SpawnPlatformCommandRunner({ maxOutputBytes: 32 }).run(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(128))",
  ]);
  assert.equal(result.exitCode, 125);
  assert.match(result.stderr, /output limit/i);
});
