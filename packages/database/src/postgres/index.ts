export {
  createPostgresConnection,
  type PostgresConnection,
} from "./connection.js";
export {
  createPostgresDatabase,
  type PgSchema,
} from "./database.js";
export {
  createPostgresPool,
  type PostgresPool,
} from "./pool.js";
export {
  isPostgresError,
  isUniqueViolation,
} from "./errors.js";
/** 底层 pg 类型透传：业务层无需直接依赖 `pg` 包即可使用 Pool / PoolClient。 */
export type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";
