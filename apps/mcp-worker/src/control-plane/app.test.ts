import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createControlPlaneApp } from "./app.js";
import { McpManagementService, type Actor, type IdGenerator } from "./management.js";
import { InMemoryMcpManagementRepository } from "./repository.js";
import type { McpServiceVersionRecord } from "./types.js";

function sequentialIds(): IdGenerator {
  let value = 0;
  return () => `id-${++value}`;
}

describe("Control Plane HTTP API", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let management: McpManagementService;
  let repository: InMemoryMcpManagementRepository;

  beforeEach(async () => {
    repository = new InMemoryMcpManagementRepository();
    management = new McpManagementService(repository, {
      createId: sequentialIds(),
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const app = createControlPlaneApp({
      management,
      authenticate(request): Actor | null {
        const role = request.header("x-test-role");
        if (role !== "admin" && role !== "operator" && role !== "auditor") return null;
        return { id: `${role}-1`, role };
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await closeServer();
  });

  async function request(path: string, init: RequestInit = {}, role = "operator") {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-test-role": role,
        ...init.headers,
      },
    });
  }

  it("persists version limits over HTTP with validation, revision and lifecycle guards", async () => {
    const operator: Actor = { id: "operator-1", role: "operator" };
    const { service, draftVersion } = await management.createManagedService(
      { name: "Web search", slug: "web-search" },
      operator,
    );
    const imported = await management.importPackageManifest(
      draftVersion.id,
      {
        schemaVersion: 1,
        runtime: { name: "nodejs", version: "20" },
        entry: "src/index.js",
        tools: [{ name: "web_search", handler: "webSearch", inputSchema: { type: "object" } }],
        limits: { timeoutMs: 30_000, memoryMb: 256, cpuMillis: 1_000, network: "none" },
      },
      `sha256:${"a".repeat(64)}`,
      1,
      operator,
    );
    const endpoint = `/api/admin/mcp/services/${service.id}/versions/${imported.id}/limits`;
    const limits = { timeoutMs: 15_000, memoryMb: 512, cpuMillis: 500, network: "bridge" };
    const init = {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: imported.revision, limits }),
    };
    const saved = await request(endpoint, init);
    assert.equal(saved.status, 200);
    const { version } = (await saved.json()) as { version: McpServiceVersionRecord };
    assert.deepEqual(version.limits, limits);
    assert.equal(version.revision, imported.revision + 1);
    assert.equal((await request(endpoint, init)).status, 409);
    assert.equal((await request(endpoint, init, "auditor")).status, 403);
    assert.equal((await request(endpoint.replace(service.id, "wrong-service"), init)).status, 404);
    assert.equal(
      (
        await request(endpoint, {
          method: "PUT",
          body: JSON.stringify({
            expectedRevision: version.revision,
            limits: { ...limits, network: "host" },
          }),
        })
      ).status,
      400,
    );
    repository.versions.set(imported.id, { ...version, status: "PUBLISHED" });
    assert.equal(
      (
        await request(endpoint, {
          method: "PUT",
          body: JSON.stringify({ expectedRevision: version.revision, limits }),
        })
      ).status,
      409,
    );
  });

  it("serves the Prompt-only create, configure, preview, validate, and publish path", async () => {
    const createResponse = await request("/api/admin/mcp/services", {
      method: "POST",
      body: JSON.stringify({ name: "Reports", slug: "reports", type: "MANAGED_MCP" }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as {
      service: { id: string };
      draftVersion: { id: string; revision: number };
    };

    const addResponse = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${created.draftVersion.id}/prompts`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: created.draftVersion.revision,
          prompt: {
            name: "summarize_report",
            arguments: [{ name: "reportId", required: true }],
            messages: [
              {
                role: "user",
                content: { type: "text", text: "Summarize {{reportId}}." },
              },
            ],
          },
        }),
      },
    );
    assert.equal(addResponse.status, 201);
    const configured = (await addResponse.json()) as {
      version: { revision: number; prompts: Array<{ id: string }> };
    };

    const previewResponse = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${created.draftVersion.id}/prompts/${configured.version.prompts[0]!.id}/preview`,
      {
        method: "POST",
        body: JSON.stringify({ arguments: { reportId: "report-1" } }),
      },
    );
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as {
      prompt: { messages: Array<{ content: { text: string } }> };
    };
    assert.equal(preview.prompt.messages[0]?.content.text, "Summarize report-1.");

    const validateResponse = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${created.draftVersion.id}/validate`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: configured.version.revision }),
      },
    );
    assert.equal(validateResponse.status, 200);
    const ready = (await validateResponse.json()) as { version: { revision: number } };

    const forbiddenPublish = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${created.draftVersion.id}/publish`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: ready.version.revision }),
      },
    );
    assert.equal(forbiddenPublish.status, 403);

    const publishResponse = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${created.draftVersion.id}/publish`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: ready.version.revision }),
      },
      "admin",
    );
    assert.equal(publishResponse.status, 200);
    const published = (await publishResponse.json()) as {
      service: { status: string };
      version: { status: string };
    };
    assert.equal(published.service.status, "ACTIVE");
    assert.equal(published.version.status, "PUBLISHED");
  });

  it("saves, masks, retains and clears service environment variables over HTTP", async () => {
    const { service } = await management.createManagedService(
      { name: "Search", slug: "search" },
      { id: "operator-1", role: "operator" },
    );
    const endpoint = `/api/admin/mcp/services/${service.id}/environment`;
    const saved = await request(endpoint, {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, environment: { TAVILY_API_KEY: "secret" } }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      environment: { TAVILY_API_KEY: null },
      revision: 2,
    });
    const loaded = await request(endpoint);
    assert.deepEqual(await loaded.json(), { environment: { TAVILY_API_KEY: null }, revision: 2 });
    const retained = await request(endpoint, {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: 2,
        environment: { TAVILY_API_KEY: null, EMPTY: "" },
      }),
    });
    assert.equal(retained.status, 200);
    assert.deepEqual(await repository.getServiceEnvironment(service.id), {
      TAVILY_API_KEY: "secret",
      EMPTY: "",
    });
    const stale = await request(endpoint, {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 2, environment: {} }),
    });
    assert.equal(stale.status, 409);
    const invalid = await request(endpoint, {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 3, environment: { MCP_TOOL_OUTPUT: "bad" } }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await request(endpoint, {}, "auditor")).status, 403);
    const cleared = await request(endpoint, {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 3, environment: {} }),
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { environment: {}, revision: 4 });
    assert.equal((await request("/api/admin/mcp/services/missing/environment")).status, 404);
  });

  it("allows anonymous administration when no authenticator is configured", async () => {
    const publicApp = createControlPlaneApp({ management });
    const publicServer = publicApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      publicServer.once("listening", resolve);
      publicServer.once("error", reject);
    });

    try {
      const address = publicServer.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/mcp/services`);
      assert.equal(response.status, 200);
    } finally {
      await new Promise<void>((resolve) => publicServer.close(() => resolve()));
    }
  });

  it("allows an explicitly configured browser origin before authentication", async () => {
    const corsApp = createControlPlaneApp({
      management,
      corsOrigin: "http://127.0.0.1:8088",
      authenticate: () => null,
    });
    const corsServer = corsApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      corsServer.once("listening", resolve);
      corsServer.once("error", reject);
    });

    try {
      const address = corsServer.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/api/admin/mcp/services`;
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          origin: "http://127.0.0.1:8088",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:8088");

      const response = await fetch(url, {
        headers: { origin: "http://127.0.0.1:8088" },
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:8088");
    } finally {
      await new Promise<void>((resolve) => corsServer.close(() => resolve()));
    }
  });

  it("does not enable cross-origin access by default", async () => {
    const response = await fetch(`${baseUrl}/api/admin/mcp/services`, {
      headers: { origin: "http://127.0.0.1:8088", "x-test-role": "operator" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });

  it("recreates a deleted service with the same slug over HTTP", async () => {
    const body = JSON.stringify({ name: "Web search", slug: "web-search", type: "MANAGED_MCP" });
    const first = await request("/api/admin/mcp/services", { method: "POST", body });
    assert.equal(first.status, 201);
    const original = (await first.json()) as { service: { id: string; revision: number } };

    const deleted = await request(
      `/api/admin/mcp/services/${original.service.id}`,
      {
        method: "DELETE",
        body: JSON.stringify({ expectedRevision: original.service.revision }),
      },
      "admin",
    );
    assert.equal(deleted.status, 204);
    assert.equal((await request(`/api/admin/mcp/services/${original.service.id}`)).status, 404);

    const recreated = await request("/api/admin/mcp/services", { method: "POST", body });
    assert.equal(recreated.status, 201);
    const replacement = (await recreated.json()) as { service: { id: string; slug: string } };
    assert.notEqual(replacement.service.id, original.service.id);
    assert.equal(replacement.service.slug, "web-search");
    const listed = (await (await request("/api/admin/mcp/services")).json()) as {
      services: Array<{ id: string }>;
    };
    assert.deepEqual(
      listed.services.map((service) => service.id),
      [replacement.service.id],
    );
    assert.equal((await request("/api/admin/mcp/services", { method: "POST", body })).status, 409);
  });

  it("returns protocol-stable auth, validation, conflict, and immutability errors", async () => {
    const unauthorized = await fetch(`${baseUrl}/api/admin/mcp/services`);
    assert.equal(unauthorized.status, 401);

    const forbidden = await request(
      "/api/admin/mcp/services",
      {
        method: "POST",
        body: JSON.stringify({ name: "Reports", slug: "reports", type: "MANAGED_MCP" }),
      },
      "auditor",
    );
    assert.equal(forbidden.status, 403);

    const invalid = await request("/api/admin/mcp/services", {
      method: "POST",
      body: JSON.stringify({ name: "", slug: "Bad Slug", type: "MANAGED_MCP" }),
    });
    assert.equal(invalid.status, 400);
    const error = (await invalid.json()) as { error: { code: string } };
    assert.equal(error.error.code, "VALIDATION_ERROR");

    const first = await request("/api/admin/mcp/services", {
      method: "POST",
      body: JSON.stringify({ name: "Reports", slug: "reports", type: "MANAGED_MCP" }),
    });
    assert.equal(first.status, 201);
    const duplicate = await request("/api/admin/mcp/services", {
      method: "POST",
      body: JSON.stringify({ name: "Other", slug: "reports", type: "MANAGED_MCP" }),
    });
    assert.equal(duplicate.status, 409);
  });

  it("API-009-A serves rollback and disable with role and revision guards", async () => {
    const created = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      { id: "operator-1", role: "operator" },
    );
    const configured = await management.addPrompt(
      created.draftVersion.id,
      {
        name: "summarize",
        arguments: [],
        messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
      },
      created.draftVersion.revision,
      { id: "operator-1", role: "operator" },
    );
    const ready = await management.validateVersion(configured.id, configured.revision, {
      id: "operator-1",
      role: "operator",
    });
    const published = await management.publishVersion(ready.id, ready.revision, {
      id: "admin-1",
      role: "admin",
    });

    const rollbackReady: McpServiceVersionRecord = {
      ...published.version,
      id: "version-2",
      versionNumber: 2,
      status: "READY",
      revision: 1,
    };
    repository.versions.set(rollbackReady.id, structuredClone(rollbackReady));
    const republished = await management.publishVersion(rollbackReady.id, rollbackReady.revision, {
      id: "admin-1",
      role: "admin",
    });
    const currentV1 = await management.getVersion(published.version.id, {
      id: "admin-1",
      role: "admin",
    });
    const rollbackForbidden = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${currentV1.id}/rollback`,
      { method: "POST", body: JSON.stringify({ expectedRevision: currentV1.revision }) },
      "auditor",
    );
    assert.equal(rollbackForbidden.status, 403);

    const rolledBack = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${currentV1.id}/rollback`,
      { method: "POST", body: JSON.stringify({ expectedRevision: currentV1.revision }) },
      "admin",
    );
    assert.equal(rolledBack.status, 200);
    const rollbackPayload = (await rolledBack.json()) as {
      service: { currentVersionId: string; status: string; revision: number };
      version: { id: string; status: string };
    };
    assert.equal(rollbackPayload.service.currentVersionId, published.version.id);
    assert.equal(rollbackPayload.service.status, "ACTIVE");
    assert.equal(rollbackPayload.version.status, "PUBLISHED");
    assert.notEqual(republished.version.id, rollbackPayload.version.id);

    const operatorDisable = await request(
      `/api/admin/mcp/services/${created.service.id}/disable`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: rollbackPayload.service.revision }),
      },
      "operator",
    );
    assert.equal(operatorDisable.status, 403);

    const disabled = await request(
      `/api/admin/mcp/services/${created.service.id}/disable`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: rollbackPayload.service.revision }),
      },
      "admin",
    );
    assert.equal(disabled.status, 200);
    assert.equal(
      ((await disabled.json()) as { service: { status: string } }).service.status,
      "DISABLED",
    );

    const staleDisable = await request(
      `/api/admin/mcp/services/${created.service.id}/disable`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: rollbackPayload.service.revision }),
      },
      "admin",
    );
    assert.equal(staleDisable.status, 409);
  });

  it("API-009-B re-enables a disabled service via the enable route", async () => {
    const created = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      { id: "operator-1", role: "operator" },
    );
    const configured = await management.addPrompt(
      created.draftVersion.id,
      {
        name: "summarize",
        arguments: [],
        messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
      },
      created.draftVersion.revision,
      { id: "operator-1", role: "operator" },
    );
    const ready = await management.validateVersion(configured.id, configured.revision, {
      id: "operator-1",
      role: "operator",
    });
    const published = await management.publishVersion(ready.id, ready.revision, {
      id: "admin-1",
      role: "admin",
    });
    const disabled = await request(
      `/api/admin/mcp/services/${created.service.id}/disable`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: published.service.revision }),
      },
      "admin",
    );
    assert.equal(disabled.status, 200);
    const disabledPayload = (await disabled.json()) as {
      service: { status: string; revision: number };
    };
    assert.equal(disabledPayload.service.status, "DISABLED");

    const operatorEnable = await request(
      `/api/admin/mcp/services/${created.service.id}/enable`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: disabledPayload.service.revision }),
      },
      "operator",
    );
    assert.equal(operatorEnable.status, 403);

    const enabled = await request(
      `/api/admin/mcp/services/${created.service.id}/enable`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: disabledPayload.service.revision }),
      },
      "admin",
    );
    assert.equal(enabled.status, 200);
    const enabledPayload = (await enabled.json()) as {
      service: { status: string; revision: number };
    };
    assert.equal(enabledPayload.service.status, "ACTIVE");
    assert.equal(enabledPayload.service.revision, disabledPayload.service.revision + 1);

    const staleEnable = await request(
      `/api/admin/mcp/services/${created.service.id}/enable`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: disabledPayload.service.revision }),
      },
      "admin",
    );
    assert.equal(staleEnable.status, 409);
  });

  it("API-010 resets an unpublished READY version to draft via the route", async () => {
    const created = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      { id: "operator-1", role: "operator" },
    );
    const configured = await management.addPrompt(
      created.draftVersion.id,
      {
        name: "summarize",
        arguments: [],
        messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
      },
      created.draftVersion.revision,
      { id: "operator-1", role: "operator" },
    );
    const ready = await management.validateVersion(configured.id, configured.revision, {
      id: "operator-1",
      role: "operator",
    });

    const auditorReset = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${ready.id}/reset-to-draft`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: ready.revision }),
      },
      "auditor",
    );
    assert.equal(auditorReset.status, 403);

    const reset = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${ready.id}/reset-to-draft`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: ready.revision }),
      },
      "operator",
    );
    assert.equal(reset.status, 200);
    const resetPayload = (await reset.json()) as { version: { status: string; revision: number } };
    assert.equal(resetPayload.version.status, "DRAFT");
    assert.equal(resetPayload.version.revision, ready.revision + 1);

    const staleReset = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${ready.id}/reset-to-draft`,
      {
        method: "POST",
        body: JSON.stringify({ expectedRevision: ready.revision }),
      },
      "operator",
    );
    assert.equal(staleReset.status, 409);
  });

  it("API-011 forks a new draft from a published version via the route", async () => {
    const created = await management.createManagedService(
      { name: "Reports", slug: "reports" },
      { id: "operator-1", role: "operator" },
    );
    const configured = await management.addPrompt(
      created.draftVersion.id,
      {
        name: "summarize",
        arguments: [],
        messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
      },
      created.draftVersion.revision,
      { id: "operator-1", role: "operator" },
    );
    const ready = await management.validateVersion(configured.id, configured.revision, {
      id: "operator-1",
      role: "operator",
    });
    const published = await management.publishVersion(ready.id, ready.revision, {
      id: "admin-1",
      role: "admin",
    });

    const auditorFork = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${published.version.id}/fork-draft`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      "auditor",
    );
    assert.equal(auditorFork.status, 403);

    const fork = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/${published.version.id}/fork-draft`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      "operator",
    );
    assert.equal(fork.status, 200);
    const forkPayload = (await fork.json()) as {
      version: { id: string; status: string; versionNumber: number; prompts: unknown[] };
    };
    assert.equal(forkPayload.version.status, "DRAFT");
    assert.equal(forkPayload.version.versionNumber, 2);
    assert.equal(forkPayload.version.prompts.length, 1);
    assert.notEqual(forkPayload.version.id, published.version.id);

    const missingFork = await request(
      `/api/admin/mcp/services/${created.service.id}/versions/missing-version/fork-draft`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      "operator",
    );
    assert.equal(missingFork.status, 404);
  });

  it("manages REMOTE_MCP upstream config over HTTP with redacted tokens", async () => {
    const created = await request(
      "/api/admin/mcp/services",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Upstream",
          slug: "upstream",
          type: "REMOTE_MCP",
          remote: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
            token: "super-secret",
            timeoutMs: 15_000,
          },
        }),
      },
      "admin",
    );
    assert.equal(created.status, 201);
    const createdPayload = (await created.json()) as {
      service: { id: string };
      draftVersion: {
        id: string;
        revision: number;
        status: string;
        remoteConfig: { url: string; hasToken: boolean; token?: string; timeoutMs: number };
      };
    };
    // 创建即发布；token 脱敏，仅保留 hasToken。
    assert.equal(createdPayload.draftVersion.status, "PUBLISHED");
    assert.equal(createdPayload.draftVersion.remoteConfig.hasToken, true);
    assert.ok(!("token" in createdPayload.draftVersion.remoteConfig));

    const versions = (await (
      await request(`/api/admin/mcp/services/${createdPayload.service.id}/versions`)
    ).json()) as {
      versions: Array<{ remoteConfig: { hasToken: boolean; token?: string } | null }>;
    };
    assert.equal(versions.versions[0]?.remoteConfig?.hasToken, true);
    assert.ok(!("token" in (versions.versions[0]?.remoteConfig ?? {})));

    // 已发布版本不可直接改远端配置。
    const immutable = await request(
      `/api/admin/mcp/services/${createdPayload.service.id}/versions/${createdPayload.draftVersion.id}/remote-config`,
      {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: createdPayload.draftVersion.revision,
          remote: {},
        }),
      },
      "admin",
    );
    assert.equal(immutable.status, 409);

    // fork 草稿后可改；空 token=保留已有。
    const fork = await request(
      `/api/admin/mcp/services/${createdPayload.service.id}/versions/${createdPayload.draftVersion.id}/fork-draft`,
      { method: "POST", body: JSON.stringify({}) },
      "operator",
    );
    assert.equal(fork.status, 200);
    const forkPayload = (await fork.json()) as {
      version: { id: string; revision: number; remoteConfig: { hasToken: boolean } };
    };
    const updated = await request(
      `/api/admin/mcp/services/${createdPayload.service.id}/versions/${forkPayload.version.id}/remote-config`,
      {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: forkPayload.version.revision,
          remote: { url: "https://mcp.example.com/v2", token: "" },
        }),
      },
      "admin",
    );
    assert.equal(updated.status, 200);
    const updatedPayload = (await updated.json()) as {
      version: { remoteConfig: { url: string; hasToken: boolean; token?: string } };
    };
    // 空字符串=清除 token。
    assert.equal(updatedPayload.version.remoteConfig.url, "https://mcp.example.com/v2");
    assert.equal(updatedPayload.version.remoteConfig.hasToken, false);
    assert.ok(!("token" in updatedPayload.version.remoteConfig));

    // MANAGED 版本没有远端配置。
    const managed = await request(
      "/api/admin/mcp/services",
      { method: "POST", body: JSON.stringify({ name: "M", slug: "m", type: "MANAGED_MCP" }) },
      "admin",
    );
    const managedPayload = (await managed.json()) as {
      service: { id: string };
      draftVersion: { id: string; revision: number };
    };
    const misuse = await request(
      `/api/admin/mcp/services/${managedPayload.service.id}/versions/${managedPayload.draftVersion.id}/remote-config`,
      {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: managedPayload.draftVersion.revision,
          remote: {},
        }),
      },
      "admin",
    );
    assert.equal(misuse.status, 409);
  });

  it("rejects unreachable remote upstreams with a 502 probe error", async () => {
    const probe = await request(
      "/api/admin/mcp/remote/test-connection",
      {
        method: "POST",
        body: JSON.stringify({
          remote: { transport: "streamable-http", url: "ftp://mcp.example.com/mcp" },
        }),
      },
      "admin",
    );
    // 非法 URL 在输入校验阶段即被拒绝。
    assert.equal(probe.status, 400);

    const unreachable = await request(
      "/api/admin/mcp/remote/test-connection",
      {
        method: "POST",
        body: JSON.stringify({
          remote: { transport: "streamable-http", url: "http://127.0.0.1:1/mcp", timeoutMs: 500 },
        }),
      },
      "admin",
    );
    assert.equal(unreachable.status, 502);
    const payload = (await unreachable.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "UPSTREAM_ERROR");
  });
});
