import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createControlPlaneApp } from "./app.js";
import { InMemoryAuditRepository } from "./audit-repository.js";
import { AuditService } from "./audit.js";
import { McpManagementService, type Actor } from "./management.js";
import { InMemoryMcpManagementRepository } from "./repository.js";

describe("Control Plane audit HTTP API", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    let id = 0;
    const createId = () => `audit-id-${++id}`;
    const audit = new AuditService(new InMemoryAuditRepository(), {
      createId,
      now: () => "2026-08-01T08:00:00.000Z",
    });
    const app = createControlPlaneApp({
      management: new McpManagementService(new InMemoryMcpManagementRepository(), {
        createId,
        now: () => "2026-08-01T08:00:00.000Z",
      }),
      audit,
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
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => closeServer());

  function request(path: string, init: RequestInit = {}, role = "admin") {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-test-role": role,
        ...init.headers,
      },
    });
  }

  it("records successful and failed mutations without request bodies", async () => {
    const success = await request("/api/admin/mcp/services", {
      method: "POST",
      headers: { "x-request-id": "request-success" },
      body: JSON.stringify({ name: "Reports", slug: "reports", type: "MANAGED_MCP" }),
    });
    assert.equal(success.status, 201);

    const failure = await request("/api/admin/mcp/services", {
      method: "POST",
      headers: { "x-request-id": "request-failure" },
      body: JSON.stringify({ name: "Remote", slug: "remote", type: "REMOTE_MCP" }),
    });
    assert.equal(failure.status, 400);

    const response = await request("/api/admin/mcp/audit?limit=10");
    assert.equal(response.status, 200);
    const { events } = (await response.json()) as {
      events: Array<{
        action: string;
        target: string;
        requestId: string;
        outcome: string;
        statusCode: number;
      }>;
    };
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map(({ action, target, requestId, outcome, statusCode }) => ({
        action,
        target,
        requestId,
        outcome,
        statusCode,
      })),
      [
        {
          action: "POST /api/admin/mcp/services",
          target: "/api/admin/mcp/services",
          requestId: "request-success",
          outcome: "SUCCEEDED",
          statusCode: 201,
        },
        {
          action: "POST /api/admin/mcp/services",
          target: "/api/admin/mcp/services",
          requestId: "request-failure",
          outcome: "FAILED",
          statusCode: 400,
        },
      ],
    );
    assert.equal(JSON.stringify(events).includes("Reports"), false);
    assert.equal((await request("/api/admin/mcp/audit", {}, "operator")).status, 403);
  });
});
