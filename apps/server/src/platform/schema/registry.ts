/**
 * SQLite schema 注册表。
 *
 * 每个业务域自带表定义与迁移，这里只负责**顺序**：
 * 顺序是有语义的，不是模块加载顺序，因此必须显式写死。
 *
 * 约束：
 * - 所有 DDL 必须幂等（`CREATE ... IF NOT EXISTS`），迁移必须能重复执行；
 * - 同一进程内 `openDb()` 只跑一次（单例保证）；
 * - 新增域时在 `DDL_ORDER` 与 `MIGRATION_STEPS` 中追加，不要依赖 import 顺序。
 */
import type { DatabaseSync } from "node:sqlite";
import { DDL as appsDdl, migratePublishedAppColumns } from "./apps.js";
import { DDL as caliberDdl } from "./caliber.js";
import { DDL as chatDdl, migrateMessagesTable, migrateSessionSourceColumns } from "./chat.js";
import { DDL as connectorsDdl } from "./connectors.js";
import { DDL as imDdl, migrateImChannelsTable } from "./im.js";
import { DDL as mcpGatewayDdl } from "./mcpGateway.js";
import { DDL as memoryDdl } from "./memory.js";
import { DDL as metricsDdl } from "./metrics.js";
import { DDL as providersDdl, migrateProvidersTable } from "./providers.js";
import { DDL as schemaDdl, migrateSchemaSourcesTable } from "./schemaSources.js";
import { DDL as usageDdl, migrateUsageColumns } from "./usage.js";
import { DDL as viewerDdl } from "./viewer.js";
import {
  DDL as workspaceDdl,
  ensureDefaultWorkspace,
  migrateWorkspaceColumns,
} from "./workspace.js";

/**
 * 建表顺序。表之间没有外键依赖，但保持稳定顺序能让新库与老库的
 * `sqlite_master` 一致，便于对比诊断。
 */
export const DDL_ORDER: ReadonlyArray<readonly [string, string]> = [
  ["chat", chatDdl],
  ["providers", providersDdl],
  ["im", imDdl],
  ["schema", schemaDdl],
  ["mcpGateway", mcpGatewayDdl],
  ["metrics", metricsDdl],
  ["caliber", caliberDdl],
  ["usage", usageDdl],
  ["workspace", workspaceDdl],
  ["apps", appsDdl],
  ["viewer", viewerDdl],
  ["connectors", connectorsDdl],
  ["memory", memoryDdl],
];

/**
 * 补列顺序。`migrateWorkspaceColumns` 必须先于 `migrateSessionSourceColumns`：
 * 老库可能连 `sessions.workspace_id` 都没有，先补归属再补来源列。
 */
export const MIGRATION_STEPS: ReadonlyArray<readonly [string, (database: DatabaseSync) => void]> = [
  ["chat.messages", migrateMessagesTable],
  ["providers.format", migrateProvidersTable],
  ["schema.sources", migrateSchemaSourcesTable],
  ["im.channels", migrateImChannelsTable],
  ["workspace.columns", migrateWorkspaceColumns],
  ["apps.columns", migratePublishedAppColumns],
  ["chat.sessionSource", migrateSessionSourceColumns],
  ["usage.columns", migrateUsageColumns],
  ["workspace.default", ensureDefaultWorkspace],
];

/** 建表 + 补列。调用方保证只在 `openDb()` 首次建库时执行。 */
export function applySchema(database: DatabaseSync): void {
  for (const [, ddl] of DDL_ORDER) {
    database.exec(ddl);
  }
  for (const [, step] of MIGRATION_STEPS) {
    step(database);
  }
}
