import type { MessageUsage } from "./chat.js";
export interface GraphNode {
  id: string;
  name: string;
  type: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relType: string;
  weight: number;
}

export interface GraphExport {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { entities: number; relations: number };
}

export interface DocumentGraph extends GraphExport {
  nodes: EntityInfo[];
}

export interface EntityInfo extends GraphNode {
  props: Record<string, string>;
}

export interface GraphRetrieveResult {
  usage?: MessageUsage;
  query: string;
  seeds: Array<{ id: string; name: string; type: string }>;
  formatted: string;
  subgraph: GraphExport | null;
}

export interface GraphSourceState {
  source: string;
  status: "pending" | "building" | "ready" | "failed";
  entities: number;
  relations: number;
  chunks: number;
  updatedAt: string;
  error?: string;
}

export interface SyncStatus {
  usage?: MessageUsage;
  inSync: boolean;
  missing: string[];
  stale: string[];
  orphan: string[];
  building: string[];
  /** 卡在 building 超过阈值（进程重启后残留），点同步可复位并重建。 */
  stuck: string[];
  queued: number;
  sources: GraphSourceState[];
  ragSources: Array<{ source: string; chunks: number }>;
  stats: { entities: number; relations: number };
}

export interface ReconcileResult {
  usage?: MessageUsage;
  rebuilt: string[];
  removed: string[];
  failed: Array<{ source: string; error: string }>;
  status: SyncStatus;
}

export interface EntityListResult {
  entities: EntityInfo[];
  stats: { entities: number; relations: number };
}

export interface RelationTypeStat {
  relType: string;
  count: number;
}
