export {
  createRedisClient,
  createRedisClusterClient,
  describeRedisError,
  type RedisClient,
} from "./client.js";
/** 底层 ioredis 类型透传：业务层无需直接依赖 `ioredis` 包即可使用 Redis / Cluster。 */
export type { Redis, Cluster, RedisOptions } from "ioredis";
