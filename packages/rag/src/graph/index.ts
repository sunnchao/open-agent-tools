import type {
  ChunkLike,
  DuplicateResolution,
  Entity,
  GraphQuality,
  GraphSourceState,
  GraphStore,
  Relation,
  Subgraph,
} from "./types.js";
import type { ExtractDiagnostics, GraphExtractor } from "./extract.js";
import {
  GleaningExtractor,
  LlmGraphExtractor,
  RuleGraphExtractor,
  type LlmChatFn,
} from "./extract.js";
import { SqliteGraphStore } from "./store.js";
import { GraphRetriever, type EmbeddingsLike, type GraphRetrieverOptions } from "./retriever.js";
import { GraphVisualizer } from "./visualize.js";

export type {
  Entity,
  Relation,
  Subgraph,
  GraphQueryResult,
  ExtractResult,
  GraphStore,
  GraphSourceState,
  GraphQuality,
  DuplicateResolution,
  RelationOrigin,
  ChunkLike,
} from "./types.js";
export { SqliteGraphStore, LEGACY_SOURCE, type SqliteGraphStoreOptions } from "./store.js";
export {
  LlmGraphExtractor,
  RuleGraphExtractor,
  GleaningExtractor,
  mergeExtractResults,
  extractCandidateNames,
  splitSentences,
  extractJson,
  DEFAULT_ENTITY_TYPES,
  DEFAULT_RELATION_TYPES,
  type GraphExtractor,
  type LlmChatFn,
  type ExtractDiagnostics,
  type ObservableExtractor,
} from "./extract.js";
export { GraphRetriever, type GraphRetrieverOptions, type EmbeddingsLike } from "./retriever.js";
export { GraphVisualizer, type GraphExport, type GraphNode, type GraphEdge } from "./visualize.js";
export {
  sha1,
  normalizeName,
  entityId,
  relationId,
  isSymmetricRelation,
  relationSpecificity,
  serializeSubgraph,
  cosine,
} from "./utils.js";

