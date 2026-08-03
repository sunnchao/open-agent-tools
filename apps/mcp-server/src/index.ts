import { config as loadEnv } from "dotenv";
import { GatewayAccessService } from "./gateway/access.js";
import { createGatewayApp } from "./gateway/app.js";
import { createBullMqToolExecutor } from "./gateway/bullmq-tool-executor.js";
import { createPostgresGatewayRepository } from "./gateway/postgres-repository.js";

loadEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const { repository, close } = createPostgresGatewayRepository(databaseUrl);
const execution = process.env.REDIS_URL ? createBullMqToolExecutor(process.env.REDIS_URL) : null;
const app = createGatewayApp({
  access: new GatewayAccessService(repository),
  ...(execution === null ? {} : { executor: execution.executor }),
});
const port = Number(process.env.MCP_HTTP_PORT) || 4100;
const server = app.listen(port, () => {
  console.error(`MCP Gateway listening on http://localhost:${port}/mcp`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await Promise.all([close(), execution?.close()]);
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
