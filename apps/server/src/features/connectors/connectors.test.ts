import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb } from "../../platform/db.js";
import { httpConnector } from "./httpConnector.js";
import { localDirConnector } from "./localDirConnector.js";
import { confluenceConnector, feishuConnector, yuqueConnector } from "./providers.js";
import {
  createConnector,
  deleteConnector,
  getConnector,
  listConnectors,
  listSyncRuns,
  updateConnector,
} from "./store.js";
import { runConnectorSync } from "./sync.js";
import {
  applyFilter,
  ragSourceName,
  type ConnectorConfig,
  type ConnectorFileSystem,
  type HttpFetchLike,
} from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "connector-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function baseConfig(overrides: Partial<ConnectorConfig>): ConnectorConfig {
  return {
    id: "conn-1",
    name: "测试连接器",
    type: "http",
    baseUrl: "https://example.com/docs",
    credentials: {},
    filter: { include: [], exclude: [], maxDocuments: null },
    enabled: true,
    ...overrides,
  };
}

/** 用「文件路径 -> 内容」构造内存文件系统,免真实磁盘。 */
function makeFs(files: Record<string, string>): ConnectorFileSystem {
  const listings = new Map<string, Array<{ name: string; isDir: boolean }>>();
  const add = (parent: string, name: string, isDir: boolean) => {
    const list = listings.get(parent) ?? [];
    if (!list.some((entry) => entry.name === name)) list.push({ name, isDir });
    listings.set(parent, list);
  };
  for (const filePath of Object.keys(files)) {
    const index = filePath.lastIndexOf("/");
    const directory = index <= 0 ? "/" : filePath.slice(0, index);
    add(directory, filePath.slice(index + 1), false);
    let current = directory;
    while (current !== "/" && current !== "") {
      const parentIndex = current.lastIndexOf("/");
      const parent = parentIndex <= 0 ? "/" : current.slice(0, parentIndex);
      add(parent, current.slice(parentIndex + 1), true);
      current = parent;
    }
  }
  return {
    async readdir(path: string) {
      const list = listings.get(path);
      if (!list) throw new Error(`ENOENT: ${path}`);
      return list.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDir,
        isFile: () => !entry.isDir,
      }));
    },
    async readFile(path: string) {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

describe("connector implementations", () => {
  it("http connector maps a JSON array payload and injects the bearer token", async () => {
    const calls: string[] = [];
    const fetchStub: HttpFetchLike = async (input, init) => {
      calls.push(`${String(input)} ${String(init?.headers ? "with-headers" : "")}`);
      return jsonResponse({
        documents: [
          { id: "doc-1", title: "入职指南", content: "# 欢迎", url: "https://x/1" },
          { externalId: "doc-2", name: "报销", text: "流程" },
        ],
      });
    };
    const documents = await httpConnector.fetchDocuments(
      baseConfig({ credentials: { token: "s3cret" } }),
      { fetch: fetchStub },
    );
    assert.equal(documents.length, 2);
    assert.equal(documents[0]?.externalId, "doc-1");
    assert.equal(documents[0]?.title, "入职指南");
    assert.equal(documents[0]?.url, "https://x/1");
    assert.equal(documents[1]?.externalId, "doc-2");
    assert.equal(documents[1]?.content, "流程");
    assert.equal(calls.length, 1);
  });

  it("http connector rejects a non-ok response", async () => {
    const fetchStub: HttpFetchLike = async () => jsonResponse({ error: "nope" }, 500);
    await assert.rejects(
      () => httpConnector.fetchDocuments(baseConfig({}), { fetch: fetchStub }),
      /request failed \(500\)/,
    );
  });

  it("local-dir connector walks directories recursively and only reads text files", async () => {
    const fs = makeFs({
      "/docs/a.md": "# A",
      "/docs/nested/b.txt": "bee",
      "/docs/image.png": "binary",
    });
    const documents = await localDirConnector.fetchDocuments(
      baseConfig({ type: "local-dir", baseUrl: "/docs" }),
      { fs },
    );
    assert.deepEqual(
      documents.map((document) => document.externalId),
      ["a.md", "nested/b.txt"],
    );
    assert.equal(documents[1]?.title, "b");
    assert.equal(documents[1]?.content, "bee");
  });

  it("feishu connector exchanges a token then maps documents through injected fetch", async () => {
    const seen: string[] = [];
    const fetchStub: HttpFetchLike = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("tenant_access_token")) {
        return jsonResponse({ tenant_access_token: "t-123", code: 0 });
      }
      return jsonResponse({ data: { items: [{ document_id: "d1", title: "云文档" }] } });
    };
    const documents = await feishuConnector.fetchDocuments(
      baseConfig({ type: "feishu", baseUrl: null, credentials: { appId: "a", appSecret: "s" } }),
      { fetch: fetchStub },
    );
    assert.equal(documents.length, 1);
    assert.equal(documents[0]?.externalId, "d1");
    assert.equal(seen.length, 2);
    assert.match(seen[1] ?? "", /documents\?page_size=200$/);
  });

  it("yuque connector requires a namespace and maps slug documents", async () => {
    const fetchStub: HttpFetchLike = async () =>
      jsonResponse([{ slug: "onboarding", title: "上手指南", body: "正文" }]);
    const documents = await yuqueConnector.fetchDocuments(
      baseConfig({
        type: "yuque",
        baseUrl: null,
        credentials: { token: "t", namespace: "team/book" },
      }),
      { fetch: fetchStub },
    );
    assert.equal(documents[0]?.externalId, "onboarding");
    assert.equal(documents[0]?.content, "正文");
  });

  it("confluence connector maps storage bodies and requires basic credentials", async () => {
    const fetchStub: HttpFetchLike = async () =>
      jsonResponse({
        results: [
          {
            id: "42",
            title: "RFC",
            body: { storage: { value: "<p>hi</p>" } },
            _links: { webui: "/x" },
          },
        ],
      });
    const documents = await confluenceConnector.fetchDocuments(
      baseConfig({
        type: "confluence",
        baseUrl: "https://team.atlassian.net/wiki",
        credentials: { email: "a@b.c", apiToken: "tok" },
      }),
      { fetch: fetchStub },
    );
    assert.equal(documents[0]?.externalId, "42");
    assert.equal(documents[0]?.content, "<p>hi</p>");
    assert.equal(documents[0]?.mimeType, "text/html");
  });

  it("applyFilter honours include/exclude and maxDocuments", () => {
    const docs = [
      { externalId: "hr/1", title: "休假政策" },
      { externalId: "eng/2", title: "发布流程" },
      { externalId: "hr/3", title: "花费" },
    ].map((item) => ({
      ...item,
      content: "",
      url: null,
      mimeType: "text/markdown",
      updatedAt: null,
    }));
    const filtered = applyFilter(docs, {
      include: ["hr/*"],
      exclude: ["*花费*"],
      maxDocuments: 5,
    });
    assert.deepEqual(
      filtered.map((document) => document.externalId),
      ["hr/1"],
    );
  });
});

