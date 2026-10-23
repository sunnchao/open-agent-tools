import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createControlPlaneApp } from "../app.js";
import { AuditService } from "../audit.js";
import { InMemoryAuditRepository, type AuditEventRecord } from "../audit-repository.js";
import { McpManagementService, type Actor, type IdGenerator } from "../management.js";
import { InMemoryMcpManagementRepository } from "../repository.js";
import {
  classifyToolError,
  extractToolCall,
  normalizeErrorMessage,
  resolveSlaWindow,
  summarizeToolSla,
} from "./tool-sla.js";
import { ObservabilityService } from "./overview.js";

const FIXED_NOW = new Date("2026-07-31T12:00:00.000Z");

function sequentialIds(): IdGenerator {
  let value = 0;
  return () => `id-${++value}`;
}

function gatewayEvent(overrides: Partial<AuditEventRecord> = {}): AuditEventRecord {
  return {
    id: `event-${Math.random().toString(36).slice(2)}`,
    actorId: "client-1",
    actorRole: "client",
    source: "gateway",
    action: "MCP tools/call",
    target: "/mcp/services/search",
    requestId: "req-1",
    outcome: "SUCCEEDED",
    statusCode: 200,
    durationMs: 100,
    createdAt: "2026-07-31T11:59:00.000Z",
    input: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search", arguments: { query: "MCP" } },
    },
    output: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } },
    context: { serviceSlug: "search", serviceId: "service-1" },
    ...overrides,
  };
}

describe("SLA window validation", () => {
  it("defaults an omitted window to 24h and accepts 7d", () => {
    assert.equal(resolveSlaWindow(undefined), "24h");
    assert.equal(resolveSlaWindow(""), "24h");
    assert.equal(resolveSlaWindow("24h"), "24h");
    assert.equal(resolveSlaWindow("7d"), "7d");
  });

  it("rejects unknown windows with a validation error", () => {
    assert.throws(
      () => resolveSlaWindow("30d"),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === "VALIDATION_ERROR" &&
        /24h\|7d/.test(error.message),
    );
  });
});

describe("tool call extraction", () => {
  it("reads the service slug and tool name from a gateway tools/call event", () => {
    assert.deepEqual(extractToolCall(gatewayEvent()), {
      serviceSlug: "search",
      toolName: "search",
    });
  });

  it("falls back to the target URL when the context has no slug", () => {
    const event = gatewayEvent({
      context: null,
      target: "/mcp/services/report%20tools",
    });
    assert.deepEqual(extractToolCall(event), {
      serviceSlug: "report tools",
      toolName: "search",
    });
  });

  it("ignores control-plane events and non tool-call methods", () => {
    assert.equal(extractToolCall(gatewayEvent({ source: "control-plane" })), null);
    assert.equal(
      extractToolCall(gatewayEvent({ input: { jsonrpc: "2.0", id: 1, method: "tools/list" } })),
      null,
    );
  });
});

describe("error normalization", () => {
  it("collapses whitespace and strips high-cardinality identifiers", () => {
    assert.equal(
      normalizeErrorMessage(
        "Tool   execution failed\n(requestId: 4f2b1c9a-1111-2222-3333-444455556666) sha256:" +
          "a".repeat(64),
      ),
      "Tool execution failed (requestId: <id>) sha256:<digest>",
    );
  });

  it("redacts credentials that leaked into a message", () => {
    const normalized = normalizeErrorMessage(
      "upstream rejected Bearer mcp.abc.abcdefghijklmnopqrstuvwx and sk-live-1234567890",
    );
    assert.equal(normalized, "upstream rejected Bearer [REDACTED] and [REDACTED]");
  });

  it("classifies JSON-RPC, Tool isError and HTTP failures", () => {
    assert.deepEqual(
      classifyToolError(
        gatewayEvent({
          outcome: "FAILED",
          statusCode: 200,
          output: {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32_602, message: "Invalid Tool arguments" },
          },
        }),
      ),
      { code: "JSONRPC_-32602", message: "Invalid Tool arguments" },
    );
    assert.deepEqual(
      classifyToolError(
        gatewayEvent({
          outcome: "FAILED",
          statusCode: 200,
          output: {
            jsonrpc: "2.0",
            id: 1,
            result: { isError: true, content: [{ type: "text", text: "fetch failed" }] },
          },
        }),
      ),
      { code: "TOOL_ERROR", message: "fetch failed" },
    );
    assert.deepEqual(
      classifyToolError(
        gatewayEvent({
          outcome: "FAILED",
          statusCode: 401,
          output: { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
        }),
      ),
      { code: "UNAUTHORIZED", message: "Unauthorized" },
    );
  });
});

