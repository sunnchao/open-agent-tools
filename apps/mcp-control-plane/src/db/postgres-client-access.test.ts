import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { verifyApiKey } from "@open-agent-tools/mcp-auth";
import { Pool } from "pg";
import { ClientAccessService } from "../client-access.js";
import type { Actor } from "../management.js";
import { createPostgresClientAccessRepository } from "./postgres-client-access-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin: Actor = { id: "admin-1", role: "admin" };
const auditor: Actor = { id: "auditor-1", role: "auditor" };
const serviceId = "018f5f8d-23f2-7ec7-a799-6f3988e86da1";
const ids = [
  "018f5f8d-23f2-7ec7-a799-6f3988e86da2",
  "018f5f8d-23f2-7ec7-a799-6f3988e86da3",
  "018f5f8d-23f2-7ec7-a799-6f3988e86da4",
];

describe("PostgreSQL client access repository", { skip: !databaseUrl }, () => {
  let pool: Pool;
  let access: ClientAccessService;
  let closeRepository: () => Promise<void>;

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    for (const migrationName of ["0000_mcp_management.sql", "0001_mcp_client_access.sql"]) {
      const migration = await readFile(
        resolve(import.meta.dirname, `../../drizzle/${migrationName}`),
        "utf8",
      );
      await pool.query(migration);
    }
    const created = createPostgresClientAccessRepository(databaseUrl!);
    closeRepository = created.close;
    let index = 0;
    access = new ClientAccessService(created.repository, {
      createId: () => ids[index++]!,
      now: () => "2026-07-31T12:00:00.000Z",
      secretSource: () => Buffer.alloc(32, 7),
    });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE mcp_services, api_clients CASCADE");
    await pool.query(
      `INSERT INTO mcp_services
         (id, name, slug, type, status, revision, created_at, updated_at)
       VALUES ($1, 'Reports', 'reports', 'MANAGED_MCP', 'DRAFT', 1, $2, $2)`,
      [serviceId, "2026-07-31T12:00:00.000Z"],
    );
  });

  after(async () => {
    await closeRepository();
    await pool.end();
  });

  it("persists a one-time Key, grant, listing, and revocation", async () => {
    const client = await access.createClient({ name: "Reporting client" }, admin);
    const issued = await access.createApiKey(
      client.id,
      { expiresAt: "2026-08-31T00:00:00.000Z" },
      admin,
    );
    const grant = await access.upsertGrant(
      client.id,
      serviceId,
      {
        scopes: ["mcp:connect", "prompts:list", "prompts:get"],
        promptNames: ["summarize"],
        toolNames: null,
      },
      admin,
    );

    const stored = await pool.query<{ key_hash: string }>(
      "SELECT key_hash FROM api_keys WHERE id = $1",
      [issued.key.id],
    );
    assert.equal(await verifyApiKey(issued.rawKey, stored.rows[0]!.key_hash), true);
    assert.equal(stored.rows[0]!.key_hash.includes(issued.rawKey), false);
    assert.equal((await access.listClients(auditor))[0]?.id, client.id);
    assert.equal((await access.listApiKeys(client.id, auditor))[0]?.id, issued.key.id);
    assert.deepEqual(await access.listGrants(client.id, auditor), [grant]);

    await access.revokeApiKey(client.id, issued.key.id, admin);
    assert.equal((await access.listApiKeys(client.id, auditor))[0]?.status, "REVOKED");
    await access.deleteGrant(client.id, serviceId, admin);
    assert.deepEqual(await access.listGrants(client.id, auditor), []);
  });
});