describe("connector store", () => {
  it("round-trips connector config, encrypts credentials, and never leaks them in listing", () => {
    const created = createConnector({
      name: "飞书文档",
      type: "feishu",
      credentials: { appId: "cli_x", appSecret: "super-secret" },
      filter: { include: ["hr/*"] },
    });
    assert.equal(created.hasCredential, true);
    assert.deepEqual(created.credentialKeys.sort(), ["appId", "appSecret"]);
    assert.equal("credentials" in created, false);
    const withSecret = getConnector(created.id);
    assert.equal(withSecret?.credentials.appSecret, "super-secret");
    const listed = listConnectors({ includeDisabled: true });
    assert.equal(listed.length, 1);
    assert.equal("credentials" in listed[0]!, false);
  });

  it("updates without clobbering existing credentials when omitted", () => {
    const created = createConnector({
      name: "通用",
      type: "http",
      baseUrl: "https://example.com/a",
      credentials: { token: "keep-me" },
    });
    const updated = updateConnector(created.id, {
      name: "通用 v2",
      baseUrl: "https://example.com/b",
    });
    assert.equal(updated?.name, "通用 v2");
    assert.equal(updated?.baseUrl, "https://example.com/b");
    assert.equal(getConnector(created.id)?.credentials.token, "keep-me");
    assert.equal(deleteConnector(created.id), "deleted");
    assert.equal(deleteConnector(created.id), "not_found");
  });
});