describe("tool SLA aggregation", () => {
  it("counts successes, failures, success rate and latency percentiles per Tool", () => {
    const report = summarizeToolSla(
      [
        gatewayEvent({ id: "a", durationMs: 100 }),
        gatewayEvent({ id: "b", durationMs: 200 }),
        gatewayEvent({
          id: "c",
          durationMs: 300,
          outcome: "FAILED",
          output: { jsonrpc: "2.0", id: 1, error: { code: -32_000, message: "boom" } },
        }),
        gatewayEvent({
          id: "d",
          durationMs: 400,
          input: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "render", arguments: {} },
          },
        }),
      ],
      { now: FIXED_NOW, window: "24h" },
    );

    assert.equal(report.totals.calls, 4);
    assert.equal(report.totals.succeeded, 3);
    assert.equal(report.totals.failed, 1);
    assert.equal(report.totals.successRate, 0.75);
    assert.equal(report.windowMinutes, 1440);
    assert.equal(report.services.length, 1);
    const search = report.services[0]!;
    assert.equal(search.serviceSlug, "search");
    assert.equal(search.tools.length, 2);
    const searchTool = search.tools.find((tool) => tool.toolName === "search")!;
    assert.equal(searchTool.calls, 3);
    assert.equal(searchTool.succeeded, 2);
    assert.equal(searchTool.failed, 1);
    assert.equal(searchTool.successRate, 0.67);
    assert.equal(searchTool.p50DurationMs, 200);
    assert.ok(searchTool.p95DurationMs >= 290 && searchTool.p95DurationMs <= 300);
    assert.deepEqual(searchTool.errors, [{ code: "JSONRPC_-32000", message: "boom", count: 1 }]);
    assert.equal(searchTool.lastFailure?.code, "JSONRPC_-32000");
  });

  it("aggregates normalized error buckets and keeps the most recent failure", () => {
    const report = summarizeToolSla(
      [
        gatewayEvent({
          id: "fail-1",
          outcome: "FAILED",
          createdAt: "2026-07-31T11:00:00.000Z",
          output: {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32_000, message: "Tool execution failed (requestId: aaaa1111)" },
          },
        }),
        gatewayEvent({
          id: "fail-2",
          outcome: "FAILED",
          createdAt: "2026-07-31T11:30:00.000Z",
          output: {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32_000, message: "Tool execution failed (requestId: bbbb2222)" },
          },
        }),
      ],
      { now: FIXED_NOW, window: "24h" },
    );

    const tool = report.services[0]!.tools[0]!;
    assert.deepEqual(tool.errors, [
      { code: "JSONRPC_-32000", message: "Tool execution failed (requestId: <id>)", count: 2 },
    ]);
    assert.equal(tool.lastFailure?.createdAt, "2026-07-31T11:30:00.000Z");
  });

  it("never echoes request arguments and drops events outside the window", () => {
    const stale = gatewayEvent({
      id: "stale",
      outcome: "FAILED",
      createdAt: "2026-07-01T00:00:00.000Z",
      input: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { apiKey: "[REDACTED]", query: "secret" } },
      },
    });
    const report = summarizeToolSla([gatewayEvent({ id: "fresh" }), stale], {
      now: FIXED_NOW,
      window: "24h",
    });
    assert.equal(report.totals.calls, 1);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("apiKey"), false);
  });

  it("filters by service slug and reports an empty structure without data", () => {
    const report = summarizeToolSla([gatewayEvent()], {
      now: FIXED_NOW,
      window: "24h",
      serviceSlug: "missing",
    });
    assert.deepEqual(report.services, []);
    assert.deepEqual(report.totals, {
      calls: 0,
      succeeded: 0,
      failed: 0,
      successRate: 0,
      p95DurationMs: 0,
    });
    assert.equal(report.serviceSlug, "missing");
  });

  it("flags truncated scans when the event count reaches the limit", () => {
    const report = summarizeToolSla([gatewayEvent({ id: "a" })], {
      now: FIXED_NOW,
      window: "24h",
      scanLimit: 1,
    });
    assert.deepEqual(report.scan, { events: 1, limit: 1, truncated: true });
  });

  it("skips events that vanish between list and get instead of failing the panel", async () => {
    const management = new McpManagementService(new InMemoryMcpManagementRepository(), {
      createId: sequentialIds(),
    });
    const repository = new InMemoryAuditRepository();
    await repository.create(gatewayEvent({ id: "kept" }));
    repository.list = async () => [
      { ...gatewayEvent({ id: "kept" }) },
      { ...gatewayEvent({ id: "gone" }) },
    ];
    // 批量详情中缺失 gone，仍应聚合其余事件。
    const audit = new AuditService(repository);
    let batchReads = 0;
    const getMany = repository.getMany.bind(repository);
    repository.getMany = async (ids) => {
      batchReads++;
      return getMany(ids);
    };
    repository.get = async () => {
      throw new Error("must use batch reads");
    };
    const service = new ObservabilityService({ management, audit, now: () => FIXED_NOW });

    const report = await service.toolSla({ id: "admin-1", role: "admin" }, { window: "24h" });
    assert.equal(report.totals.calls, 1);
    assert.equal(report.services[0]?.tools[0]?.toolName, "search");
    assert.equal(batchReads, 1);
    await assert.rejects(
      audit.getMany(["kept"], { id: "operator", role: "operator" }),
      /require admin or auditor/,
    );
  });

  it("falls back to individual readable events after a batch failure", async () => {
    const repository = new InMemoryAuditRepository();
    await repository.create(gatewayEvent({ id: "kept" }));
    repository.getMany = async () => {
      throw new Error("batch unavailable");
    };
    const audit = new AuditService(repository);
    const events = await audit.getMany(["gone", "kept"], { id: "auditor", role: "auditor" });
    assert.deepEqual(
      events.map((event) => event.id),
      ["kept"],
    );
  });
});

