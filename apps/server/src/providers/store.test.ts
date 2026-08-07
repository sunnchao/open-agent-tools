import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../db.js";
import {
  createProvider,
  deleteProvider,
  fetchProviderModels,
  getDefaultProvider,
  getProvider,
  initializeProviders,
  listProviders,
  probeProviderModels,
  setDefaultProvider,
  updateProvider,
} from "./store.js";

let dir: string;
let originalFetch: typeof fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "provider-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.PROVIDER_KEYS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_BASE_URL;
  delete process.env.OPENAI_API_MODEL;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.PROVIDER_KEYS_ENCRYPTION_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("provider store", () => {
  it("creates the default provider and masks encrypted keys", () => {
    const provider = createProvider({
      id: "default",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret-value",
      models: ["gpt-test"],
      enabled: true,
    });
    assert.equal(provider.id, "default");
    assert.equal(provider.apiKeyMasked, "sk***lue");
    assert.equal(getProvider("default")?.apiKey, "sk-secret-value");
    assert.equal(initializeProviders()?.isDefault, true);
    assert.equal(getDefaultProvider()?.id, "default");
    assert.equal(listProviders().length, 1);
    // format 缺省时回落为 openai-chat
    assert.equal(provider.format, "openai-chat");
  });

  it("persists and updates the provider format", () => {
    const provider = createProvider({
      name: "Claude",
      baseUrl: "https://api.anthropic.com/v1",
      models: ["claude-3-5-sonnet"],
      format: "anthropic-message",
    });
    assert.equal(provider.format, "anthropic-message");
    assert.equal(getProvider(provider.id)?.format, "anthropic-message");
    assert.throws(
      () =>
        createProvider({
          name: "Bad",
          baseUrl: "https://example.com/v1",
          models: ["m"],
          // @ts-expect-error intentionally invalid format
          format: "unknown-format",
        }),
      /unknown provider format/,
    );
    const updated = updateProvider(provider.id, { format: "openai-response" });
    assert.equal(updated?.format, "openai-response");
  });

  it("does not allow key writes without an encryption key", () => {
    delete process.env.PROVIDER_KEYS_ENCRYPTION_KEY;
    assert.throws(
      () =>
        createProvider({
          name: "Test",
          baseUrl: "https://example.com/v1",
          apiKey: "secret",
          models: ["m"],
        }),
      /PROVIDER_KEYS_ENCRYPTION_KEY/,
    );
  });

  it("switches the default and allows deleting the former default", () => {
    createProvider({
      id: "default",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4o-mini"],
    });
    const provider = createProvider({
      name: "Local",
      baseUrl: "http://localhost:11434/v1",
      models: ["llama3"],
      enabled: false,
    });
    assert.equal(setDefaultProvider("default")?.isDefault, true);
    assert.equal(listProviders({ includeDisabled: true }).length, 2);
    assert.deepEqual(
      updateProvider(provider.id, { enabled: true, models: ["llama3.1", "llama3.1"] })?.models,
      ["llama3.1"],
    );
    assert.equal(deleteProvider("default"), "default");
    assert.equal(setDefaultProvider(provider.id)?.isDefault, true);
    assert.equal(getDefaultProvider()?.id, provider.id);
    assert.equal(deleteProvider("default"), "deleted");
    assert.equal(deleteProvider(provider.id), "default");
  });

  it("rejects a disabled default provider", () => {
    const provider = createProvider({
      name: "Disabled",
      baseUrl: "https://example.com/v1",
      models: ["m"],
      enabled: false,
    });
    assert.throws(() => setDefaultProvider(provider.id), /disabled provider cannot be default/);
  });

  it("fetches OpenAI-compatible model metadata", async () => {
    const provider = createProvider({
      name: "Test",
      baseUrl: "https://example.com/v1",
      models: ["old"],
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
        status: 200,
      })) as typeof fetch;
    assert.deepEqual(await fetchProviderModels(provider.id), ["a", "b"]);
  });

  it("probes model metadata by params without persisting", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ id: "x" }, { id: "y" }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const models = await probeProviderModels({
      baseUrl: "https://example.com/v1/",
      apiKey: "sk-probe",
    });
    assert.deepEqual(models, ["x", "y"]);
    assert.equal(requestedUrl, "https://example.com/v1/models");
    // probe 不落库
    assert.equal(listProviders().length, 0);
  });
});
