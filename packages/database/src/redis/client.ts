import { Cluster, Redis, type RedisOptions } from "ioredis";

/** 统一客户端句柄：兼容单机 Redis 与 Redis Cluster。 */
export interface RedisClient {
  client: Redis | Cluster;
  close: () => Promise<void>;
}

/** 提取可读的 Redis 错误描述（含 AggregateError 中的逐地址原因）。 */
export function describeRedisError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors
      .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把 ioredis 的 `error` 事件转成可读日志，避免连接失败时
 * 未监听的 `error` 事件直接抛出并导致进程崩溃。
 */
function attachErrorListener(client: Redis | Cluster): void {
  client.on("error", (error: Error) => {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      `[redis] connection error: ${code ? `${code}: ` : ""}${describeRedisError(error)}`,
    );
  });
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
  attachErrorListener(client);
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
  attachErrorListener(client);
  return {
    client,
    close: () => client.quit().then(() => undefined),
  };
}
