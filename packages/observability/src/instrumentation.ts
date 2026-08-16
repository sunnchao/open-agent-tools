/**
 * Langfuse 初始化（OpenTelemetry 方式）。
 *
 * - 在构造 LangfuseSpanProcessor 之前加载环境变量（SDK 从 LANGFUSE_* 读取凭据）。
 * - 未配置 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 时自动禁用，服务不受影响。
 * - 测试环境（NODE_ENV=test）默认禁用，避免 OTel 全局注册污染测试进程。
 * - `initLangfuse()` 只执行一次（幂等），serviceName 以首次调用为准。
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LangfuseSpanProcessor } from "@langfuse/otel";

/** 导出前统一脱敏常见凭据模式，防止敏感数据泄漏到 Langfuse。 */
function maskSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(sk-lf-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1***")
      .replace(/(pk-lf-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1***")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
      .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***")
      .replace(/(sk-[A-Za-z0-9]{8})[A-Za-z0-9]+/g, "$1***")
      .replace(/(secret["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***");
  }
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === "object") {
    const masked: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/key|token|secret|password|authorization/i.test(key)) {
        masked[key] = typeof item === "string" && item.length > 0 ? "***" : item;
      } else {
        masked[key] = maskSecrets(item);
      }
    }
    return masked;
  }
  return value;
}

// 测试进程（node:test / vitest / jest）一律禁用，避免测试 trace 污染 Langfuse 项目。
const inTest =
  process.env.NODE_ENV === "test" ||
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  Boolean(process.env.VITEST) ||
  Boolean(process.env.JEST_WORKER_ID);

let initialized = false;

/**
 * 初始化 Langfuse（幂等）。在创建任何 LangChain 模型 / CallbackHandler 之前调用。
 * `envRoot` 为相对当前模块的路径，用于加载 `<envRoot>/.env(.local)`；
 * 加载顺序：先 .env 再 .env.local（覆盖）。
 */
export function initLangfuse(options: { serviceName: string; envRoot?: string }): void {
  if (initialized) return;
  initialized = true;

  const envRoot = options.envRoot ?? "../";
  loadEnv({ path: resolve(import.meta.dirname, envRoot, ".env") });
  loadEnv({ path: resolve(import.meta.dirname, envRoot, ".env.local"), override: true });

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

  const processor = enabled
    ? new LangfuseSpanProcessor({
        environment: process.env.NODE_ENV ?? "development",
        baseUrl: langfuseBaseUrl,
        mask: ({ data }) => maskSecrets(data),
      })
    : undefined;

  langfuseSpanProcessor = processor;
  tracingEnabled = Boolean(processor);

  if (processor) {
    // 关闭自动资源探测，只保留 service.name，避免 process/host 等系统细节混入 trace metadata。
    const sdk = new NodeSDK({
      spanProcessors: [processor],
      autoDetectResources: false,
      resource: resourceFromAttributes({ "service.name": options.serviceName }),
    });
    sdk.start();
    console.log(`[langfuse] tracing enabled (${langfuseBaseUrl ?? "https://cloud.langfuse.com"})`);
  }
}

export let langfuseSpanProcessor: LangfuseSpanProcessor | undefined;
export let tracingEnabled = false;

/** 强制将缓存的 trace 导出到 Langfuse（短生命周期场景或请求收尾时调用）。 */
export async function flushLangfuse(): Promise<void> {
  await langfuseSpanProcessor?.forceFlush();
}
