import type { Rag } from "@open-agent-tools/rag";
import type { GraphSourceState, KnowledgeGraph } from "@open-agent-tools/rag-graph";

export interface GraphLifecycleOptions {
  rag: Rag;
  graph: KnowledgeGraph;
  /** 关闭后上传不再自动建图，只登记 pending，由手动对账触发（RAG_AUTO_EXTRACT=false）。 */
  autoExtract?: boolean;
  /** 注入日志便于测试静默。 */
  logger?: Pick<Console, "log" | "error">;
}

export interface SyncStatus {
  inSync: boolean;
  /** 知识库有、图谱缺失或建图失败。 */
  missing: string[];
  /** 两侧都有但分块数不一致，文档被重传或重新切分过。 */
  stale: string[];
  /** 图谱有、知识库已无对应文档（含历史遗留数据）。 */
  orphan: string[];
  /** 正在后台抽取中。 */
  building: string[];
  /** 排队等待抽取的来源数。 */
  queued: number;
  sources: GraphSourceState[];
  ragSources: Array<{ source: string; chunks: number }>;
  stats: { entities: number; relations: number };
}

export interface ReconcileResult {
  rebuilt: string[];
  removed: string[];
  failed: Array<{ source: string; error: string }>;
  stats: { entities: number; relations: number };
}

/**
 * 知识库与图谱库的生命周期编排器。
 *
 * 存在的理由：图谱数据完全派生自知识库文档，两者必须同生共死。
 * 此前上传只增不清、删除毫无联动，图谱会持续累积失效实体。
 * 这里把「写入 / 删除 / 对账 / 修复」四个动作收敛到唯一入口，
 * 任何绕过它直接操作 graph.store 的写法都会重新引入不一致。
 *
 * 抽取串行执行：LLM 抽取按分块逐个调用，多文档并发会瞬间打满速率限制，
 * 且 SQLite 单写者模型下并发写入并无收益。
 */
export class GraphLifecycle {
  private rag: Rag;
  private graph: KnowledgeGraph;
  private autoExtract: boolean;
  private logger: Pick<Console, "log" | "error">;
  /** 待抽取队列（去重），配合 running 标志实现串行消费。 */
  private queue: string[] = [];
  private running = false;
  /** 当前正在抽取的来源，对账时归入 building。 */
  private current: string | null = null;

  constructor(opts: GraphLifecycleOptions) {
    this.rag = opts.rag;
    this.graph = opts.graph;
    this.autoExtract = opts.autoExtract ?? true;
    this.logger = opts.logger ?? console;
  }

  /**
   * 文档入库后调用：登记来源并排队重建图谱。
   * 不 await 抽取过程，上传接口需立即响应；进度通过 sync-status 查询。
   */
  onDocumentsIngested(sources: string[]): void {
    for (const source of sources) {
      this.graph.store.markSource(source, {
        status: "pending",
        chunks: this.rag.listChunks(source).length,
      });
    }
    if (!this.autoExtract) return;
    for (const source of sources) this.enqueue(source);
    void this.drain();
  }

  /**
   * 文档删除后调用：同步清空该来源的图谱数据。
   * 同步执行而非排队——删除必须立刻生效，否则查询会命中已删文档的实体。
   */
  onDocumentRemoved(source: string): { relations: number; entities: number } {
    this.queue = this.queue.filter((s) => s !== source);
    const removed = this.graph.clearSource(source);
    this.logger.log(
      `[lifecycle] removed graph data for "${source}": -${removed.entities} entities, -${removed.relations} relations`,
    );
    return removed;
  }

  /** 知识库与图谱库的一致性快照。 */
  status(): SyncStatus {
    const ragSources = this.rag.listSources().map((source) => ({
      source,
      chunks: this.rag.listChunks(source).length,
    }));
    const diff = this.graph.diff(ragSources);
    // 内存队列中的来源可能尚未落到 building 状态，补进去避免前端误判为缺失
    const building = [...new Set([...diff.building, ...(this.current ? [this.current] : [])])];
    const missing = diff.missing.filter((s) => !building.includes(s));
    return {
      inSync: diff.inSync && this.queue.length === 0 && this.current === null,
      missing,
      stale: diff.stale,
      orphan: diff.orphan,
      building,
      queued: this.queue.length,
      sources: this.graph.listSources(),
      ragSources,
      stats: this.graph.getStats(),
    };
  }

  /**
   * 一键对账修复：清理孤儿来源，重建缺失与过期来源。
   * 同步等待完成（前端点「同步」后需要确定性结果），因此单独走串行循环。
   */
  async reconcile(): Promise<ReconcileResult> {
    const status = this.status();
    const removed: string[] = [];
    const rebuilt: string[] = [];
    const failed: Array<{ source: string; error: string }> = [];

    for (const source of status.orphan) {
      this.graph.clearSource(source);
      removed.push(source);
    }

    for (const source of [...status.missing, ...status.stale]) {
      try {
        await this.rebuild(source);
        rebuilt.push(source);
      } catch (error) {
        failed.push({ source, error: error instanceof Error ? error.message : String(error) });
      }
    }

    this.logger.log(
      `[lifecycle] reconcile done: rebuilt=${rebuilt.length} removed=${removed.length} failed=${failed.length}`,
    );
    return { rebuilt, removed, failed, stats: this.graph.getStats() };
  }

  /** 重建单个来源（先清后建，幂等）。知识库已无该来源时退化为清理。 */
  async rebuild(source: string): Promise<GraphSourceState | null> {
    const chunks = this.rag.listChunks(source).map((c) => ({
      id: c.id,
      source: c.source,
      chunkIndex: c.chunkIndex,
      content: c.content,
    }));
    if (chunks.length === 0) {
      this.graph.clearSource(source);
      return null;
    }
    return this.graph.syncSource(source, chunks);
  }

  /** 等待队列排空，测试与优雅关停用。 */
  async waitIdle(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private enqueue(source: string): void {
    if (!this.queue.includes(source) && this.current !== source) this.queue.push(source);
  }

  /** 串行消费队列；单实例内自旋，重入安全。 */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const source = this.queue.shift()!;
        this.current = source;
        try {
          const state = await this.rebuild(source);
          this.logger.log(
            `[lifecycle] built "${source}": ${state?.entities ?? 0} entities, ${state?.relations ?? 0} relations`,
          );
        } catch (error) {
          // 状态已由 syncSource 置为 failed，此处只记录，不中断后续来源
          this.logger.error(`[lifecycle] build failed for "${source}": ${String(error)}`);
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