describe("connector sync engine", () => {
  function seedHttpConnector() {
    return createConnector({
      name: "HTTP 源",
      type: "http",
      baseUrl: "https://example.com/docs",
    });
  }

  it("ingests on the first run and skips unchanged documents afterwards", async () => {
    const connector = seedHttpConnector();
    const uploaded: string[] = [];
    const fetchStub: HttpFetchLike = async () =>
      jsonResponse({
        documents: [
          { id: "a", title: "Alpha", content: "one" },
          { id: "b", title: "Beta", content: "two" },
        ],
      });
    const uploader = {
      async upload(input: { source: string }) {
        uploaded.push(input.source);
      },
    };

    const first = await runConnectorSync({
      connectorId: connector.id,
      deps: { fetch: fetchStub },
      uploader,
    });
    assert.equal(first.status, "success");
    assert.equal(first.pulled, 2);
    assert.equal(first.ingested, 2);
    assert.equal(first.skipped, 0);
    assert.equal(uploaded.length, 2);

    const second = await runConnectorSync({
      connectorId: connector.id,
      deps: { fetch: fetchStub },
      uploader,
    });
    assert.equal(second.status, "success");
    assert.equal(second.ingested, 0);
    assert.equal(second.skipped, 2);
    assert.equal(uploaded.length, 2);

    const runs = listSyncRuns(connector.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]?.skipped, 2);
  });

  it("re-ingests a document whose content changed", async () => {
    const connector = seedHttpConnector();
    let content = "v1";
    const uploads: string[] = [];
    const fetchStub: HttpFetchLike = async () =>
      jsonResponse({ documents: [{ id: "a", title: "Alpha", content }] });
    const uploader = {
      async upload() {
        uploads.push("hit");
      },
    };
    await runConnectorSync({ connectorId: connector.id, deps: { fetch: fetchStub }, uploader });
    content = "v2";
    const second = await runConnectorSync({
      connectorId: connector.id,
      deps: { fetch: fetchStub },
      uploader,
    });
    assert.equal(second.ingested, 1);
    assert.equal(second.skipped, 0);
    assert.equal(uploads.length, 2);
  });

  it("records per-document failures without aborting the whole run", async () => {
    const connector = seedHttpConnector();
    const fetchStub: HttpFetchLike = async () =>
      jsonResponse({
        documents: [
          { id: "ok", title: "Fine", content: "1" },
          { id: "bad", title: "Broken", content: "2" },
        ],
      });
    const uploader = {
      async upload(input: { source: string }) {
        if (input.source.includes("bad")) throw new Error("rag exploded");
      },
    };
    const run = await runConnectorSync({
      connectorId: connector.id,
      deps: { fetch: fetchStub },
      uploader,
    });
    assert.equal(run.status, "partial");
    assert.equal(run.ingested, 1);
    assert.equal(run.failed, 1);
    assert.equal(run.failures[0]?.externalId, "bad");
    assert.match(run.failures[0]?.reason ?? "", /rag exploded/);
  });

  it("marks the run as error when fetching fails", async () => {
    const connector = seedHttpConnector();
    const fetchStub: HttpFetchLike = async () => jsonResponse({ error: "boom" }, 503);
    const run = await runConnectorSync({ connectorId: connector.id, deps: { fetch: fetchStub } });
    assert.equal(run.status, "error");
    assert.equal(run.pulled, 0);
    assert.match(run.error ?? "", /503/);
  });

  it("uses a stable rag source name derived from the external id", () => {
    assert.equal(ragSourceName("conn-1", "hr/1"), "conn-1-hr-1.md");
    assert.equal(ragSourceName("conn-1", "hr/1"), ragSourceName("conn-1", "hr/1"));
  });
});
