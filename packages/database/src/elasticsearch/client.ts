import { Client, type ClientOptions } from "@elastic/elasticsearch";

export interface ElasticsearchClient {
  client: Client;
  close: () => Promise<void>;
}

/**
 * 从连接串创建 Elasticsearch 官方客户端。
 *
 * 支持 `http://` / `https://`。第二个参数可传任意 `ClientOptions`
 * （auth、tls、requestTimeout ...）。
 */
export function createElasticsearchClient(
  node: string,
  options: Omit<ClientOptions, "node"> = {},
): ElasticsearchClient {
  const client = new Client({ node, ...options });
  return {
    client,
    close: () => client.close(),
  };
}

/** 便捷：从节点列表创建 ES 客户端（多节点负载均衡）。 */
export function createElasticsearchClusterClient(
  nodes: string[],
  options: Omit<ClientOptions, "nodes"> = {},
): ElasticsearchClient {
  const client = new Client({ nodes, ...options });
  return {
    client,
    close: () => client.close(),
  };
}
