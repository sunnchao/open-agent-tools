import { studioFetch } from "../../lib/client.js";

export interface PublishedAppResources {
  rag?: { sources?: string[]; topK?: number };
  mcpTools?: Array<{ serviceSlug: string; toolName: string }>;
  sqlSources?: string[];
}

export interface PublishedAppRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  welcome: string;
  suggestions: Array<{ title: string; prompt: string }>;
  resources: PublishedAppResources;
  allowedGroups: string[];
  providerId: string | null;
  model: string | null;
  status: "ACTIVE" | "ARCHIVED";
  accessMode: "public" | "token";
  accessTokenHint: string | null;
  rateLimitPerMinute: number;
  dailyTokenBudget: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedAppIdentity {
  enabled: boolean;
  keyId: string | null;
  issuer: string;
  audience: string;
  identityMode: "optional" | "required" | "required_for_groups";
  assertionHeader: "X-Viewer-Assertion";
}

async function parseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${response.status}`;
}

export async function fetchPublishedApps(): Promise<PublishedAppRecord[]> {
  const response = await studioFetch("/api/admin/published-apps");
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { apps: PublishedAppRecord[] }).apps;
}

export async function fetchPublishedAppIdentity(): Promise<PublishedAppIdentity> {
  const response = await studioFetch("/api/admin/published-apps/identity");
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { identity: PublishedAppIdentity }).identity;
}

export async function createPublishedApp(input: {
  name: string;
  slug?: string;
  description?: string;
  welcome?: string;
  suggestions?: Array<{ title: string; prompt: string }>;
  resources?: PublishedAppResources;
  allowedGroups?: string[];
}): Promise<PublishedAppRecord> {
  const response = await studioFetch("/api/admin/published-apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { app: PublishedAppRecord }).app;
}

export async function updatePublishedApp(
  id: string,
  patch: Partial<
    Pick<
      PublishedAppRecord,
      | "name"
      | "description"
      | "welcome"
      | "status"
      | "resources"
      | "allowedGroups"
      | "accessMode"
      | "rateLimitPerMinute"
      | "dailyTokenBudget"
    >
  >,
): Promise<PublishedAppRecord> {
  const response = await studioFetch(`/api/admin/published-apps/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { app: PublishedAppRecord }).app;
}

/**
 * 生成或撤销访问口令。
 * 明文口令只在这一次返回，之后只能重新生成。
 */
export async function rotateAccessToken(
  id: string,
  enable: boolean,
): Promise<{ app: PublishedAppRecord; token: string | null }> {
  const response = await studioFetch(
    `/api/admin/published-apps/${encodeURIComponent(id)}/access-token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enable }),
    },
  );
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as { app: PublishedAppRecord; token: string | null };
}

export async function deletePublishedApp(id: string): Promise<void> {
  const response = await studioFetch(`/api/admin/published-apps/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) throw new Error(await parseError(response));
}

/** 员工入口链接（相对当前站点）。口令模式下附带 access_token。 */
export function employeeEntryPath(slug: string, accessToken?: string | null): string {
  const base = `#/app/${slug}`;
  return accessToken ? `${base}?access_token=${encodeURIComponent(accessToken)}` : base;
}
