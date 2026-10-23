import type { ResourceCatalog } from "@open-agent-tools/api-contracts/resources";
export type {
  McpToolResource,
  McpServiceResource,
  RagSourceResource,
  ResourceCatalog,
} from "@open-agent-tools/api-contracts/resources";
import { studioFetch } from "../../lib/client.js";
export async function fetchResourceCatalog(): Promise<ResourceCatalog> {
  const response = await studioFetch("/api/resources");
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `资源目录请求失败（${response.status}）`);
  }
  return (await response.json()) as ResourceCatalog;
}
