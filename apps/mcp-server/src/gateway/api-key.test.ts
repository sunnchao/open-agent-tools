import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApiKey, parseApiKey, verifyApiKey } from "./api-key.js";

const keyId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd7";

describe("MCP API Key", () => {
  it("AUTH-001 creates a parseable raw key and stores only a scrypt hash", async () => {
    const created = await createApiKey(keyId, () => Buffer.alloc(32, 7));

    assert.match(created.rawKey, /^mcp\.[0-9a-f-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(created.keyId, keyId);
    assert.match(created.keyHash, /^scrypt\$/);
    assert.equal(created.keyHash.includes(created.rawKey), false);
    assert.deepEqual(parseApiKey(created.rawKey), {
      keyId,
      secret: Buffer.alloc(32, 7).toString("base64url"),
    });
  });

  it("AUTH-002 verifies the correct secret and rejects a different secret", async () => {
    const created = await createApiKey(keyId, () => Buffer.alloc(32, 7));
    const different = await createApiKey(keyId, () => Buffer.alloc(32, 8));

    assert.equal(await verifyApiKey(created.rawKey, created.keyHash), true);
    assert.equal(await verifyApiKey(different.rawKey, created.keyHash), false);
  });

  it("AUTH-003 rejects malformed key formats", () => {
    for (const value of ["", "Bearer x", "mcp.key.secret", `mcp.${keyId}.`, `mcp.${keyId}.%%%`]) {
      assert.equal(parseApiKey(value), null);
    }
  });
});