export interface KnowledgeGraphOptions {
  /** SQLite 数据库文件路径，默认 ./rag-graph.db。 */
  dbPath?: string;
  /**
   * 抽取器：缺省时按是否提供 llmChat 决定——
   * 提供 llmChat 用 LLM 抽取器，否则用规则抽取器（离线可用）。
   */
  extractor?: GraphExtractor;
  /** LLM 抽取通道：传入后自动装配 LlmGraphExtractor（OpenAI 兼容单次对话）。 */
  llmChat?: LlmChatFn;
  /** 轻量 embeddings：名称匹配为空时对实体名做向量 top-k 兜底。 */
  embeddings?: EmbeddingsLike;
  /** Gleaning 轮数（首轮之外的补充轮数），0/1 表示关闭，默认 1（共两轮）。 */
  gleaningRounds?: number;
  /**
   * chunk 级抽取并发度。抽取是 LLM 往返，串行会让大文档建图极慢；
   * 写库仍在单线程内顺序执行（SQLite 单写者），并发只作用于抽取调用。
   */
  extractConcurrency?: number;
  /** 单来源抽取中允许失败的 chunk 比例上限，超过则整篇判失败，默认 0.2。 */
  maxChunkFailureRatio?: number;
  /**
   * 连续失败后的退避基数（毫秒），默认 1500。
   * 上游限流时按「连续失败次数 × 基数」线性退避，上限 30s，避免把配额打满。
   */
  extractRetryDelayMs?: number;
  /** 注入日志便于测试静默。 */
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/** 单来源建图的失败明细。 */
export interface SourceBuildFailure {
  chunkId: string;
  chunkIndex: number;
  error: string;
}

/**
 * 重建前的图谱快照。抽取失败时据此回滚，避免「先删后抽」把旧图打没。
 */
interface SourceSnapshot {
  entities: Map<string, Entity>;
  relations: Map<string, Relation>;
  /** 来源 → 该来源贡献的实体 id。 */
  entitySourcesBySource: Map<string, string[]>;
  /** 来源 → 该来源贡献的关系 id。 */
  relationSourcesBySource: Map<string, string[]>;
}

export interface IngestSummary {
  files: number;
  entities: number;
  relations: number;
  /** 抽取失败的 chunk（已跳过，不影响其余 chunk 落库）。 */
  failedChunks: SourceBuildFailure[];
}

/** 将一个来源卡在 building 多久后视为僵死（进程被杀后的自愈阈值）。 */
const STUCK_SOURCE_MINUTES = 10;

/** 把「N 分钟前」换算成 UTC 的 `YYYY-MM-DD HH:MM:SS`（与 SQLite datetime('now') 同格式）。 */
function sqliteTimeBefore(minutes: number): string {
  const date = new Date(Date.now() - minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** 知识图谱引擎门面：抽取入库 + 子图检索 + 可视化导出。仿 Rag 类。 */
export class KnowledgeGraph {
  readonly store: GraphStore;
  readonly extractor: GraphExtractor;
  readonly retriever: GraphRetriever;
  readonly visualizer: GraphVisualizer;
  private extractConcurrency: number;
  private extractRetryDelayMs: number;
  private maxChunkFailureRatio: number;
  private embeddings?: EmbeddingsLike;
  private logger: Pick<Console, "log" | "warn" | "error">;
  /** 各来源上次回写进度的时刻，用于节流（见 touchSourceProgress）。 */
  private progressWrites = new Map<string, number>();

  constructor(opts: KnowledgeGraphOptions = {}) {
    this.store = new SqliteGraphStore({ dbPath: opts.dbPath ?? "./rag-graph.db" });
    const base =
      opts.extractor ??
      (opts.llmChat ? new LlmGraphExtractor(opts.llmChat) : new RuleGraphExtractor());
    // Gleaning 默认补一轮：单轮抽取在信息密集分块上容易漏实体
    const rounds = opts.gleaningRounds ?? 1;
    this.extractor = rounds > 1 ? new GleaningExtractor(base, { rounds }) : base;
    this.retriever = new GraphRetriever(this.store, { embeddings: opts.embeddings });
    this.embeddings = opts.embeddings;
    this.visualizer = new GraphVisualizer(this.store);
    this.extractConcurrency = Math.max(1, opts.extractConcurrency ?? 4);
    this.extractRetryDelayMs = Math.max(0, opts.extractRetryDelayMs ?? 1_500);
    this.maxChunkFailureRatio = Math.min(1, Math.max(0, opts.maxChunkFailureRatio ?? 0.2));
    this.logger = opts.logger ?? console;
  }

  /** 抽取器失败计数（解析失败、端点丢失等），供健康检查与排障。 */
  diagnostics(): ExtractDiagnostics | null {
    const observable = this.extractor as Partial<{ diagnostics(): ExtractDiagnostics }>;
    return typeof observable.diagnostics === "function" ? observable.diagnostics() : null;
  }

  /**
   * 从分块批量抽取并入库。
   *
   * `replace` 默认开启：同一来源重建时清掉旧图谱，保证「文档重传 = 图谱重建」，
   * 否则改动过的文档会把失效的旧实体关系永久留在图里（只增不清）。
   *
   * **旧图的删除时机是这里最关键的正确性约束**：绝不能先删后抽。
   * 抽取是几十次 LLM 往返，一旦中途失败（限流、超时、进程重启），先删就变成
   * 「旧图没了、新图只写了一半」——线上实测发生过：一次限流把 152 实体 / 172 关系
   * 的文档打成 15 实体 / 13 关系。因此改为：
   *   1. 先把本次结果写进库（同 id upsert 天然幂等，不会污染其他来源）；
   *   2. 抽取全部成功且失败率在阈值内，才按来源清掉本次未覆盖的陈旧数据；
   *   3. 失败率超阈值则整体回滚本次写入，保留旧图不动。
   */
  async ingest(chunks: ChunkLike[], opts: { replace?: boolean } = {}): Promise<IngestSummary> {
    const replace = opts.replace ?? true;
    const sources = new Set(chunks.map((c) => c.source));

    const failedChunks: SourceBuildFailure[] = [];
    let entityCount = 0;
    let relationCount = 0;
    // ingest 可能一次收到多个来源的分块；进度分母必须按来源分别算，
    // 否则多来源时进度永远到不了 100%。
    const totalBySource = new Map<string, number>();
    for (const chunk of chunks) {
      totalBySource.set(chunk.source, (totalBySource.get(chunk.source) ?? 0) + 1);
    }
    const processedBySource = new Map<string, number>();
    // 本次实际写入的 id：陈旧数据清理必须以此为准，而不是「库里当前还有什么」
    const writtenEntities = new Set<string>();
    const writtenRelations = new Set<string>();
    // 先快照旧图，失败时据此恢复（只在 replace 且已有数据时需要）
    const previous = replace ? this.snapshotSources(sources) : null;

    /** 把一个分块的抽取结果写库（抽取完成即写，不攒到最后）。 */
    const persist = (chunk: ChunkLike, result: Awaited<ReturnType<GraphExtractor["extract"]>>) => {
      for (const e of result.entities) {
        this.store.upsertEntity(e);
        writtenEntities.add(e.id);
        // 实体归属到来源：删文档时据此判断实体是否还被其他文档需要
        this.store.linkEntitySource(e.id, chunk.source);
        // 抽取结果 props 中携带的别名（alias / aliases,逗号分隔）注册进别名表,共指合并用
        const aliasField = e.props["alias"] ?? e.props["aliases"] ?? e.props["别名"];
        if (aliasField) {
          for (const alias of aliasField
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean)) {
            this.store.addAlias(e.id, alias);
          }
        }
      }
      for (const r of result.relations) {
        this.store.upsertRelation(r);
        writtenRelations.add(r.id);
      }
      entityCount += result.entities.length;
      relationCount += result.relations.length;
      // 每处理完一批就刷新来源快照，让 status/quality 能反映真实进度
      const done = (processedBySource.get(chunk.source) ?? 0) + 1;
      processedBySource.set(chunk.source, done);
      this.touchSourceProgress(chunk.source, done, totalBySource.get(chunk.source) ?? done);
      if (result.entities.length > 0) {
        this.ensureEntityVectors(result.entities.map((e) => e.id)).catch(() => undefined);
      }
    };

    await this.extractAll(chunks, failedChunks, persist);
    const failedRatio = chunks.length > 0 ? failedChunks.length / chunks.length : 0;
    if (failedRatio > this.maxChunkFailureRatio) {
      // 失败率超阈值：先撤掉本次已写入的数据，再恢复旧图。
      // 只「补写旧数据」是不够的——本次抽出来的新实体/新边会留在库里，
      // 形成「旧图 + 残渣」的混合状态（隔离脚本复现过：回滚后多出 1 个实体）。
      this.rollbackWritten(writtenEntities, writtenRelations, sources);
      if (previous) await this.restoreSources(previous);
      throw new Error(
        `抽取失败比例过高（${failedChunks.length}/${chunks.length}），已回滚本次写入并保留重建前的图谱`,
      );
    }
    if (replace && previous) {
      // 成功路径：清掉本次没有再次出现的陈旧实体/关系（文档内容变了才会走到这里）
      const written = { entities: writtenEntities, relations: writtenRelations };
      for (const source of sources) this.pruneStaleSource(source, previous, written);
    }
    if (failedChunks.length > 0) {
      this.logger.warn(
        `[graph] ${failedChunks.length}/${chunks.length} 个分块抽取失败，已跳过并继续建图`,
      );
    }
    return { files: chunks.length, entities: entityCount, relations: relationCount, failedChunks };
  }

  /**
   * 撤掉本次重建已经写入的数据。
   *
   * 关键点：本次新建的实体/关系在重建前并不存在，它们不属于「旧图」，
   * 失败时必须删掉；本次只是「更新了旧实体」的情况由随后的 restoreSources 覆盖回去。
   * 只对本次来源解绑，避免波及其他文档共享的实体。
   */
  private rollbackWritten(
    writtenEntities: ReadonlySet<string>,
    writtenRelations: ReadonlySet<string>,
    sources: ReadonlySet<string>,
  ): void {
    for (const relationId of writtenRelations) {
      for (const source of sources) {
        this.store.removeRelationIfUnreferenced?.(relationId, source);
      }
    }
    for (const entityId of writtenEntities) {
      for (const source of sources) {
        this.store.removeEntityIfUnreferenced?.(entityId, source);
      }
    }
  }

  /** 快照若干来源当前的实体与关系，供失败回滚使用。 */
  private snapshotSources(sources: ReadonlySet<string>): SourceSnapshot {
    const entities = new Map<string, Entity>();
    const relations = new Map<string, Relation>();
    const entitySourcesBySource = new Map<string, string[]>();
    const relationSourcesBySource = new Map<string, string[]>();
    for (const source of sources) {
      const subgraph = this.store.graphForSource(source);
      const entityIds = subgraph.entities.map((entity) => entity.id);
      const relationIds = subgraph.relations.map((relation) => relation.id);
      entitySourcesBySource.set(source, entityIds);
      relationSourcesBySource.set(source, relationIds);
      for (const entity of subgraph.entities) entities.set(entity.id, entity);
      for (const relation of subgraph.relations) relations.set(relation.id, relation);
    }
    return { entities, relations, entitySourcesBySource, relationSourcesBySource };
  }

  /** 按快照恢复被失败重建影响的来源。 */
  private async restoreSources(snapshot: SourceSnapshot): Promise<void> {
    for (const [source, entityIds] of snapshot.entitySourcesBySource) {
      for (const id of entityIds) {
        const entity = snapshot.entities.get(id);
        if (entity) this.store.upsertEntity(entity);
        this.store.linkEntitySource(id, source);
      }
    }
    for (const [source, relationIds] of snapshot.relationSourcesBySource) {
      for (const id of relationIds) {
        const relation = snapshot.relations.get(id);
        if (relation) {
          this.store.upsertRelation(relation);
          this.store.linkEntitySource(relation.srcId, source);
          this.store.linkEntitySource(relation.dstId, source);
        }
      }
    }
  }

  /**
   * 删除某来源在本次重建后已不再出现的陈旧数据。
   *
   * 判断依据是「本次**写过**哪些 id」而不是「快照里有、库里还有」——
   * 后者会把本次正常重建出来的数据当成陈旧数据删掉（实测过一次重建后实体归零）。
   * 只有旧快照里有、本次完全没再写过的，才是文档内容变化导致的真正过期数据；
   * 且必须确认没有其他来源还在引用。
   */
  private pruneStaleSource(
    source: string,
    previous: SourceSnapshot,
    written: { entities: ReadonlySet<string>; relations: ReadonlySet<string> },
  ): void {
    for (const relationId of previous.relationSourcesBySource.get(source) ?? []) {
      if (written.relations.has(relationId)) continue;
      this.store.removeRelationIfUnreferenced?.(relationId, source);
    }
    for (const entityId of previous.entitySourcesBySource.get(source) ?? []) {
      if (written.entities.has(entityId)) continue;
      this.store.removeEntityIfUnreferenced?.(entityId, source);
    }
  }

  /**
   * 并发抽取，**抽完一个就立刻落库一个**。
   *
   * 早先的实现把所有 chunk 抽完再统一写库：1928 块的大文档要等全部 LLM 往返结束
   * 才开始入库，期间 status/quality 一直显示 0 实体，进程一断全部工作白做——
   * 这正是要修的「进度不可见 + 失败即全废」。现在抽取并发、写库串行（SQLite 单写者），
   * 每个分块完成后立即调用 onChunk 持久化。
   *
   * **限流保护**：单块抽取动辄 30s / 4000+ 输出 token，固定并发很容易撞上游 QPM 上限
   * （线上实测 429 占比 48%，一次 204 块的重建全部失败）。这里按连续失败次数自适应
   * 降速，并在恢复后缓慢回升，避免把配额打满还把所有分块判成失败。
   */
  private async extractAll(
    chunks: readonly ChunkLike[],
    failedChunks: SourceBuildFailure[],
    onChunk: (chunk: ChunkLike, result: Awaited<ReturnType<GraphExtractor["extract"]>>) => void,
  ): Promise<void> {
    let cursor = 0;
    let consecutiveFailures = 0;
    const baseDelay = this.extractRetryDelayMs;
    const worker = async (): Promise<void> => {
      while (cursor < chunks.length) {
        const index = cursor;
        cursor += 1;
        const chunk = chunks[index]!;
        // 连续失败时退避：第 N 次连续失败等 N 倍基础延迟，给上游配额恢复时间
        if (consecutiveFailures > 0) {
          const wait = Math.min(baseDelay * consecutiveFailures, 30_000);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        try {
          const result = await this.extractor.extract(chunk);
          consecutiveFailures = 0;
          // 并发下多个 worker 会同时回来，写库必须串行：Node 单线程 + 同步 sqlite 调用
          // 天然满足，这里不需要额外加锁，但绝不能把持久化放进 Promise.all 之外的异步分支。
          onChunk(chunk, result);
        } catch (error) {
          consecutiveFailures += 1;
          failedChunks.push({
            chunkId: chunk.id,
            chunkIndex: chunk.chunkIndex,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.extractConcurrency, chunks.length) }, () => worker()),
    );
  }

  /**
   * 刷新某来源的建图进度（已处理分块数 / 实体数 / 关系数）。
   *
   * 大文档建图要几十分钟，期间若状态一直停在 building/0，前端和运维都无法判断
   * 是在正常推进还是已经卡死。按固定间隔回写，让进度可观测。
   */
  private touchSourceProgress(source: string, processed: number, total: number): void {
    // 按时间节流而不是按块数：单块耗时差异很大（4s~60s），按块数会让慢块期间
    // 长时间看不到进度。这里保证最多每 5 秒回写一次，同时最后一块必定回写。
    const last = this.progressWrites.get(source) ?? 0;
    const now = Date.now();
    if (processed !== total && now - last < 5_000) return;
    this.progressWrites.set(source, now);
    const counted = this.store.countBySource(source);
    this.store.markSource(source, {
      status: "building",
      entities: counted.entities,
      relations: counted.relations,
      chunks: total,
    });
  }

  /** 为新入库实体预计算名称向量（失败不影响建图，检索期会再补）。 */
  private async ensureEntityVectors(ids: readonly string[]): Promise<void> {
    const embeddings = this.embeddings;
    if (!embeddings || !this.store.upsertEntityEmbeddings || ids.length === 0) return;
    const entities = this.store.findEntitiesByIds?.(ids) ?? [];
    if (entities.length === 0) return;
    const vectors = await embeddings.embedDocuments(entities.map((entity) => entity.name));
    this.store.upsertEntityEmbeddings(
      entities
        .map((entity, index) => ({ id: entity.id, vector: vectors[index] }))
        .filter((entry): entry is { id: string; vector: number[] } => entry.vector !== undefined),
    );
  }

  /**
   * 重建单个来源的图谱并登记状态，供生命周期编排调用。
   * 失败时状态置 failed 并抛出，由调用方决定重试或提示。
   */
  async syncSource(source: string, chunks: ChunkLike[]): Promise<GraphSourceState> {
    this.store.markSource(source, { status: "building", chunks: chunks.length });
    try {
      const summary = await this.ingest(chunks, { replace: true });
      const counted = this.store.countBySource(source);
      const partial =
        summary.failedChunks.length > 0
          ? `${summary.failedChunks.length}/${chunks.length} 个分块抽取失败，图谱不完整`
          : "";
      return this.store.markSource(source, {
        status: "ready",
        entities: counted.entities,
        relations: counted.relations,
        chunks: chunks.length,
        error: partial,
      });
    } catch (error) {
      this.store.markSource(source, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 复位僵死在 building 的来源（进程重启/OOM 后状态永远不会自己走出来的坑）。
   *
   * 这些来源既不在 missing 也不在 stale，reconcile 不会重试；不复位等于图永久缺失。
   * 返回被复位的来源名，调用方据此触发重建。
   */
  resetStuckSources(minutes = STUCK_SOURCE_MINUTES): string[] {
    const reset = this.store.resetStuckSources?.(sqliteTimeBefore(minutes)) ?? [];
    if (reset.length > 0) {
      this.logger.warn(`[graph] 复位 ${reset.length} 个僵死 building 来源: ${reset.join(", ")}`);
    }
    return reset;
  }

  /** 图谱侧已登记的来源状态列表。 */
  listSources(): GraphSourceState[] {
    return this.store.listSources();
  }

  getSource(source: string): GraphSourceState | null {
    return this.store.getSource(source);
  }

  /**
   * 与知识库来源清单对账。
   * - missing：知识库有、图谱没建（含 pending / failed）
   * - stale：两侧都有但分块数对不上，说明文档被重新切分或重传过
   * - orphan：图谱有、知识库已删（含 v1 遗留占位来源）
   * - building：正在抽取中
   * - stuck：卡在 building 超过阈值，需复位后重建
   */
  diff(
    ragSources: Array<{ source: string; chunks: number }>,
    opts: { stuckAfterMinutes?: number } = {},
  ): {
    inSync: boolean;
    missing: string[];
    stale: string[];
    orphan: string[];
    building: string[];
    stuck: string[];
  } {
    const graphStates = new Map(this.store.listSources().map((s) => [s.source, s]));
    const missing: string[] = [];
    const stale: string[] = [];
    const building: string[] = [];
    const stuck: string[] = [];
    const stuckBefore = sqliteTimeBefore(opts.stuckAfterMinutes ?? STUCK_SOURCE_MINUTES);

    for (const { source, chunks } of ragSources) {
      const state = graphStates.get(source);
      if (!state || state.status === "pending" || state.status === "failed") {
        missing.push(source);
        continue;
      }
      if (state.status === "building") {
        // updated_at 早于阈值 = 抽取进程已经死了，归入 stuck 而不是 building，
        // 否则它会永远停在 building，对账既不重建也不算缺失。
        if (state.updatedAt < stuckBefore) stuck.push(source);
        else building.push(source);
        continue;
      }
      if (state.chunks !== chunks) stale.push(source);
    }

    const ragNames = new Set(ragSources.map((s) => s.source));
    const orphan = [...graphStates.keys()].filter((s) => !ragNames.has(s));

    return {
      inSync: missing.length === 0 && stale.length === 0 && orphan.length === 0,
      missing,
      stale,
      orphan,
      building,
      stuck,
    };
  }

  /** 子图检索：种子定位 + 多跳扩展。 */
  retrieve(query: string, opts: GraphRetrieverOptions = {}) {
    return this.retriever.retrieve(query, opts);
  }

  /** 单实体邻域检索。 */
  neighbors(entityId: string, hops = 2): Subgraph {
    return this.store.neighbors(entityId, hops);
  }

  listEntities(opts?: {
    offset?: number;
    limit?: number;
    type?: string;
    search?: string;
  }): Entity[] {
    return this.store.listEntities(opts);
  }

  /** 列出支撑某实体的文档来源（ACL / 排障用）。 */
  entitySources(entityId: string): string[] {
    return this.store.entitySources?.(entityId) ?? [];
  }

  getStats(): { entities: number; relations: number } {
    return this.store.stats();
  }

  /** 图谱质量快照；store 未实现时返回 null。 */
  quality(): GraphQuality | null {
    return this.store.quality?.() ?? null;
  }

  /**
   * 同名多 type 实体消解：每个规范化名保留度数最高的实体作为主实体，
   * 其余节点的边与来源归属重定向过去后删除。
   *
   * 实体 id 含 type，LLM 对同一名称给出不同 type 就会把图切成互不连通的多份；
   * 消解后子图扩展才能走完整邻域。
   */
  resolveDuplicateEntities(opts: { dryRun?: boolean } = {}): DuplicateResolution {
    const empty: DuplicateResolution = {
      groups: 0,
      removedEntities: 0,
      movedRelations: 0,
      droppedRelations: 0,
    };
    if (!this.store.mergeEntities) return empty;
    const all = this.store.listEntities({ limit: Number.MAX_SAFE_INTEGER });
    const byName = new Map<string, Entity[]>();
    for (const entity of all) {
      const group = byName.get(entity.name);
      if (group) group.push(entity);
      else byName.set(entity.name, [entity]);
    }
    const result: DuplicateResolution = { ...empty };
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      // 主实体选度数最高者：保住边最多的那个，减少重定向后的 id 漂移
      const ranked = group
        .map((entity) => ({ entity, degree: this.degreeOf(entity.id) }))
        .sort((a, b) => b.degree - a.degree || a.entity.id.localeCompare(b.entity.id));
      const [primary, ...duplicates] = ranked;
      if (!primary || duplicates.length === 0) continue;
      result.groups += 1;
      if (opts.dryRun) {
        result.removedEntities += duplicates.length;
        continue;
      }
      const merged = this.store.mergeEntities(
        primary.entity.id,
        duplicates.map((entry) => entry.entity.id),
      );
      result.removedEntities += merged.removedEntities;
      result.movedRelations += merged.movedRelations;
      result.droppedRelations += merged.droppedRelations;
    }
    if (!opts.dryRun && result.groups > 0) {
      this.logger.log(
        `[graph] 实体消解完成: ${result.groups} 组, 删除 ${result.removedEntities} 个冗余实体, ` +
          `重定向 ${result.movedRelations} 条关系, 丢弃 ${result.droppedRelations} 条重复关系`,
      );
    }
    return result;
  }

  /** 实体度数（供消解挑主实体）。 */
  private degreeOf(entityId: string): number {
    return this.store.neighbors(entityId, 1, { maxNodes: 1_000 }).relations.length;
  }

  /** 清除某来源的全部图谱数据与状态登记（知识库删除文档时联动调用）。 */
  clearSource(source: string): { relations: number; entities: number } {
    const removed = this.store.removeBySource(source);
    this.store.removeSourceRecord(source);
    return removed;
  }

  close(): void {
    this.store.close();
  }
}
