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
  getProvider,
  listProviders,
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
    assert.equal(listProviders().length, 1);
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

  it("supports CRUD while preserving the default", () => {
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
    assert.equal(listProviders({ includeDisabled: true }).length, 2);
    assert.deepEqual(
      updateProvider(provider.id, { enabled: true, models: ["llama3.1", "llama3.1"] })?.models,
      ["llama3.1"],
    );
    assert.equal(deleteProvider("default"), "default");
    assert.equal(deleteProvider(provider.id), "deleted");
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
});
