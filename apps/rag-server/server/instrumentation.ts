/**
 * Langfuse 初始化（OpenTelemetry 方式），供 @langfuse/langchain 的 CallbackHandler 使用。
 * - 未配置 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 时自动禁用。
 * - 测试进程（node:test / vitest / jest）一律禁用。
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LangfuseSpanProcessor } from "@langfuse/otel";

loadEnv({ path: resolve(import.meta.dirname, "../.env") });
loadEnv({ path: resolve(import.meta.dirname, "../.env.local"), override: true });

const inTest =
  process.env.NODE_ENV === "test" ||
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  Boolean(process.env.VITEST) ||
  Boolean(process.env.JEST_WORKER_ID);

const enabled =
  !inTest &&
  process.env.LANGFUSE_DISABLED !== "true" &&
  Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

// SDK 默认 EU 端点（cloud.langfuse.com）；密钥是区域绑定的，配错会导致 401 静默丢 trace。
// 支持 LANGFUSE_BASE_URL（标准）与 LANGFUSE_HOST（langfuse-cli 惯例）两种写法。
const langfuseBaseUrl = process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST;

if (enabled && !process.env.LANGFUSE_BASE_URL) {
  console.warn(
    `[langfuse] 未设置 LANGFUSE_BASE_URL，trace 将导出到默认端点 https://cloud.langfuse.com（EU）。` +
      `请确认该端点与密钥所在项目一致，否则导出会失败（US 项目请用 https://us.cloud.langfuse.com）。`,
  );
}

export const langfuseSpanProcessor = enabled
  ? new LangfuseSpanProcessor({
      environment: process.env.NODE_ENV ?? "development",
      baseUrl: langfuseBaseUrl,
    })
  : undefined;

/** 是否已启用 Langfuse tracing。 */
export const tracingEnabled = Boolean(langfuseSpanProcessor);

if (langfuseSpanProcessor) {
  // 关闭自动资源探测，只保留 service.name，避免 process/host 等系统细节混入 trace metadata。
  const sdk = new NodeSDK({
    spanProcessors: [langfuseSpanProcessor],
    autoDetectResources: false,
    resource: resourceFromAttributes({ "service.name": "open-agent-rag-server" }),
  });
  sdk.start();
  console.log(`[langfuse] tracing enabled (${langfuseBaseUrl ?? "https://cloud.langfuse.com"})`);
}
