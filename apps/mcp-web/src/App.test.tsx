import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import type {
  ApiClientRecord,
  AuditEventRecord,
  BuildJobSummary,
  McpAdminApi,
  McpService,
  McpVersion,
} from "./api.js";

const service: McpService = {
  id: "service-1",
  name: "Reporting MCP",
  slug: "reporting",
  type: "MANAGED_MCP",
  status: "DRAFT",
  currentVersionId: null,
  revision: 1,
};

function version(tools = true): McpVersion {
  return {
    id: "version-1",
    serviceId: service.id,
    versionNumber: 1,
    status: "DRAFT",
    runtime: tools ? { name: "nodejs", version: "20" } : null,
    entry: tools ? "src/index.js" : null,
    buildCommand: null,
    limits: tools ? { timeoutMs: 30_000, memoryMb: 256, cpuMillis: 1_000, network: "none" } : null,
    artifactDigest: tools ? `sha256:${"a".repeat(64)}` : null,
    artifactObjectKey: tools ? "artifact.zip" : null,
    artifactSize: tools ? 1024 : null,
    imageDigest: null,
    tools: tools
      ? [
          {
            id: "tool-1",
            name: "get_report",
            handler: "getReport",
            inputSchema: { type: "object" },
          },
        ]
      : [],
    prompts: [
      {
        id: "prompt-1",
        name: "summarize_report",
        arguments: [],
        messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
      },
    ],
    revision: 3,
  };
}

