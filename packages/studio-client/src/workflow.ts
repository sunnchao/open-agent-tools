import type {
  WorkflowApiKeyRecord,
  WorkflowAppRecord,
  WorkflowDetailRecord,
  WorkflowRunHistory,
  WorkflowRunRecord,
  WorkflowSnapshot,
} from "@open-agent-tools/workflow-contracts";

/** The transport resolves platform URLs, tokens and workspace settings on every request. */
export function createWorkflowClient<Snapshot = WorkflowSnapshot>(
  transport: (path: string, init?: RequestInit) => Promise<Response>,
) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await transport(path, init);
    // Keep the existing clients' empty/invalid JSON fallback, including successful responses.
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
  }
  const pathFor = (id: string) => `/api/workflows/${encodeURIComponent(id)}`;
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  async function workflow(
    path: string,
    init: RequestInit,
  ): Promise<WorkflowDetailRecord<Snapshot>> {
    return (await request<{ workflow: WorkflowDetailRecord<Snapshot> }>(path, init)).workflow;
  }
  async function remove(path: string): Promise<void> {
    const response = await transport(path, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
  }

  return {
    async fetchWorkflows(): Promise<WorkflowAppRecord[]> {
      return (await request<{ workflows: WorkflowAppRecord[] }>("/api/workflows")).workflows;
    },
    async fetchWorkflow(
      workflowId: string,
    ): Promise<{ workflow: WorkflowDetailRecord<Snapshot>; apiKeys: WorkflowApiKeyRecord[] }> {
      return request(pathFor(workflowId));
    },
    async createWorkflow(input: {
      name: string;
      description?: string;
      graph?: Snapshot;
    }): Promise<WorkflowDetailRecord<Snapshot>> {
      return workflow("/api/workflows", json("POST", input));
    },
    async duplicateWorkflow(workflowId: string): Promise<WorkflowDetailRecord<Snapshot>> {
      return workflow(`${pathFor(workflowId)}/duplicate`, { method: "POST" });
    },
    async deleteWorkflow(workflowId: string): Promise<void> {
      return remove(pathFor(workflowId));
    },
    async saveWorkflowDraft(
      workflowId: string,
      expectedRevision: number,
      graph: Snapshot,
    ): Promise<WorkflowDetailRecord<Snapshot>> {
      return workflow(`${pathFor(workflowId)}/draft`, json("PUT", { expectedRevision, graph }));
    },
    async publishWorkflow(
      workflowId: string,
      expectedRevision: number,
      releaseNotes = "",
    ): Promise<WorkflowDetailRecord<Snapshot>> {
      return workflow(
        `${pathFor(workflowId)}/publish`,
        json("POST", { expectedRevision, releaseNotes }),
      );
    },
    async rollbackWorkflow(
      workflowId: string,
      versionId: string,
    ): Promise<WorkflowDetailRecord<Snapshot>> {
      return workflow(`${pathFor(workflowId)}/rollback`, json("POST", { versionId }));
    },
    async createWorkflowKey(
      workflowId: string,
      input: { name: string; rateLimitPerMinute: number },
    ): Promise<{ key: WorkflowApiKeyRecord; rawKey: string }> {
      return request(`${pathFor(workflowId)}/api-keys`, json("POST", input));
    },
    async revokeWorkflowKey(workflowId: string, keyId: string): Promise<void> {
      return remove(`${pathFor(workflowId)}/api-keys/${encodeURIComponent(keyId)}`);
    },
    async fetchWorkflowRuns(
      workflowId: string,
      signal?: AbortSignal,
    ): Promise<WorkflowRunRecord[]> {
      return (
        await request<{ runs: WorkflowRunRecord[] }>(`${pathFor(workflowId)}/runs`, { signal })
      ).runs;
    },
    async fetchWorkflowRunEvents(
      workflowId: string,
      runId: string,
      signal?: AbortSignal,
    ): Promise<WorkflowRunHistory<Snapshot>> {
      return request(`${pathFor(workflowId)}/runs/${encodeURIComponent(runId)}/events`, { signal });
    },
  };
}
