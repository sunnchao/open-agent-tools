import { connectorFor } from "./registry.js";
import { ragDocumentUploader, type ConnectorDocumentUploader } from "./ragUpload.js";
import {
  getConnector,
  getConnectorDocument,
  recordSyncRun,
  toConnectorConfig,
  updateConnectorSyncState,
  upsertConnectorDocument,
  type ConnectorSyncFailure,
  type ConnectorSyncRun,
  type ConnectorSyncStatus,
} from "./store.js";
import {
  applyFilter,
  contentHashOf,
  ragSourceName,
  type Connector,
  type ConnectorDeps,
  type ConnectorDocument,
} from "./types.js";

/** 运行记录里最多保留的失败明细条数,避免单次同步把 JSON 撑爆。 */
const MAX_FAILURES = 20;

export interface RunConnectorSyncOptions {
  connectorId: string;
  /** 注入 fetch/fs/clock,默认组合里 fetch 走全局,fs 需要 local-dir 时显式传入。 */
  deps?: ConnectorDeps;
  /** 覆盖连接器实现(测试用);默认按类型从 registry 取。 */
  connector?: Connector;
  /** 覆盖上传器(测试用);默认走 rag-server multipart 直传。 */
  uploader?: ConnectorDocumentUploader;
  /** 覆盖时钟(测试用)。 */
  now?: () => number;
}

/**
 * 同步引擎:拉取 → 过滤 → 逐篇按「外部 id + 内容哈希」去重入库。
 *
 * 失败粒度到单篇:一篇上传失败不影响其余文档,失败原因写进运行记录。
 */
export async function runConnectorSync(
  options: RunConnectorSyncOptions,
): Promise<ConnectorSyncRun> {
  const connector = getConnector(options.connectorId);
  if (!connector) throw new Error("connector not found");

  const clock = options.now ?? options.deps?.now ?? (() => Date.now());
  const startedMs = clock();
  const startedAt = new Date(startedMs).toISOString();
  const deps: ConnectorDeps = { ...options.deps };
  const impl = options.connector ?? connectorFor(connector.type);
  const uploader = options.uploader ?? ragDocumentUploader;

  let documents: ConnectorDocument[] = [];
  let fetchError: string | null = null;
  try {
    const fetched = await impl.fetchDocuments(toConnectorConfig(connector), deps);
    documents = applyFilter(fetched, connector.filter);
  } catch (error) {
    fetchError = errorMessage(error);
  }

  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  const failures: ConnectorSyncFailure[] = [];

  if (!fetchError) {
    for (const document of documents) {
      const contentHash = contentHashOf(document);
      const ragSource = ragSourceName(connector.id, document.externalId);
      const existing = getConnectorDocument(connector.id, document.externalId);
      if (existing && existing.contentHash === contentHash && existing.ragSource === ragSource) {
        skipped += 1;
        continue;
      }
      try {
        await uploader.upload(
          {
            source: ragSource,
            title: document.title,
            content: document.content,
            mimeType: document.mimeType,
          },
          { fetch: deps.fetch },
        );
        upsertConnectorDocument({
          connectorId: connector.id,
          externalId: document.externalId,
          title: document.title,
          contentHash,
          ragSource,
          byteSize: Buffer.byteLength(document.content, "utf8"),
          ingestedAt: new Date(clock()).toISOString(),
        });
        ingested += 1;
      } catch (error) {
        failed += 1;
        if (failures.length < MAX_FAILURES) {
          failures.push({ externalId: document.externalId, reason: errorMessage(error) });
        }
      }
    }
  }

  const status: ConnectorSyncStatus = fetchError
    ? "error"
    : failed > 0
      ? ingested + skipped > 0
        ? "partial"
        : "error"
      : "success";
  const finishedMs = clock();
  const finishedAt = new Date(finishedMs).toISOString();
  const run = recordSyncRun({
    connectorId: connector.id,
    status,
    pulled: documents.length,
    ingested,
    skipped,
    failed,
    failures,
    error: fetchError,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedMs - startedMs),
  });
  updateConnectorSyncState(connector.id, { status, lastSyncedAt: finishedAt });
  return run;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
