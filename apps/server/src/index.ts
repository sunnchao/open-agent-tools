import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { port } from "./config.js";
import { getDbPath, openDb } from "./db.js";
import { initializeProviders } from "./providers/store.js";
import { logTrace } from "./trace.js";

loadEnv({ path: resolve(import.meta.dirname, "../.env") });
loadEnv({ path: resolve(import.meta.dirname, "../.env.local"), override: true });

openDb();
initializeProviders();

const app = createApp();

export { app };

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`server listening on http://localhost:${port}`);
    console.log(`sqlite: ${getDbPath()}`);
    logTrace("server.started", {
      port,
      db: getDbPath(),
      env: process.env.NODE_ENV ?? "development",
    });
  });
}