describe("tool SLA HTTP API", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let auditRepository: InMemoryAuditRepository;

  beforeEach(async () => {
    auditRepository = new InMemoryAuditRepository();
    await auditRepository.create(gatewayEvent({ id: "ok", durationMs: 120 }));
    await auditRepository.create(
      gatewayEvent({
        id: "bad",
        outcome: "FAILED",
        durationMs: 900,
        output: { jsonrpc: "2.0", id: 1, error: { code: -32_000, message: "execution failed" } },
      }),
    );
    const management = new McpManagementService(new InMemoryMcpManagementRepository(), {
      createId: sequentialIds(),
      now: () => FIXED_NOW.toISOString(),
    });
    const audit = new AuditService(auditRepository, {
      createId: sequentialIds(),
      now: () => FIXED_NOW.toISOString(),
    });
    const observability = new ObservabilityService({
      management,
      audit,
      now: () => FIXED_NOW,
    });
    const app = createControlPlaneApp({
      management,
      audit,
      observability,
      authenticate(request): Actor | null {
        const role = request.header("x-test-role");
        if (role !== "admin" && role !== "operator" && role !== "auditor") return null;
        return { id: `${role}-1`, role };
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await closeServer();
  });

  it("serves the per-tool SLA report to auditors", async () => {
    const response = await fetch(`${baseUrl}/api/admin/mcp/observability/tools?window=24h`, {
      headers: { "x-test-role": "auditor" },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      window: string;
      totals: { calls: number; failed: number; successRate: number };
      services: Array<{
        serviceSlug: string;
        tools: Array<{ toolName: string; errors: unknown[] }>;
      }>;
    };
    assert.equal(body.window, "24h");
    assert.equal(body.totals.calls, 2);
    assert.equal(body.totals.failed, 1);
    assert.equal(body.totals.successRate, 0.5);
    assert.equal(body.services[0]?.serviceSlug, "search");
    assert.equal(body.services[0]?.tools[0]?.toolName, "search");
    assert.equal(body.services[0]?.tools[0]?.errors.length, 1);
  });

  it("defaults the window and returns an empty structure without data", async () => {
    const empty = new ObservabilityService({
      management: new McpManagementService(new InMemoryMcpManagementRepository(), {
        createId: sequentialIds(),
      }),
      audit: new AuditService(new InMemoryAuditRepository(), { createId: sequentialIds() }),
      now: () => FIXED_NOW,
    });
    const app = createControlPlaneApp({
      management: new McpManagementService(new InMemoryMcpManagementRepository(), {
        createId: sequentialIds(),
      }),
      observability: empty,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/admin/mcp/observability/tools`,
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { window: string; services: unknown[] };
      assert.equal(body.window, "24h");
      assert.deepEqual(body.services, []);
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects an invalid window with 400", async () => {
    const response = await fetch(`${baseUrl}/api/admin/mcp/observability/tools?window=30d`, {
      headers: { "x-test-role": "auditor" },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "VALIDATION_ERROR");
  });

  it("rejects operators with 403", async () => {
    const response = await fetch(`${baseUrl}/api/admin/mcp/observability/tools`, {
      headers: { "x-test-role": "operator" },
    });
    assert.equal(response.status, 403);
  });
});
