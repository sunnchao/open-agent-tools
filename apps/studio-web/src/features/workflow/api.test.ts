import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflow, fetchWorkflows, saveWorkflowDraft } from "./api.js";
import type { WorkflowSnapshot } from "./types.js";

const snapshot: WorkflowSnapshot = { name: "Test", nodes: [], edges: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workflow management API client", () => {
  it("lists workflows and creates a server-backed draft", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflows: [
              {
                id: "wf-1",
                name: "Test",
                slug: "test",
                description: "",
                status: "ACTIVE",
                draftRevision: 1,
                currentVersionId: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflow: {
              app: { id: "wf-2", name: "New", draftRevision: 1 },
              draft: snapshot,
              versions: [],
            },
          }),
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchWorkflows())[0]?.slug).toBe("test");
    expect((await createWorkflow({ name: "New" })).app.id).toBe("wf-2");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workflows",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends optimistic draft revisions and surfaces conflicts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflow: {
              app: { id: "wf-1", draftRevision: 3 },
              draft: snapshot,
              versions: [],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "workflow draft changed" }), { status: 409 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect((await saveWorkflowDraft("wf-1", 2, snapshot)).app.draftRevision).toBe(3);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ expectedRevision: 2 });
    await expect(saveWorkflowDraft("wf-1", 2, snapshot)).rejects.toThrow("workflow draft changed");
  });
});
