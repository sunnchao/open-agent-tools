import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { GatewayAccessError, GatewayAccessService } from "./access.js";
import { createApiKey } from "./api-key.js";
import {
  InMemoryGatewayRepository,
  type ApiClientRecord,
  type ApiKeyRecord,
  type ClientGrantRecord,
  type ManagedServiceSnapshot,
} from "./repository.js";

const keyId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd7";
const client: ApiClientRecord = { id: "client-1", status: "ACTIVE" };
const snapshot: ManagedServiceSnapshot = {
  serviceId: "service-1",
  serviceSlug: "reports",
  serviceStatus: "ACTIVE",
  versionId: "version-1",
  versionStatus: "PUBLISHED",
  imageDigest: null,
  limits: null,
  tools: [],
  prompts: [
    {
      name: "summarize_report",
      title: "Summarize report",
      description: "Summarize a report by id",
      arguments: [{ name: "reportId", required: true }],
      messages: [
        {
          role: "user",
          content: { type: "text", text: "Summarize {{reportId}}." },
        },
      ],
    },
  ],
};

describe("Gateway access decisions", () => {
  let repository: InMemoryGatewayRepository;
  let access: GatewayAccessService;
  let rawKey: string;
  let key: ApiKeyRecord;
  let grant: ClientGrantRecord;

  beforeEach(async () => {
    const created = await createApiKey(keyId, () => Buffer.alloc(32, 7));
    rawKey = created.rawKey;
    key = {
      id: keyId,
      clientId: client.id,
      keyHash: created.keyHash,
      status: "ACTIVE",
      expiresAt: "2026-08-31T00:00:00.000Z",
    };
    grant = {
      clientId: client.id,
      serviceId: snapshot.serviceId,
      scopes: ["mcp:connect", "prompts:list", "prompts:get"],
      promptNames: null,
      toolNames: null,
    };
    repository = new InMemoryGatewayRepository({
      clients: [client],
      keys: [key],
      grants: [grant],
      services: [snapshot],
    });
    access = new GatewayAccessService(repository, {
      now: () => "2026-07-31T12:00:00.000Z",
    });
  });

  it("AUTH-002 resolves an active client, grant, scopes, and published snapshot", async () => {
    const result = await access.authorize(rawKey, "reports");

    assert.equal(result.clientId, client.id);
    assert.equal(result.snapshot.versionId, snapshot.versionId);
    assert.deepEqual([...result.scopes], grant.scopes);
    assert.equal(repository.lastUsedAt.get(keyId), "2026-07-31T12:00:00.000Z");
  });

  it("AUTH-003 rejects unknown, revoked, and expired keys", async () => {
    await assert.rejects(
      access.authorize(`mcp.${keyId}.${Buffer.alloc(32, 9).toString("base64url")}`, "reports"),
      (error: unknown) => error instanceof GatewayAccessError && error.code === "UNAUTHORIZED",
    );

    repository.keys.set(keyId, { ...key, status: "REVOKED" });
    await assert.rejects(access.authorize(rawKey, "reports"), unauthorized);

    repository.keys.set(keyId, { ...key, expiresAt: "2026-07-01T00:00:00.000Z" });
    await assert.rejects(access.authorize(rawKey, "reports"), unauthorized);
  });

  it("AUTH-004 rejects clients without a service grant or mcp:connect", async () => {
    repository.grants.clear();
    await assert.rejects(
      access.authorize(rawKey, "reports"),
      (error: unknown) => error instanceof GatewayAccessError && error.code === "FORBIDDEN",
    );

    repository.grants.set(`${client.id}:${snapshot.serviceId}`, {
      ...grant,
      scopes: ["prompts:list", "prompts:get"],
    });
    await assert.rejects(
      access.authorize(rawKey, "reports"),
      (error: unknown) => error instanceof GatewayAccessError && error.code === "FORBIDDEN",
    );
  });

  it("GW-003 rejects disabled and unpublished managed services", async () => {
    repository.services.set("reports", { ...snapshot, serviceStatus: "DISABLED" });
    await assert.rejects(
      access.authorize(rawKey, "reports"),
      (error: unknown) =>
        error instanceof GatewayAccessError && error.code === "SERVICE_UNAVAILABLE",
    );

    repository.services.set("reports", { ...snapshot, versionStatus: "READY" });
    await assert.rejects(
      access.authorize(rawKey, "reports"),
      (error: unknown) =>
        error instanceof GatewayAccessError && error.code === "SERVICE_UNAVAILABLE",
    );
  });

  it("GW-010 observes a rolled-back snapshot and then rejects the disabled service", async () => {
    assert.equal((await access.authorize(rawKey, "reports")).snapshot.versionId, "version-1");

    repository.services.set("reports", {
      ...snapshot,
      versionId: "version-0",
      prompts: [
        {
          name: "legacy_summary",
          arguments: [],
          messages: [{ role: "user", content: { type: "text", text: "Legacy summary." } }],
        },
      ],
    });
    const rolledBack = await access.authorize(rawKey, "reports");
    assert.equal(rolledBack.snapshot.versionId, "version-0");
    assert.equal(rolledBack.snapshot.prompts[0]?.name, "legacy_summary");

    repository.services.set("reports", {
      ...rolledBack.snapshot,
      serviceStatus: "DISABLED",
    });
    await assert.rejects(
      access.authorize(rawKey, "reports"),
      (error: unknown) =>
        error instanceof GatewayAccessError && error.code === "SERVICE_UNAVAILABLE",
    );
  });

  it("GW-011 lists granted services for a valid key, skipping non-connect grants", async () => {
    repository.grants.set("client-1:service-2", {
      clientId: client.id,
      serviceId: "service-2",
      scopes: ["tools:list", "tools:call"],
      toolNames: null,
      promptNames: null,
    });
    repository.services.set("second", {
      ...snapshot,
      serviceId: "service-2",
      serviceSlug: "second",
    });

    const services = await access.listAuthorizedServices(rawKey);

    assert.deepEqual(
      services.map((service) => service.serviceSlug),
      ["reports"],
    );
    assert.deepEqual(services[0]?.scopes, grant.scopes);
    assert.equal(services[0]?.serviceStatus, "ACTIVE");
    assert.equal(services[0]?.versionStatus, "PUBLISHED");
    assert.deepEqual(services[0]?.prompts, [
      {
        name: "summarize_report",
        title: "Summarize report",
        description: "Summarize a report by id",
        arguments: [{ name: "reportId", required: true }],
      },
    ]);
    assert.equal(repository.lastUsedAt.get(keyId), "2026-07-31T12:00:00.000Z");
  });

  it("GW-012 returns an empty list when the client has no grants", async () => {
    repository.grants.clear();
    assert.deepEqual(await access.listAuthorizedServices(rawKey), []);
  });

  it("GW-013 rejects invalid keys on listAuthorizedServices", async () => {
    await assert.rejects(
      access.listAuthorizedServices(
        `mcp.${keyId}.${Buffer.alloc(32, 9).toString("base64url")}`,
      ),
      unauthorized,
    );

    repository.keys.set(keyId, { ...key, status: "REVOKED" });
    await assert.rejects(access.listAuthorizedServices(rawKey), unauthorized);
  });

  it("GW-014 skips grants whose service snapshot is missing", async () => {
    repository.grants.set(`${client.id}:missing`, {
      clientId: client.id,
      serviceId: "missing",
      scopes: ["mcp:connect"],
      toolNames: null,
      promptNames: null,
    });
    assert.deepEqual(
      (await access.listAuthorizedServices(rawKey)).map((service) => service.serviceSlug),
      ["reports"],
    );
  });

  it("GW-017 filters prompt metadata by the promptNames whitelist", async () => {
    repository.grants.set(`${client.id}:${snapshot.serviceId}`, {
      ...grant,
      promptNames: ["summarize_report"],
    });
    repository.services.set("reports", {
      ...snapshot,
      prompts: [
        ...snapshot.prompts,
        {
          name: "hidden_report",
          arguments: [],
          messages: [{ role: "user", content: { type: "text", text: "Hidden." } }],
        },
      ],
    });

    const services = await access.listAuthorizedServices(rawKey);

    assert.deepEqual(
      services[0]?.prompts.map((prompt) => prompt.name),
      ["summarize_report"],
    );
  });

  it("GW-018 returns an empty prompts array without prompts:list scope", async () => {
    repository.grants.set(`${client.id}:${snapshot.serviceId}`, {
      ...grant,
      scopes: ["mcp:connect", "prompts:get"],
    });

    const services = await access.listAuthorizedServices(rawKey);

    assert.deepEqual(services[0]?.prompts, []);
  });

  it("GW-019 returns an empty prompts array for a service without prompts", async () => {
    repository.services.set("reports", { ...snapshot, prompts: [] });

    const services = await access.listAuthorizedServices(rawKey);

    assert.deepEqual(services[0]?.prompts, []);
  });

  it("GW-020 sorts prompt metadata by name ascending", async () => {
    repository.services.set("reports", {
      ...snapshot,
      prompts: [
        {
          name: "zeta_report",
          arguments: [],
          messages: [{ role: "user", content: { type: "text", text: "Zeta." } }],
        },
        {
          name: "alpha_report",
          arguments: [],
          messages: [{ role: "user", content: { type: "text", text: "Alpha." } }],
        },
      ],
    });

    const services = await access.listAuthorizedServices(rawKey);

    assert.deepEqual(
      services[0]?.prompts.map((prompt) => prompt.name),
      ["alpha_report", "zeta_report"],
    );
  });
});

function unauthorized(error: unknown): boolean {
  return error instanceof GatewayAccessError && error.code === "UNAUTHORIZED";
}