function fakeApi(draft: McpVersion): McpAdminApi {
  return {
    listServices: async () => [service],
    getService: async () => service,
    listVersions: async () => [draft],
    createService: async () => ({ service, draftVersion: draft }),
    updateService: async () => service,
    disableService: async () => service,
    enableService: async () => service,
    deleteService: async () => undefined,
    addTool: async () => draft,
    updateTool: async () => draft,
    deleteTool: async () => undefined,
    addPrompt: async () => draft,
    updatePrompt: async () => draft,
    deletePrompt: async () => undefined,
    previewPrompt: async () => ({ messages: [] }),
    uploadArtifact: async () => ({ version: draft, job: { id: "job-1" } }),
    buildVersion: async () => ({ version: draft, job: { id: "job-2" } }),
    validateVersion: async () => draft,
    resetVersionToDraft: async () => draft,
    forkDraftVersion: async () => draft,
    publishVersion: async () => ({ service, version: draft }),
    rollbackVersion: async () => ({ service, version: draft }),
    listBuilds: async () => [],
    listClients: async () => [],
    createClient: async () => ({
      id: "client-1",
      name: "Client",
      status: "ACTIVE",
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }),
    listApiKeys: async () => [],
    createApiKey: async () => ({
      key: {
        id: "key-1",
        clientId: "client-1",
        status: "ACTIVE",
        expiresAt: null,
        lastUsedAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      rawKey: "mcp.example",
    }),
    revokeApiKey: async () => undefined,
    listGrants: async () => [],
    upsertGrant: async (clientId, serviceId, input) => ({
      id: "grant-1",
      clientId,
      serviceId,
      ...input,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }),
    deleteGrant: async () => undefined,
    listAuditEvents: async () => [],
  };
}

describe("MCP management console", () => {
  it("WEB-001 shows registry navigation and role-appropriate actions", async () => {
    const { rerender } = render(<App api={fakeApi(version())} role="operator" />);
    expect(await screen.findByText("Reporting MCP")).toBeInTheDocument();
    expect(screen.getByText("MCP Registry")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new service/i })).toBeInTheDocument();

    rerender(<App api={fakeApi(version())} role="auditor" />);
    expect(screen.queryByRole("button", { name: /new service/i })).not.toBeInTheDocument();
  });

  it("navigates between every primary sidebar view", async () => {
    render(<App api={fakeApi(version())} />);
    expect(await screen.findByText("Reporting MCP")).toBeInTheDocument();

    for (const view of ["Builds", "Clients", "Audit"]) {
      const navigationItem = screen.getByRole("button", { name: view });
      await userEvent.click(navigationItem);
      expect(navigationItem).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("heading", { level: 1, name: view })).toBeInTheDocument();
    }

    const servicesItem = screen.getByRole("button", { name: "Services" });
    await userEvent.click(servicesItem);
    expect(servicesItem).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "Reporting MCP" })).toBeInTheDocument();
  });

  it("shows and filters persisted build jobs", async () => {
    const build: BuildJobSummary = {
      id: "build-1",
      serviceId: service.id,
      serviceName: service.name,
      versionId: "version-1",
      versionNumber: 1,
      kind: "BUILD",
      status: "SUCCEEDED",
      stage: "PACKAGE_BUILD",
      errorCode: null,
      attempt: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      startedAt: "2026-08-01T00:00:01.000Z",
      finishedAt: "2026-08-01T00:00:02.000Z",
      updatedAt: "2026-08-01T00:00:02.000Z",
    };
    const api: McpAdminApi = { ...fakeApi(version()), listBuilds: async () => [build] };

    render(<App api={api} />);
    await userEvent.click(screen.getByRole("button", { name: "Builds" }));

    expect(await screen.findByText("PACKAGE_BUILD")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "FAILED");
    expect(screen.queryByText("PACKAGE_BUILD")).not.toBeInTheDocument();
    expect(screen.getByText("No build records")).toBeInTheDocument();
  });

  it("creates a Client and exposes a newly issued API Key once", async () => {
    const existingClient: ApiClientRecord = {
      id: "client-1",
      name: "Existing client",
      status: "ACTIVE",
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const newClient = { ...existingClient, id: "client-2", name: "Analytics client" };
    const createClient = vi.fn(async () => newClient);
    const createApiKey = vi.fn(async () => ({
      key: {
        id: "key-1",
        clientId: newClient.id,
        status: "ACTIVE" as const,
        expiresAt: null,
        lastUsedAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      rawKey: "mcp.one-time-secret",
    }));
    const api: McpAdminApi = {
      ...fakeApi(version()),
      listClients: async () => [existingClient],
      createClient,
      createApiKey,
    };

    render(<App api={api} />);
    await userEvent.click(screen.getByRole("button", { name: "Clients" }));
    await userEvent.click(await screen.findByRole("button", { name: "New client" }));
    const clientDialog = screen.getByRole("dialog", { name: "New API client" });
    await userEvent.type(within(clientDialog).getByLabelText("Client name"), "Analytics client");
    await userEvent.click(within(clientDialog).getByRole("button", { name: "Create client" }));

    expect(createClient).toHaveBeenCalledWith("Analytics client");
    await userEvent.click(await screen.findByRole("button", { name: "Issue key" }));
    const keyDialog = screen.getByRole("dialog", { name: "Issue API Key" });
    await userEvent.click(within(keyDialog).getByRole("button", { name: "Issue API Key" }));

    expect(createApiKey).toHaveBeenCalledWith(newClient.id, null);
    expect(await screen.findByText("mcp.one-time-secret")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("mcp.one-time-secret")).not.toBeInTheDocument();
  });

  it("configures an API Key grant with an explicit A/B Tool whitelist", async () => {
    const client: ApiClientRecord = {
      id: "client-1",
      name: "Tool consumer",
      status: "ACTIVE",
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const draft = version();
    draft.tools = ["tool_a", "tool_b", "tool_c"].map((name, index) => ({
      id: `tool-${index + 1}`,
      name,
      handler: name,
      inputSchema: { type: "object" },
    }));
    const upsertGrant = vi.fn(async (clientId, serviceId, input) => ({
      id: "grant-1",
      clientId,
      serviceId,
      ...input,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }));
    const api: McpAdminApi = {
      ...fakeApi(draft),
      listClients: async () => [client],
      upsertGrant,
    };

    render(<App api={api} />);
    await userEvent.click(screen.getByRole("button", { name: "Clients" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add grant" }));
    const dialog = screen.getByRole("dialog", { name: "Add service grant" });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "List Tools" }));
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "tool_a" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "tool_b" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save grant" }));

    await waitFor(() =>
      expect(upsertGrant).toHaveBeenCalledWith(client.id, service.id, {
        scopes: ["mcp:connect", "tools:list"],
        toolNames: ["tool_a", "tool_b"],
        promptNames: [],
      }),
    );
  });

  it("shows audit records and submits outcome and action filters", async () => {
    const event: AuditEventRecord = {
      id: "audit-1",
      actorId: "anonymous-admin",
      actorRole: "admin",
      action: "POST /api/admin/mcp/services",
      target: "/api/admin/mcp/services",
      requestId: "request-1",
      outcome: "SUCCEEDED",
      statusCode: 201,
      durationMs: 8,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const listAuditEvents = vi.fn(async () => [event]);
    const api: McpAdminApi = { ...fakeApi(version()), listAuditEvents };

    render(<App api={api} />);
    await userEvent.click(screen.getByRole("button", { name: "Audit" }));
    expect(await screen.findByText("POST /api/admin/mcp/services")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Outcome"), "FAILED");
    await waitFor(() => expect(listAuditEvents).toHaveBeenCalledWith({ outcome: "FAILED" }));
    await userEvent.type(screen.getByLabelText("Action"), "services{enter}");
    await waitFor(() =>
      expect(listAuditEvents).toHaveBeenCalledWith({ outcome: "FAILED", action: "services" }),
    );
  });

  it("validates and normalizes service fields before creating a service", async () => {
    const draft = version();
    const createdService = { ...service, id: "service-2", name: "Demo", slug: "demo" };
    const createService = vi.fn(async () => ({ service: createdService, draftVersion: draft }));
    const api: McpAdminApi = { ...fakeApi(draft), createService };

    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "New service" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Service name" }), "  Demo  ");
    await userEvent.type(screen.getByRole("textbox", { name: "Slug" }), "demo-");
    await userEvent.click(screen.getByRole("button", { name: "Save service" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("end with a letter or number");
    expect(createService).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByRole("textbox", { name: "Slug" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Slug" }), "demo");
    await userEvent.click(screen.getByRole("button", { name: "Save service" }));

    expect(await screen.findByText("Service created")).toBeInTheDocument();
    expect(createService).toHaveBeenCalledWith({ name: "Demo", slug: "demo" });
  });

  it("validates and normalizes a Prompt before submission", async () => {
    const draft = version(false);
    const addPrompt = vi.fn(async () => draft);
    const api: McpAdminApi = { ...fakeApi(draft), addPrompt };

    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Add Prompt" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt name" }), "  summarize  ");
    await userEvent.click(screen.getByRole("button", { name: "Save Prompt" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("message text cannot be empty");
    expect(addPrompt).not.toHaveBeenCalled();

    const messages = [{ role: "user" as const, content: { type: "text" as const, text: "Go" } }];
    fireEvent.change(screen.getByRole("textbox", { name: "Messages" }), {
      target: { value: JSON.stringify(messages) },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save Prompt" }));

    expect(await screen.findByText("Prompt added")).toBeInTheDocument();
    expect(addPrompt).toHaveBeenCalledWith(service.id, draft.id, draft.revision, {
      name: "summarize",
      arguments: [],
      messages,
    });
  });

  it("WEB-004 and WEB-005 exposes editable Tools and Prompts in one draft", async () => {
    render(<App api={fakeApi(version())} role="operator" />);
    expect(await screen.findByText("get_report")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /prompts/i }));
    expect(screen.getByText("summarize_report")).toBeInTheDocument();
  });

  it("WEB-002 and WEB-008 hides package/build controls for Prompt-only drafts", async () => {
    const { unmount } = render(<App api={fakeApi(version(false))} role="operator" />);
    expect(await screen.findByText("summarize_report")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upload package/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /build version/i })).not.toBeInTheDocument();
    unmount();

    render(<App api={fakeApi(version(true))} role="operator" />);
    expect(await screen.findByRole("button", { name: /upload package/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /build version/i })).toBeInTheDocument();
  });

  it("allows package upload and build retry for a failed Tool version", async () => {
    const failed = { ...version(), status: "FAILED" as const };
    const buildVersion = vi.fn(async () => ({
      version: { ...failed, status: "BUILDING" as const, revision: failed.revision + 1 },
      job: { id: "job-retry" },
    }));
    const api: McpAdminApi = { ...fakeApi(failed), buildVersion };

    render(<App api={api} role="operator" />);

    const upload = await screen.findByRole("button", { name: /upload package/i });
    const build = screen.getByRole("button", { name: /build version/i });
    expect(upload).toBeEnabled();
    expect(build).toBeEnabled();

    await userEvent.click(build);
    await waitFor(() =>
      expect(buildVersion).toHaveBeenCalledWith(service.id, failed.id, failed.revision),
    );
  });

  it("WEB-007 keeps upload clickable again after a package upload enters validation", async () => {
    const draft = version();
    const validating = { ...draft, status: "VALIDATING" as const, revision: draft.revision + 1 };
    const uploadArtifact = vi.fn(async () => ({
      version: validating,
      job: { id: "job-reupload" },
    }));
    const api: McpAdminApi = { ...fakeApi(draft), uploadArtifact };

    render(<App api={api} role="operator" />);
    const upload = await screen.findByRole("button", { name: /upload package/i });
    expect(upload).toBeEnabled();

    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(
      fileInput!,
      new File([new Uint8Array([1, 2, 3])], "tool.zip", { type: "application/zip" }),
    );

    await waitFor(() => expect(uploadArtifact).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Inspecting")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /upload package/i })).toBeEnabled(),
    );
  });

  it("WEB-006 collects declared Prompt arguments before rendering a preview", async () => {
    const draft = version(false);
    draft.prompts[0] = {
      ...draft.prompts[0]!,
      arguments: [{ name: "reportId", description: "Report identifier", required: true }],
      messages: [{ role: "user", content: { type: "text", text: "Summarize {{reportId}}." } }],
    };
    let receivedArguments: Record<string, string> | undefined;
    const api: McpAdminApi = {
      ...fakeApi(draft),
      previewPrompt: async (_serviceId, _versionId, _promptId, argumentsByName) => {
        receivedArguments = argumentsByName;
        return {
          messages: [{ role: "user", content: { type: "text", text: "Summarize report-1." } }],
        };
      },
    };

    render(<App api={api} role="operator" />);
    expect(await screen.findByText("summarize_report")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await userEvent.type(screen.getByRole("textbox", { name: "reportId" }), "report-1");
    await userEvent.click(screen.getByRole("button", { name: "Render preview" }));

    expect(await screen.findByText("Summarize report-1.")).toBeInTheDocument();
    expect(receivedArguments).toEqual({ reportId: "report-1" });
  });

  it("WEB-009-A and WEB-010-A expose admin rollback and disable actions", async () => {
    const activeService: McpService = {
      ...service,
      status: "ACTIVE",
      currentVersionId: "version-2",
      revision: 4,
    };
    const currentVersion: McpVersion = { ...version(false), id: "version-2", status: "PUBLISHED" };
    const rollbackVersion: McpVersion = {
      ...version(false),
      id: "version-1",
      status: "SUPERSEDED",
      versionNumber: 1,
      revision: 5,
    };
    let disableRevision: number | undefined;
    let rollbackTarget: { versionId: string; revision: number } | undefined;
    const api = {
      ...fakeApi(currentVersion),
      listServices: async () => [activeService],
      getService: async () => activeService,
      listVersions: async () => [rollbackVersion, currentVersion],
      disableService: async (_serviceId: string, revision: number) => {
        disableRevision = revision;
        return { ...activeService, status: "DISABLED" as const, revision: revision + 1 };
      },
      rollbackVersion: async (_serviceId: string, versionId: string, revision: number) => {
        rollbackTarget = { versionId, revision };
        return {
          service: activeService,
          version: { ...rollbackVersion, status: "PUBLISHED" as const },
        };
      },
    } as unknown as McpAdminApi;
    vi.stubGlobal("confirm", () => true);

    const { unmount } = render(<App api={api} role="admin" />);
    expect(await screen.findByRole("button", { name: "Disable service" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Roll back version" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Disable service" }));
    expect(disableRevision).toBe(activeService.revision);
    unmount();

    render(<App api={api} role="admin" />);
    expect(await screen.findByText("Reporting MCP")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("tab", { name: "Versions" }));
    const rollbackRow = screen.getByRole("button", { name: /v1 Superseded/ });
    await userEvent.click(rollbackRow);
    expect(await screen.findByRole("button", { name: "Roll back version" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Roll back version" }));
    expect(rollbackTarget).toEqual({
      versionId: rollbackVersion.id,
      revision: rollbackVersion.revision,
    });
  });

  it("re-enables a disabled service and updates the registry row", async () => {
    const disabledService: McpService = {
      ...service,
      status: "DISABLED",
      revision: 4,
    };
    let enableRevision: number | undefined;
    const api = {
      ...fakeApi(version(false)),
      listServices: async () => [disabledService],
      getService: async () => disabledService,
      enableService: async (_serviceId: string, revision: number) => {
        enableRevision = revision;
        return { ...disabledService, status: "ACTIVE" as const, revision: revision + 1 };
      },
    } as unknown as McpAdminApi;
    vi.stubGlobal("confirm", () => true);

    const { unmount } = render(<App api={api} role="admin" />);
    expect(await screen.findByRole("button", { name: "Enable service" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable service" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Enable service" }));
    expect(enableRevision).toBe(disabledService.revision);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Enable service" })).not.toBeInTheDocument(),
    );
    unmount();

    const activeApi = {
      ...fakeApi(version(false)),
      listServices: async () => [{ ...disabledService, status: "ACTIVE" as const }],
      getService: async () => ({ ...disabledService, status: "ACTIVE" as const }),
    } as unknown as McpAdminApi;
    render(<App api={activeApi} role="admin" />);
    expect(await screen.findByRole("button", { name: "Disable service" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable service" })).not.toBeInTheDocument();
  });

  it("resets a READY version back to draft and restores package actions", async () => {
    const ready = { ...version(), status: "READY" as const, imageDigest: `sha256:${"b".repeat(64)}` };
    let resetTarget: { versionId: string; revision: number } | undefined;
    const api = {
      ...fakeApi(ready),
      resetVersionToDraft: async (_serviceId: string, versionId: string, revision: number) => {
        resetTarget = { versionId, revision };
        return { ...ready, status: "DRAFT" as const, imageDigest: null, revision: revision + 1 };
      },
    } as unknown as McpAdminApi;
    vi.stubGlobal("confirm", () => true);

    render(<App api={api} role="admin" />);
    expect(await screen.findByRole("button", { name: "Reset to draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload package" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Reset to draft" }));
    expect(resetTarget).toEqual({ versionId: ready.id, revision: ready.revision });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Reset to draft" })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload package" })).toBeEnabled(),
    );
  });

  it("forks a new draft from a published version and selects it", async () => {
    const published = {
      ...version(),
      status: "PUBLISHED" as const,
      imageDigest: `sha256:${"c".repeat(64)}`,
    };
    const fork = {
      ...version(),
      id: "version-2",
      versionNumber: 2,
      status: "DRAFT" as const,
      imageDigest: null,
      revision: 1,
    };
    let forkTarget: string | undefined;
    const api = {
      ...fakeApi(published),
      forkDraftVersion: async (_serviceId: string, versionId: string) => {
        forkTarget = versionId;
        return fork;
      },
    } as unknown as McpAdminApi;
    vi.stubGlobal("confirm", () => true);

    render(<App api={api} role="admin" />);
    expect(await screen.findByRole("button", { name: "Fork new draft" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset to draft" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fork new draft" }));
    expect(forkTarget).toBe(published.id);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Fork new draft" })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload package" })).toBeEnabled(),
    );
  });
});
