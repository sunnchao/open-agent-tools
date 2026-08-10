/**
 * 图谱库与知识库同生命周期 —— 端到端实机验证脚本。
 *
 * 用独立临时 SQLite 库拉起真实 rag-server，跑完整 HTTP 链路：
 *   上传 → 自动建图 → 删除级联 → 外部漂移 → 一键对账。
 * 不依赖 OpenAI Key（强制置空走 BM25 + 规则抽取），不污染开发库。
 *
 * 用法：node scripts/e2e-lifecycle.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER_DIR = resolve(import.meta.dirname, "..");
const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function step(title) {
  console.log(`\n▸ ${title}`);
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function upload(files) {
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) {
    form.append("files", new Blob([content], { type: "text/markdown" }), name);
  }
  return api("/api/documents", { method: "POST", body: form });
}

/** 轮询直到图谱队列排空（building 落地为 ready/failed）。 */
async function waitSettled(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("/api/graph/sync-status");
    if (body && body.building?.length === 0 && body.queued === 0) return body;
    if (Date.now() > deadline) throw new Error(`图谱重建超时：${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function waitHealthy(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 服务未起，继续等 */
    }
    if (Date.now() > deadline) throw new Error("服务启动超时");
    await new Promise((r) => setTimeout(r, 300));
  }
}

const DOC_A = `腾讯云，微信支付，小程序生态。
腾讯云提供云服务器，对象存储，数据库服务。
微信支付支持扫码支付，与小程序深度集成。`;

const DOC_B = `阿里云，支付宝，钉钉办公。
阿里云提供弹性计算，对象存储，数据库服务。
支付宝支持扫码支付，与钉钉打通企业账户。`;

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "rag-e2e-"));
  console.log(`临时数据目录：${dir}`);

  const child = spawn("npx", ["tsx", "server/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      RAG_API_PORT: String(PORT),
      RAG_DB_PATH: join(dir, "rag.db"),
      RAG_GRAPH_DB_PATH: join(dir, "rag-graph.db"),
      OPENAI_API_KEY: "", // 强制离线：BM25 检索 + 规则抽取，避免计费与限流
      RAG_AUTO_EXTRACT: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  try {
    const health = await waitHealthy();
    console.log(`服务就绪：embeddings=${health.embeddingsEnabled} llm=${health.llmAvailable}`);

    step("1. 上传两篇文档，图谱应自动重建");
    const up = await upload({ "a.md": DOC_A, "b.md": DOC_B });
    check("上传返回 201", up.status === 201, `status=${up.status}`);
    check(
      "只回本次上传的来源（非全库）",
      Array.isArray(up.body?.sources) && up.body.sources.length === 2,
      JSON.stringify(up.body?.sources),
    );
    check("响应携带图谱同步状态", Boolean(up.body?.graph), JSON.stringify(up.body?.graph));

    const settled = await waitSettled();
    check("重建完成后两库一致", settled.inSync === true, JSON.stringify(settled));

    const sources1 = await api("/api/graph/sources");
    const ready = (sources1.body?.sources ?? []).filter((s) => s.status === "ready");
    check("两个来源都登记为 ready", ready.length === 2, JSON.stringify(sources1.body?.sources));
    const stats1 = sources1.body?.stats ?? {};
    check("抽出实体与关系", stats1.entities > 0 && stats1.relations > 0, JSON.stringify(stats1));
    console.log(`    图谱规模：实体 ${stats1.entities} / 关系 ${stats1.relations}`);

    step("2. 删除 a.md，图谱应级联回收且不误伤 b.md");
    const del = await api("/api/documents/a.md", { method: "DELETE" });
    check("删除返回 ok", del.body?.ok === true, JSON.stringify(del.body));
    check(
      "回收了 a.md 的实体/关系",
      (del.body?.graph?.entities ?? 0) > 0 || (del.body?.graph?.relations ?? 0) > 0,
      JSON.stringify(del.body?.graph),
    );
    console.log(
      `    回收：实体 ${del.body?.graph?.entities} / 关系 ${del.body?.graph?.relations}`,
    );

    const afterDel = await waitSettled();
    check("删除后仍一致（无孤儿）", afterDel.inSync === true, JSON.stringify(afterDel));

    const sources2 = await api("/api/graph/sources");
    const names2 = (sources2.body?.sources ?? []).map((s) => s.source);
    check("来源清单只剩 b.md", names2.length === 1 && names2[0] === "b.md", JSON.stringify(names2));
    const stats2 = sources2.body?.stats ?? {};
    check("图谱仍保留 b.md 数据", stats2.entities > 0, JSON.stringify(stats2));
    console.log(`    剩余规模：实体 ${stats2.entities} / 关系 ${stats2.relations}`);

    step("3. 制造漂移：绕过编排器清掉 b.md 图谱，应被识别为 missing");
    const drop = await api("/api/graph/sources/b.md", { method: "DELETE" });
    check("单来源清理成功", drop.body?.ok === true, JSON.stringify(drop.body));
    const drift = await api("/api/graph/sync-status");
    check("检测到不一致", drift.body?.inSync === false, JSON.stringify(drift.body));
    check(
      "b.md 被列为 missing",
      (drift.body?.missing ?? []).includes("b.md"),
      JSON.stringify(drift.body?.missing),
    );

    step("4. 一键对账，应自动修复");
    const rec = await api("/api/graph/reconcile", { method: "POST" });
    check("对账返回 200", rec.status === 200, `status=${rec.status}`);
    check(
      "重建了 b.md",
      (rec.body?.rebuilt ?? []).includes("b.md"),
      JSON.stringify(rec.body?.rebuilt),
    );
    check("对账后恢复一致", rec.body?.status?.inSync === true, JSON.stringify(rec.body?.status));

    const sources3 = await api("/api/graph/sources");
    const stats3 = sources3.body?.stats ?? {};
    check("图谱数据已恢复", stats3.entities > 0, JSON.stringify(stats3));
    console.log(`    恢复规模：实体 ${stats3.entities} / 关系 ${stats3.relations}`);

    step("5. 删空知识库，图谱应同步清零");
    await api("/api/documents/b.md", { method: "DELETE" });
    const empty = await waitSettled();
    check("清空后一致", empty.inSync === true, JSON.stringify(empty));
    const sources4 = await api("/api/graph/sources");
    const stats4 = sources4.body?.stats ?? {};
    check(
      "图谱彻底清零",
      stats4.entities === 0 && stats4.relations === 0,
      JSON.stringify(stats4),
    );
    check(
      "来源状态行也清干净",
      (sources4.body?.sources ?? []).length === 0,
      JSON.stringify(sources4.body?.sources),
    );
  } catch (error) {
    failed += 1;
    console.error(`\n运行异常：${error instanceof Error ? error.stack : String(error)}`);
    console.error(`\n--- 服务端日志 ---\n${logs.join("")}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
