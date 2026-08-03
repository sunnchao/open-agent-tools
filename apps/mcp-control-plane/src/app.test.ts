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
    const disabledPayload = (await disabled.json()) as { service: { status: string; revision: number } };
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
    const enabledPayload = (await enabled.json()) as { service: { status: string; revision: number } };
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
});
