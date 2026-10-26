import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb, openDb } from "../../../platform/db.js";
import { loadCaliberResolver, resolveCaliberQuery } from "./service.js";
import {
  createCaliberConfig,
  deleteCaliberConfig,
  getCaliberConfig,
  getDefaultCaliberConfig,
  listCaliberConfigs,
  setDefaultCaliberConfig,
  updateCaliberConfig,
} from "./store.js";

const ORG_DIRECTORY = [
  { code: "BJ", name: "北京分公司", aliases: ["北京", "京分"] },
  { code: "SH", name: "上海分公司", aliases: ["上海", "沪分"] },
];

function sampleConfig(): { org: { directory: typeof ORG_DIRECTORY } } {
  return { org: { directory: ORG_DIRECTORY } };
}

describe("caliber config store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-caliber-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
    openDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("promotes the first config to default and fills schema defaults", () => {
    const first = createCaliberConfig({ name: "默认口径", config: sampleConfig() });
    assert.equal(first.isDefault, true);
    assert.equal(first.enabled, true);
    assert.equal(first.config.date.timezone, "Asia/Shanghai");
    assert.equal(first.config.expense.fallback, "TRAVEL");
    assert.equal(first.config.defaults.timeField, "approve");

    const second = createCaliberConfig({ name: "备用口径", config: sampleConfig() });
    assert.equal(second.isDefault, false);
    assert.equal(getDefaultCaliberConfig()?.id, first.id);
  });

  it("lists enabled configs and includes disabled ones on demand", () => {
    const first = createCaliberConfig({ name: "默认口径", config: sampleConfig() });
    const second = createCaliberConfig({ name: "备用口径", config: sampleConfig() });
    updateCaliberConfig(second.id, { enabled: false });

    assert.deepEqual(listCaliberConfigs().map((c) => c.id), [first.id]);
    assert.equal(listCaliberConfigs({ includeDisabled: true }).length, 2);
    assert.equal(getDefaultCaliberConfig({ requireEnabled: true })?.id, first.id);
  });

  it("refuses to disable or delete the default config", () => {
    const record = createCaliberConfig({ name: "默认口径", config: sampleConfig() });
    assert.throws(() => updateCaliberConfig(record.id, { enabled: false }), /cannot be disabled/);
    assert.equal(deleteCaliberConfig(record.id), "default");
    assert.equal(getCaliberConfig(record.id)?.isDefault, true);
  });

  it("switches the default and then allows deleting the previous one", () => {
    const first = createCaliberConfig({ name: "默认口径", config: sampleConfig() });
    const second = createCaliberConfig({ name: "备用口径", config: sampleConfig() });

    const promoted = setDefaultCaliberConfig(second.id);
    assert.equal(promoted?.isDefault, true);
    assert.equal(getCaliberConfig(first.id)?.isDefault, false);

    assert.equal(deleteCaliberConfig(first.id), "deleted");
    assert.equal(getCaliberConfig(first.id), null);
    assert.equal(deleteCaliberConfig("missing"), "not_found");
  });

  it("rejects configs without an org directory", () => {
    assert.throws(() => createCaliberConfig({ name: "坏口径", config: { org: { directory: [] } } }));
  });
});

describe("caliber resolver service", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-caliber-svc-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
    openDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("resolves four-slot utterances through the configured caliber", async () => {
    const record = createCaliberConfig({ name: "默认口径", config: sampleConfig() });
    const result = await resolveCaliberQuery({
      utterance: "北京分公司上个月的差旅报销",
      ctx: { now: new Date("2026-07-15T00:00:00Z") },
    });

    assert.equal(result.configId, record.id);
    assert.equal(result.outcome.ok, true);
    assert.ok(result.outcome.ok);
    assert.equal(result.outcome.caliber.org.code, "BJ");
    assert.equal(result.outcome.caliber.status, "APPROVED");
    assert.equal(result.outcome.caliber.time_field, "approve");
  });

  it("honors the authorized-org whitelist", async () => {
    createCaliberConfig({ name: "默认口径", config: sampleConfig() });
    const result = await resolveCaliberQuery({
      utterance: "北京分公司上个月的差旅报销",
      ctx: { now: new Date("2026-07-15T00:00:00Z"), authorizedOrgs: ["SH"] },
    });
    assert.equal(result.outcome.ok, false);
    assert.equal(result.outcome.ok === false && result.outcome.reason, "unauthorized");
  });

  it("compiles config patterns at load time and rejects invalid regex", () => {
    const record = createCaliberConfig({
      name: "坏正则口径",
      config: { ...sampleConfig(), intent: { queryPatterns: ["("], keywords: [] } },
    });
    assert.throws(() => loadCaliberResolver(record.id), /无效的正则表达式/);
  });

  it("falls back to the enabled default config when no id is given", async () => {
    createCaliberConfig({ name: "禁用口径", config: sampleConfig(), enabled: false, isDefault: false });
    const enabled = createCaliberConfig({ name: "默认口径", config: sampleConfig() });
    const { record } = loadCaliberResolver();
    assert.equal(record.id, enabled.id);
  });
});
