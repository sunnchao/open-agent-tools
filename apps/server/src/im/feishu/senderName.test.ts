import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearFeishuSenderNameCache,
  normalizeFeishuUserName,
  resolveFeishuSenderName,
  type FeishuContactClient,
} from "./senderName.js";

function fakeClient(
  impl: () => Promise<{ code?: number; msg?: string; data?: { user?: { name?: string } } }>,
  onCall?: () => void,
): FeishuContactClient {
  return {
    contact: {
      user: {
        get: async () => {
          onCall?.();
          return impl();
        },
      },
    },
  };
}

describe("normalizeFeishuUserName", () => {
  it("trims non-empty names and returns null for blank/non-string", () => {
    assert.equal(normalizeFeishuUserName("  王五  "), "王五");
    assert.equal(normalizeFeishuUserName("   "), null);
    assert.equal(normalizeFeishuUserName(undefined), null);
    assert.equal(normalizeFeishuUserName(123), null);
  });
});

describe("resolveFeishuSenderName", () => {
  it("resolves the name via contact.user.get and caches it", async () => {
    clearFeishuSenderNameCache();
    let calls = 0;
    const client = fakeClient(async () => ({ code: 0, data: { user: { name: "赵六" } } }), () => {
      calls += 1;
    });
    assert.equal(await resolveFeishuSenderName(client, "ou_1"), "赵六");
    assert.equal(await resolveFeishuSenderName(client, "ou_1"), "赵六");
    assert.equal(calls, 1);
  });

  it("returns null on API error, missing user, timeout, or blank openId", async () => {
    clearFeishuSenderNameCache();
    const errorClient = fakeClient(async () => ({ code: 400, msg: "no permission" }));
    assert.equal(await resolveFeishuSenderName(errorClient, "ou_err"), null);
    const emptyClient = fakeClient(async () => ({ code: 0, data: {} }));
    assert.equal(await resolveFeishuSenderName(emptyClient, "ou_empty"), null);
    const hangingClient = fakeClient(
      () => new Promise(() => {}),
      undefined,
    );
    assert.equal(
      await resolveFeishuSenderName(hangingClient, "ou_hang", { timeoutMs: 20 }),
      null,
    );
    const okClient = fakeClient(async () => ({ code: 0, data: { user: { name: "x" } } }));
    assert.equal(await resolveFeishuSenderName(okClient, "   "), null);
  });

  it("does not let a name failure reject the caller", async () => {
    clearFeishuSenderNameCache();
    const throwing = {
      contact: {
        user: {
          get: async () => {
            throw new Error("network down");
          },
        },
      },
    } satisfies FeishuContactClient;
    assert.equal(await resolveFeishuSenderName(throwing, "ou_boom"), null);
  });
});
