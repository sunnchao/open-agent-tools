import { createPostgresPool, type Pool } from "@open-agent-tools/database/postgres";
import { redactAuditPayload, type AuditEvent } from "@open-agent-tools/observability/audit";

export interface GatewayAuditSink {
  record(event: AuditEvent): Promise<void>;
}

export class PostgresGatewayAudit implements GatewayAuditSink {
  #pending: Promise<void> = Promise.resolve();

  constructor(private readonly pool: Pool) {}

  record(input: AuditEvent): Promise<void> {
    this.#pending = this.#pending
      .then(async () => {
        let secrets: string[] = [];
        const serviceId = (input.context as { serviceId?: unknown } | null)?.serviceId;
        if (typeof serviceId === "string") {
          const result = await this.pool.query<{ environment: Record<string, string> | null }>(
            "SELECT environment FROM mcp_services WHERE id = $1",
            [serviceId],
          );
          secrets = Object.values(result.rows[0]?.environment ?? {});
        }
        const event = redactAuditPayload(input, secrets) as unknown as AuditEvent;
        await this.pool.query(
          `INSERT INTO mcp_audit_events
          (id, actor_id, actor_role, source, action, target, request_id, outcome,
           status_code, duration_ms, created_at, input, output, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb)`,
          [
            event.id,
            event.actorId,
            event.actorRole,
            event.source,
            event.action,
            event.target,
            event.requestId,
            event.outcome,
            event.statusCode,
            event.durationMs,
            event.createdAt,
            JSON.stringify(event.input),
            JSON.stringify(event.output),
            JSON.stringify(event.context),
          ],
        );
      })
      .catch((error) => {
        console.error("Failed to write MCP audit event", {
          code: (error as { code?: string }).code,
        });
      });
    return this.#pending;
  }

  async flush(): Promise<void> {
    await this.#pending;
  }
}

export function createPostgresGatewayAudit(databaseUrl: string) {
  const { pool, close } = createPostgresPool(databaseUrl);
  const audit = new PostgresGatewayAudit(pool);
  return {
    audit,
    close: async () => {
      await audit.flush();
      await close();
    },
  };
}
