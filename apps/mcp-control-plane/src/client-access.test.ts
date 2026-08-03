import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ManagementError, type Actor, type IdGenerator } from "./management.js";
import { ClientAccessService } from "./client-access.js";
import { InMemoryClientAccessRepository } from "./client-access-repository.js";

const admin: Actor = { id: "admin-1", role: "admin" };
const operator: Actor = { id: "operator-1", role: "operator" };
const auditor: Actor = { id: "auditor-1", role: "auditor" };
const ids = [
  "018f5f8d-23f2-7ec7-a799-6f3988e86d01",
  "018f5f8d-23f2-7ec7-a799-6f3988e86d02",
  "018f5f8d-23f2-7ec7-a799-6f3988e86d03",
];

function sequentialIds(): IdGenerator {
  let index = 0;
  return () => ids[index++]!;
}

describe("Control Plane client access management", () => {
  let repository: InMemoryClientAccessRepository;
  let access: ClientAccessService;

  beforeEach(() => {
    repository = new InMemoryClientAccessRepository({ serviceIds: ["service-1"] });
    access = new ClientAccessService(repository, {
      createId: sequentialIds(),
      now: () => "2026-07-31T12:00:00.000Z",
      secretSource: () => Buffer.alloc(32, 7),
    });
  });

  it("AUTH-001 creates a client and displays a raw API Key exactly once", async () => {
    const client = await access.createClient({ name: "Reporting client" }, admin);
    const issued = await access.createApiKey(
      client.id,
      { expiresAt: "2026-08-31T00:00:00.000Z" },
      admin,
    );

    assert.equal(client.status, "ACTIVE");
    assert.match(issued.rawKey, /^mcp\./);
    assert.equal(issued.key.clientId, client.id);
    assert.equal("keyHash" in issued.key, false);

    const stored = repository.keys.get(issued.key.id)!;
    assert.match(stored.keyHash, /^scrypt\$/);
    assert.equal(stored.keyHash.includes(issued.rawKey), false);
    const listed = await access.listApiKeys(client.id, auditor);
    assert.equal("rawKey" in listed[0]!, false);
    assert.equal("keyHash" in listed[0]!, false);
  });

  it("AUTH-008 revokes an active key idempotently", async () => {
    const client = await access.createClient({ name: "Reporting client" }, admin);
    const issued = await access.createApiKey(client.id, {}, admin);

    const revoked = await access.revokeApiKey(client.id, issued.key.id, admin);
    assert.equal(revoked.status, "REVOKED");
    assert.equal((await access.revokeApiKey(client.id, issued.key.id, admin)).status, "REVOKED");
  });

  it("AUTH-004 creates and removes a scoped service grant with filters", async () => {
    const client = await access.createClient({ name: "Reporting client" }, admin);
    const grant = await access.upsertGrant(
      client.id,
      "service-1",
      {
        scopes: ["mcp:connect", "prompts:list", "prompts:get"],
        promptNames: ["summarize_report"],
        toolNames: null,
      },
      admin,
    );

    assert.deepEqual(grant.scopes, ["mcp:connect", "prompts:list", "prompts:get"]);
    assert.deepEqual(await access.listGrants(client.id, auditor), [grant]);
    await access.deleteGrant(client.id, "service-1", admin);
    assert.deepEqual(await access.listGrants(client.id, auditor), []);
  });

  it("rejects invalid scopes, missing services, and expired-at-creation keys", async () => {
    const client = await access.createClient({ name: "Reporting client" }, admin);

    await assert.rejects(
      access.upsertGrant(
        client.id,
        "service-1",
        { scopes: ["prompts:list"], promptNames: null, toolNames: null },
        admin,
      ),
      validationError,
    );
    await assert.rejects(
      access.upsertGrant(
        client.id,
        "missing",
        { scopes: ["mcp:connect"], promptNames: null, toolNames: null },
        admin,
      ),
      (error: unknown) => error instanceof ManagementError && error.code === "NOT_FOUND",
    );
    await assert.rejects(
      access.createApiKey(client.id, { expiresAt: "2026-07-01T00:00:00.000Z" }, admin),
      validationError,
    );
  });

  it("API-001 through API-004 enforce admin mutation and auditor read permissions", async () => {
    await assert.rejects(access.createClient({ name: "Denied" }, operator), forbidden);
    await assert.rejects(access.createClient({ name: "Denied" }, auditor), forbidden);

    const client = await access.createClient({ name: "Allowed" }, admin);
    assert.deepEqual(await access.listClients(auditor), [client]);
    await assert.rejects(access.listClients(operator), forbidden);
  });
});

function forbidden(error: unknown): boolean {
  return error instanceof ManagementError && error.code === "FORBIDDEN";
}

function validationError(error: unknown): boolean {
  return error instanceof ManagementError && error.code === "VALIDATION_ERROR";
}
