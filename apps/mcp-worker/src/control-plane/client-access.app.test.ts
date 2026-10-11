import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createControlPlaneApp } from "./app.js";
import { ClientAccessService } from "./client-access.js";
import { InMemoryClientAccessRepository } from "./client-access-repository.js";
import { McpManagementService, type Actor, type IdGenerator } from "./management.js";
import { InMemoryMcpManagementRepository } from "./repository.js";

const ids = [
  "018f5f8d-23f2-7ec7-a799-6f3988e86d01",
  "018f5f8d-23f2-7ec7-a799-6f3988e86d02",
  "018f5f8d-23f2-7ec7-a799-6f3988e86d03",
  "018f5f8d-23f2-7ec7-a799-6f3988e86d04",
  "018f5f8d-23f2-7ec7-a799-6f3988e86d05",
];

function sequentialIds(): IdGenerator {
  let index = 0;
  return () => ids[index++]!;
}

describe("Control Plane client access HTTP API", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let accessRepository: InMemoryClientAccessRepository;

  beforeEach(async () => {
    const createId = sequentialIds();
    accessRepository = new InMemoryClientAccessRepository();
    const app = createControlPlaneApp({
      management: new McpManagementService(new InMemoryMcpManagementRepository(), {
        createId,
        now: () => "2026-07-31T12:00:00.000Z",
      }),
      clientAccess: new ClientAccessService(accessRepository, {
        createId,
        now: () => "2026-07-31T12:00:00.000Z",
        secretSource: () => Buffer.alloc(32, 7),
      }),
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

  afterEach(async () => {
    await closeServer();
  });

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

  it("manages a client, one-time Key, and service grant without exposing hashes", async () => {
    const clientResponse = await request("/api/admin/mcp/clients", {
      method: "POST",
      body: JSON.stringify({ name: "Reporting client" }),
    });
    assert.equal(clientResponse.status, 201);
    const { client } = (await clientResponse.json()) as { client: { id: string } };

    const keyResponse = await request(`/api/admin/mcp/clients/${client.id}/keys`, {
      method: "POST",
      body: JSON.stringify({ expiresAt: "2026-08-31T00:00:00.000Z" }),
    });
    assert.equal(keyResponse.status, 201);
    const issued = (await keyResponse.json()) as {
      key: { id: string };
      rawKey: string;
    };
    assert.match(issued.rawKey, /^mcp\./);

    const keysResponse = await request(`/api/admin/mcp/clients/${client.id}/keys`, {}, "auditor");
    assert.equal(keysResponse.status, 200);
    const keysBody = await keysResponse.text();
    assert.equal(keysBody.includes("rawKey"), false);
    assert.equal(keysBody.includes("keyHash"), false);

    accessRepository.serviceIds.add("service-1");
    const grantResponse = await request(`/api/admin/mcp/clients/${client.id}/grants/service-1`, {
      method: "PUT",
      body: JSON.stringify({
        scopes: ["mcp:connect", "prompts:list", "prompts:get"],
        promptNames: ["summarize_report"],
        toolNames: null,
      }),
    });
    assert.equal(grantResponse.status, 200);

    const revokeResponse = await request(
      `/api/admin/mcp/clients/${client.id}/keys/${issued.key.id}`,
      { method: "DELETE" },
    );
    assert.equal(revokeResponse.status, 204);
  });

  it("forbids operator access and auditor mutations", async () => {
    assert.equal((await request("/api/admin/mcp/clients", {}, "operator")).status, 403);
    assert.equal(
      (
        await request(
          "/api/admin/mcp/clients",
          { method: "POST", body: JSON.stringify({ name: "Denied" }) },
          "auditor",
        )
      ).status,
      403,
    );
  });
});
