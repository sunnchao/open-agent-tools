import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const dockerfilePath = resolve(import.meta.dirname, "../../Dockerfile");

test("RUN-006 runtime image pins Node.js 20 and runs as a non-root user", async () => {
  const dockerfile = await readFile(dockerfilePath, "utf8");

  assert.match(dockerfile, /ARG NODE_IMAGE=node:20\.20\.2-alpine3\.23@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/opt\/runner\/dist\/cli\.js"\]/);
  assert.equal(dockerfile.includes("COPY ."), false);
});
