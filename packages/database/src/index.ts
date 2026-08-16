/**
 * @open-agent-tools/database
 *
 * 统一数据库访问层：为 PostgreSQL / MySQL / Redis / Elasticsearch 提供
 * 一致的连接创建、关闭与错误判定的门面 API。
 *
 * 各数据库按子路径导出，避免未使用的驱动被加载：
 *   import { createPostgresConnection } from "@open-agent-tools/database/postgres";
 *   import { createRedisClient } from "@open-agent-tools/database/redis";
 */
export * from "./postgres/index.js";
export * from "./mysql/index.js";
export * from "./redis/index.js";
export * from "./elasticsearch/index.js";
