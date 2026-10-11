import { ToolEnvironmentSchema } from "@open-agent-tools/mcp-contracts";
import { createPostgresPool } from "@open-agent-tools/database/postgres";

export function createPostgresToolEnvironmentLoader(databaseUrl: string) {
  const { pool, close } = createPostgresPool(databaseUrl);
  return {
    load: async (serviceId: string): Promise<Record<string, string>> => {
      const result = await pool.query<{ environment: unknown }>(
        "SELECT environment FROM mcp_services WHERE id = $1 AND status <> 'DELETED'",
        [serviceId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Tool service environment is unavailable");
      return ToolEnvironmentSchema.parse(row.environment);
    },
    close,
  };
}
