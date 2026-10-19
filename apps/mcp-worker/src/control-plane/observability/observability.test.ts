import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createControlPlaneApp } from "../app.js";
import { AuditService } from "../audit.js";
import { InMemoryAuditRepository, type AuditEventSummary } from "../audit-repository.js";
import { McpManagementService, type Actor, type IdGenerator } from "../management.js";
import { InMemoryMcpManagementRepository } from "../repository.js";
import type { BuildJobSummary } from "../types.js";
import {
  EMPTY_QUEUE_SNAPSHOT,
  buildQueueSnapshot,
  normalizeQueueCounts,
  QueueMonitor,
} from "./queue-monitor.js";
import { evaluateAlerts, createAlertLoop, DEFAULT_ALERT_THRESHOLDS } from "./alerts.js";
import { percentile, summarizeAuditEvents } from "./audit-stats.js";
import { ObservabilityService, summarizeBuildJobs } from "./overview.js";

const FIXED_NOW = new Date("2026-07-31T12:00:00.000Z");

function sequentialIds(): IdGenerator {
  let value = 0;
  return () => `id-${++value}`;
}

function auditEvent(overrides: Partial<AuditEventSummary>): AuditEventSummary {
  return {
    id: "event-1",
    actorId: "admin-1",
    actorRole: "admin",
    source: "control-plane",
    action: "POST /api/admin/mcp/services",
    target: "/api/admin/mcp/services",
    requestId: "req-1",
    outcome: "SUCCEEDED",
    statusCode: 200,
    durationMs: 100,
    createdAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
}

describe("queue monitor", () => {
  it("treats an empty queue as idle", () => {
    const snapshot = buildQueueSnapshot({});
    assert.deepEqual(snapshot, EMPTY_QUEUE_SNAPSHOT);
  });

  it("ignores negative and non-numeric counts", () => {
    assert.deepEqual(normalizeQueueCounts({ waiting: -5, active: Number.NaN, failed: 3 }), {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 3,
      delayed: 0,
      paused: 0,
    });
  });

  it("labels busy, backlogged and stalled queues by backlog size", () => {
    assert.equal(buildQueueSnapshot({ waiting: 1 }).health, "busy");
    assert.equal(buildQueueSnapshot({ waiting: 20 }).health, "backlogged");
    assert.equal(buildQueueSnapshot({ waiting: 110, delayed: 5 }).health, "stalled");
    const backlogged = buildQueueSnapshot({ waiting: 10, delayed: 5, paused: 6 });
    assert.equal(backlogged.backlog, 21);
    assert.equal(backlogged.total, 21);
    assert.equal(backlogged.health, "backlogged");
  });

  it("reads normalized counts through a provider", async () => {
    const monitor = new QueueMonitor({ getJobCounts: async () => ({ waiting: "7" }) });
    const snapshot = await monitor.snapshot();
    assert.equal(snapshot.waiting, 7);
    assert.equal(snapshot.health, "busy");
  });
});

describe("audit stats", () => {
  it("computes linear-interpolated percentiles", () => {
    assert.equal(percentile([], 0.95), 0);
    assert.equal(percentile([10], 0.95), 10);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  });

  it("summarizes success rate, latency and failures within the window", () => {
    const inWindow = [
      auditEvent({ id: "a", durationMs: 100 }),
      auditEvent({ id: "b", durationMs: 200 }),
      auditEvent({ id: "c", durationMs: 2_500, outcome: "FAILED", statusCode: 500, createdAt: "2026-07-31T11:58:00.000Z" }),
      auditEvent({ id: "d", durationMs: 3_000, outcome: "FAILED", statusCode: 500, createdAt: "2026-07-31T11:59:00.000Z" }),
    ];
    const stale = auditEvent({
      id: "stale",
      createdAt: "2026-07-01T00:00:00.000Z",
      outcome: "FAILED",
      durationMs: 9_999,
    });

    const stats = summarizeAuditEvents([...inWindow, stale], {
      now: FIXED_NOW,
      windowMs: 60 * 60 * 1_000,
      topN: 2,
    });

    assert.equal(stats.total, 4);
    assert.equal(stats.failed, 2);
    assert.equal(stats.failureRate, 0.5);
    assert.equal(stats.windowMinutes, 60);
    assert.equal(stats.maxDurationMs, 3_000);
    assert.ok(stats.p95DurationMs >= 2_500);
    assert.equal(stats.topActions.length, 1);
    assert.equal(stats.topActions[0]?.failed, 2);
    assert.deepEqual(
      stats.recentFailures.map((event) => event.id),
      ["d", "c"],
    );
  });
});

describe("alerts", () => {
  it("flags queue backlog and failures", () => {
    const alerts = evaluateAlerts({
      queue: buildQueueSnapshot({ waiting: 30, failed: 12 }),
      audit: summarizeAuditEvents([], { now: FIXED_NOW }),
    });
    const ids = alerts.map((alert) => alert.id);
    assert.ok(ids.includes("queue.backlog"));
    assert.ok(ids.includes("queue.failed"));
    assert.equal(alerts.find((alert) => alert.id === "queue.failed")?.severity, "warning");
  });

  it("escalates severe backlog to critical", () => {
    const alerts = evaluateAlerts({
      queue: buildQueueSnapshot({ waiting: 150 }),
      audit: summarizeAuditEvents([], { now: FIXED_NOW }),
    });
    const backlog = alerts.find((alert) => alert.id === "queue.backlog");
    assert.equal(backlog?.severity, "critical");
    assert.equal(backlog?.threshold, DEFAULT_ALERT_THRESHOLDS.queueBacklogCritical);
  });

  it("skips disabled queue metrics", () => {
    const alerts = evaluateAlerts(
      { queue: EMPTY_QUEUE_SNAPSHOT, audit: summarizeAuditEvents([], { now: FIXED_NOW }) },
      DEFAULT_ALERT_THRESHOLDS,
      ["queue.backlog", "queue.failed"],
    );
    assert.deepEqual(alerts, []);
  });

  it("flags high audit failure rate", () => {
    const audit = summarizeAuditEvents(
      [
        auditEvent({ id: "a", outcome: "FAILED", statusCode: 500 }),
        auditEvent({ id: "b", outcome: "FAILED", statusCode: 500 }),
        auditEvent({ id: "c" }),
      ],
      { now: FIXED_NOW },
    );
    const alerts = evaluateAlerts({ queue: EMPTY_QUEUE_SNAPSHOT, audit });
    assert.equal(alerts.find((alert) => alert.id === "audit.failureRate")?.metric, "audit.failureRate");
  });
});

describe("build job stats", () => {
  function buildJob(status: BuildJobSummary["status"]): BuildJobSummary {
    return {
      id: `job-${status}-${Math.random()}`,
      versionId: "version-1",
      kind: "BUILD",
      status,
      stage: "QUEUED",
      artifactObjectKey: "service-1/version-1/artifact.zip",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      artifactSize: 1024,
      imageDigest: null,
      sbomObjectKey: null,
      errorCode: null,
      attempt: 1,
      createdAt: FIXED_NOW.toISOString(),
      startedAt: null,
      finishedAt: null,
      updatedAt: FIXED_NOW.toISOString(),
      serviceId: "service-1",
      serviceName: "Reports",
      versionNumber: 1,
    };
  }

  it("counts each build status", () => {
    const stats = summarizeBuildJobs([
      buildJob("QUEUED"),
      buildJob("QUEUED"),
      buildJob("RUNNING"),
      buildJob("SUCCEEDED"),
      buildJob("FAILED"),
    ]);
    assert.deepEqual(stats, { total: 5, queued: 2, running: 1, succeeded: 1, failed: 1 });
  });
});

describe("alert loop", () => {
  it("publishes collected alerts to sinks", async () => {
    const published: string[] = [];
    const loop = createAlertLoop({
      collect: async () => ({
        queue: buildQueueSnapshot({ waiting: 50 }),
        audit: summarizeAuditEvents([], { now: FIXED_NOW }),
      }),
      sinks: [{ publish: (alerts) => void published.push(...alerts.map((a) => a.id)) }],
    });
    const alerts = await loop.runOnce();
    assert.deepEqual(
      alerts.map((alert) => alert.id),
      ["queue.backlog"],
    );
    assert.deepEqual(published, ["queue.backlog"]);
  });

  it("reports collection errors without throwing", async () => {
    const errors: unknown[] = [];
    const loop = createAlertLoop({
      collect: async () => {
        throw new Error("boom");
      },
      onError: (error) => void errors.push(error),
    });
    assert.deepEqual(await loop.runOnce(), []);
    assert.equal(errors.length, 1);
  });
});

describe("observability overview", () => {
  function createServices(options: { withQueue: boolean }) {
    const management = new McpManagementService(new InMemoryMcpManagementRepository(), {
      createId: sequentialIds(),
      now: () => FIXED_NOW.toISOString(),
    });
    const auditRepository = new InMemoryAuditRepository();
    const audit = new AuditService(auditRepository, {
      createId: sequentialIds(),
      now: () => FIXED_NOW.toISOString(),
    });
    const queueMonitor = options.withQueue
      ? new QueueMonitor({ getJobCounts: async () => ({ waiting: 30, active: 2, failed: 12 }) })
      : undefined;
    const service = new ObservabilityService({
      management,
      audit,
      ...(queueMonitor ? { queueMonitor } : {}),
      now: () => FIXED_NOW,
    });
    return { management, audit, service };
  }

  it("returns a null queue and skips queue alerts without a monitor", async () => {
    const { service } = createServices({ withQueue: false });
    const overview = await service.overview({ id: "admin-1", role: "admin" });
    assert.equal(overview.queue, null);
    assert.deepEqual(overview.alerts, []);
    assert.equal(overview.builds.total, 0);
  });

  it("rejects operator access", async () => {
    const { service } = createServices({ withQueue: true });
    await assert.rejects(
      () => service.overview({ id: "operator-1", role: "operator" }),
      /FORBIDDEN|admin or auditor/,
    );
  });
});

describe("observability HTTP API", () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const management = new McpManagementService(new InMemoryMcpManagementRepository(), {
      createId: sequentialIds(),
      now: () => FIXED_NOW.toISOString(),
    });
    const audit = new AuditService(new InMemoryAuditRepository(), {
      createId: sequentialIds(),
      now: () => FIXED_NOW.toISOString(),
    });
    await audit.recordHttp({
      actor: { id: "admin-1", role: "admin" },
      method: "POST",
      route: "/api/admin/mcp/services",
      target: "/api/admin/mcp/services",
      statusCode: 500,
      durationMs: 2_600,
    });
    await audit.recordHttp({
      actor: { id: "admin-1", role: "admin" },
      method: "POST",
      route: "/api/admin/mcp/services",
      target: "/api/admin/mcp/services",
      statusCode: 500,
      durationMs: 2_800,
    });
    const observability = new ObservabilityService({
      management,
      audit,
      queueMonitor: new QueueMonitor({
        getJobCounts: async () => ({ waiting: 30, active: 2, failed: 12 }),
      }),
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

  it("serves the unified overview to auditors", async () => {
    const response = await fetch(`${baseUrl}/api/admin/mcp/observability/overview`, {
      headers: { "x-test-role": "auditor" },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      queue: { health: string; backlog: number } | null;
      audit: { failureRate: number; failed: number };
      builds: { total: number };
      alerts: Array<{ id: string }>;
    };
    assert.equal(body.queue?.health, "backlogged");
    assert.equal(body.queue?.backlog, 30);
    assert.equal(body.audit.failed, 2);
    assert.equal(body.audit.failureRate, 1);
    assert.ok(body.alerts.some((alert) => alert.id === "queue.backlog"));
    assert.ok(body.alerts.some((alert) => alert.id === "queue.failed"));
  });

  it("rejects operators with 403", async () => {
    const response = await fetch(`${baseUrl}/api/admin/mcp/observability/overview`, {
      headers: { "x-test-role": "operator" },
    });
    assert.equal(response.status, 403);
  });
});
