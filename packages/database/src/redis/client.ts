import { Cluster, Redis, type RedisOptions } from "ioredis";

/** 统一客户端句柄：兼容单机 Redis 与 Redis Cluster。 */
export interface RedisClient {
  client: Redis | Cluster;
  close: () => Promise<void>;
}

/**
 * 从连接串创建 ioredis 客户端。
 *
 * 连接串支持 `redis://`、`rediss://`（TLS）。第二个参数可传任意 `RedisOptions`，
 * `host` / `port` / `password` 等会被连接串中的值覆盖。
 */
export function createRedisClient(
  connectionString: string,
  options: RedisOptions = {},
): RedisClient {
  const client = new Redis(connectionString, options);
  return {
    client,
    close: () => client.quit().then(() => undefined),
  };
}

/** 便捷：从分片配置创建 ioredis 集群客户端。 */
export function createRedisClusterClient(
  nodes: Array<{ host: string; port: number }>,
  options: RedisOptions = {},
): RedisClient {
  const client = new Cluster(nodes, options);
  return {
    client,
    close: () => client.quit().then(() => undefined),
  };
}
