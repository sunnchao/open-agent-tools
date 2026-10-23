import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { describe, it } from "node:test";
import { createApiKey, parseApiKey, verifyApiKey } from "./index.js";
import {
  hashSecret,
  normalizeOptionalToken,
  parseBearerToken,
  tokensEqual,
  verifySecret,
} from "./primitives.js";

const keyId = "4d36e967-e325-11ce-bfc1-08002be10318";
const secret = Buffer.alloc(32, 7).toString("base64url");
const salt = Buffer.alloc(16, 9);
// Independent fixture using the parameters used by both original implementations.
const legacyHash = `scrypt$16384$8$1$${salt.toString("base64url")}$${scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")}`;

describe("shared authentication primitives", () => {
  it("verifies existing hashes and keeps MCP keys confined to their prefix", async () => {
    assert.equal(await verifySecret(secret, legacyHash), true);
    assert.equal(await verifyApiKey(`mcp.${keyId}.${secret}`, legacyHash), true);
    assert.equal(await verifyApiKey(`wf.${keyId}.${secret}`, legacyHash), false);
    assert.equal(parseApiKey(`mcp.${keyId.toUpperCase()}.${secret}`), null);
    assert.equal(await verifySecret(`${secret}x`, legacyHash), false);
  });

  it("generates the existing hash encoding with independent random salts", async () => {
    const first = await hashSecret(secret);
    const second = await hashSecret(secret);
    assert.match(first, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second);
    assert.equal(await verifySecret(secret, first), true);
    const created = await createApiKey(keyId, () => Buffer.alloc(32, 7));
    assert.equal(created.rawKey, `mcp.${keyId}.${secret}`);
    assert.equal(await verifyApiKey(created.rawKey, created.keyHash), true);
    await assert.rejects(createApiKey("bad-id"), TypeError);
    await assert.rejects(
      createApiKey(keyId, () => Buffer.alloc(31)),
      TypeError,
    );
  });

  it("rejects malformed hashes and unsupported scrypt parameters", async () => {
    for (const invalid of [
      "",
      "scrypt$16384$8$1",
      legacyHash.replace("scrypt", "pbkdf2"),
      legacyHash.replace("16384", "32768"),
      legacyHash.replace("$8$", "$4$"),
      legacyHash.replace("$1$", "$2$"),
      legacyHash.replace(salt.toString("base64url"), ""),
      `${legacyHash.slice(0, legacyHash.lastIndexOf("$") + 1)}YWJj`,
      `${legacyHash}$suffix`,
    ])
      assert.equal(await verifySecret(secret, invalid), false, invalid);
    assert.equal(
      await verifySecret(secret, `${legacyHash}$suffix`, { allowTrailingFields: true }),
      true,
    );
    assert.equal(await verifyApiKey(`mcp.${keyId}.${secret}`, `${legacyHash}$suffix`), false);
  });

  it("extracts Bearer headers without changing the existing whitespace rules", () => {
    for (const [header, expected] of [
      [undefined, null],
      [null, null],
      ["", null],
      ["Basic abc", null],
      ["Bearer", null],
      ["Bearer  ", null],
      [" Bearer abc", null],
      ["Bearer abc", "abc"],
      ["bEaReR\tabc  ", "abc"],
      ["Bearer ab cd", "ab cd"],
    ] as const)
      assert.equal(parseBearerToken(header), expected);
  });

  it("normalizes configured tokens while preserving empty-token behavior", () => {
    assert.equal(normalizeOptionalToken(undefined), null);
    assert.equal(normalizeOptionalToken(""), null);
    assert.equal(normalizeOptionalToken("   "), null);
    assert.equal(normalizeOptionalToken(" token "), "token");
  });

  it("compares tokens with different lengths and UTF-8 content", () => {
    assert.equal(tokensEqual("", ""), true);
    assert.equal(tokensEqual("令牌🔑", "令牌🔑"), true);
    assert.equal(tokensEqual("令牌🔑", "令牌🔒"), false);
    assert.equal(tokensEqual("abc", "abc "), false);
    assert.equal(tokensEqual("abc", ""), false);
  });
});
