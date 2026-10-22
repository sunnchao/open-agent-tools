import type { Rag } from "@open-agent-tools/rag";
import type { GraphSourceState, KnowledgeGraph } from "@open-agent-tools/rag/graph";
import {
  CragController,
  createBlockDomain,
  createGraphDomain,
  HeuristicRetrievalEvaluator,
} from "@open-agent-tools/rag/crag";
import { AsyncResource } from "node:async_hooks";

export interface KnowledgeBaseOptions {
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
 * 知识库服务：统一文档入库、图谱派生、CRAG 检索与对账。
 * 图谱按来源串行重建；任务绑定上传时的异步上下文，保留工作区用量归属。
 */
export class KnowledgeBase {
  readonly rag: Rag;
  readonly graph: KnowledgeGraph;
  readonly crag: CragController;
  private autoExtract: boolean;
  private logger: Pick<Console, "log" | "error">;
  /** 待抽取队列（去重），配合 running 标志实现串行消费。 */
  private queue: string[] = [];
  private jobs = new Map<string, () => Promise<GraphSourceState | null>>();
  private running = false;
  /** 当前正在抽取的来源，对账时归入 building。 */
  private current: string | null = null;

  constructor(opts: KnowledgeBaseOptions) {
    this.rag = opts.rag;
    this.graph = opts.graph;
    this.autoExtract = opts.autoExtract ?? true;
    this.logger = opts.logger ?? console;
    this.crag = new CragController({
      evaluator: new HeuristicRetrievalEvaluator(),
      domains: [
        createBlockDomain({
          // 图谱由独立 CRAG 域补充，block 域关闭图谱以免重复计入证据。
          retrieve: (query, options) => this.rag.retrieve(query, { ...options, graph: false }),
        }),
        createGraphDomain({ retrieve: (query, options) => this.graph.retrieve(query, options) }),
      ],
      maxRetries: 1,
    });
  }

  /** 入库成功后登记图谱状态并异步排队；上传无需等待抽取完成。 */
  async ingestBuffers(...args: Parameters<Rag["ingestBuffers"]>): ReturnType<Rag["ingestBuffers"]> {
    const result = await this.rag.ingestBuffers(...args);
    const counts = new Map(
      (await this.rag.listDocuments()).map((document) => [document.source, document.chunks]),
    );
    for (const source of result.sources) {
      this.graph.store.markSource(source, {
        status: "pending",
        chunks: counts.get(source) ?? 0,
      });
    }
    if (this.autoExtract) {
      for (const source of result.sources) this.enqueue(source);
      void this.drain();
    }
    return result;
  }

  /** 删除知识文档时立即清理图谱及待处理任务，避免继续检索已删内容。 */
  async clearSource(source: string): Promise<{ relations: number; entities: number }> {
    await this.rag.clearSource(source);
    this.queue = this.queue.filter((s) => s !== source);
    this.jobs.delete(source);
    const removed = this.graph.clearSource(source);
    this.logger.log(
      `[lifecycle] removed graph data for "${source}": -${removed.entities} entities, -${removed.relations} relations`,
    );
    return removed;
  }

  /** 知识库与图谱库的一致性快照（ES 后端下需 await）。 */
  async status(): Promise<SyncStatus> {
    const documents = await this.rag.listDocuments();
    const ragSources = documents
      .map(({ source, chunks }) => ({ source, chunks }))
      .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
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
    const status = await this.status();
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
    const chunks = await this.rag.listChunks(source);
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
    if (!this.queue.includes(source) && this.current !== source) {
      this.queue.push(source);
      this.jobs.set(
        source,
        AsyncResource.bind(() => this.rebuild(source)),
      );
    }
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
          const rebuild = this.jobs.get(source)!;
          this.jobs.delete(source);
          const state = await rebuild();
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
