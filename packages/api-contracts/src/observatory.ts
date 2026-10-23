import type { MessageUsage } from "./chat.js";
import type { GraphExport } from "./graph.js";
export interface ObservatoryColumn {
  name: string;
  type: string;
  comment: string;
}

export interface ObservatoryTable {
  name: string;
  comment: string;
  rows: number;
  columnCount: number;
  columns: ObservatoryColumn[];
}

export interface ObservatoryGraphPayload {
  source: SchemaSourceOption;
  database: string;
  collectedAt: string;
  tables: ObservatoryTable[];
  graph: GraphExport;
  stats: { entities: number; relations: number };
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ObservatoryQueryResult {
  usage?: MessageUsage;
  auditId?: string;
  steps?: QueryStep[];
  sourceId: string;
  question: string;
  intent?: string;
  selectedTables: string[];
  schemaPrompt: string;
  graph: GraphExport;
  seeds: string[];
  formattedGraph: string;
  sql?: string;
  originalQuestion?: string;
  generatedSql?: string;
  turnQuestion?: string;
  executedSql?: string;
  clarification?: Clarification;
  clarifying?: string;
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  error?: string;
  durationMs: number;
}

export interface ClarificationCandidate {
  label: string;
  value: string;
  description?: string;
}

export interface ClarificationSlot {
  key: string;
  label: string;
  raw?: string;
  value?: string;
  candidates: ClarificationCandidate[];
}

export interface Clarification {
  slots: ClarificationSlot[];
  candidates: ClarificationCandidate[];
  originalQuestion: string;
  round: number;
  missingSlots: string[];
  canProceed: boolean;
  clarifying: string;
}

export type QueryAuditStatus = "running" | "succeeded" | "failed" | "clarifying";

export type QueryEntrypoint = "observatory" | "chat" | "workflow" | "rerun" | "unknown";

export type QueryAuditSource = "generated" | "rerun" | "workflow" | "chat" | "clarification";

export type QuerySqlSource = "generated" | "edited" | "original";

export interface QueryStep {
  id: string;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  message?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface QueryAuditSummary {
  id: string;
  sourceId: string | null;
  sourceName: string | null;
  question: string;
  status: QueryAuditStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  rowCount: number | null;
  error: string | null;
  actor: string;
  actorType?: "operator" | "legacy";
  entrypoint: QueryEntrypoint;
  source: QueryAuditSource;
  sqlSource: QuerySqlSource;
  parentAuditId: string | null;
  /** 重跑子审计会带出 SQL；普通摘要为保持体积可省略。 */
  executedSql?: string | null;
  generatedSql?: string | null;
  workspace: string;
}

export interface QueryAuditRecord extends QueryAuditSummary {
  usage?: MessageUsage;
  history: HistoryTurn[];
  steps: QueryStep[];
  selectedTables: string[];
  sql: string | null;
  originalQuestion: string;
  generatedSql: string | null;
  executedSql: string | null;
  clarification: Clarification | null;
  clarifying: string | null;
  providerId: string | null;
  model: string | null;
  resultPreview: Record<string, unknown>[];
}

export interface QueryAuditDetail {
  record: QueryAuditRecord;
  parent: QueryAuditSummary | null;
  children: QueryAuditSummary[];
}

export type QueryProgressEvent =
  | { type: "start"; auditId: string; steps: QueryStep[] }
  | { type: "step"; auditId: string; step: QueryStep }
  | { type: "clarification"; auditId: string; clarification: Clarification };

export interface QueryAuditFilters {
  sourceId?: string;
  actor?: string;
  entrypoint?: QueryEntrypoint;
  source?: QueryAuditSource;
  sqlSource?: QuerySqlSource;
  status?: QueryAuditStatus;
  parentAuditId?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export type SchemaSemanticProfile = "generic" | "oneapi";

export type SchemaSourceConnector = "mysql" | "postgresql";

export type SchemaSourceSyncStatus = "idle" | "syncing" | "ready" | "error";

export interface SchemaSourceOption {
  id: string;
  name: string;
  connector: SchemaSourceConnector;
  databaseName: string | null;
  schemaName: string | null;
  semanticProfile: SchemaSemanticProfile;
  isDefault: boolean;
  managedByEnv: boolean;
  syncStatus: SchemaSourceSyncStatus;
  lastSyncedAt: string | null;
  tableCount: number;
  relationCount: number;
}

export interface SchemaSourceMetadata extends SchemaSourceOption {
  endpoint: string;
  host: string;
  port: number;
  username: string;
  tableFilter: string[];
  enabled: boolean;
  hasCredential: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchemaCatalogPreview {
  sourceId: string;
  database: string;
  collectedAt: string;
  relationCount: number;
  tables: Array<{
    name: string;
    comment: string;
    rows: number;
    columnCount: number;
  }>;
}

export interface SchemaSourceDraft {
  id?: string;
  name: string;
  connector: SchemaSourceConnector;
  connectionString?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  databaseName: string;
  schemaName: string;
  tableFilter: string[];
  semanticProfile: SchemaSemanticProfile;
  enabled: boolean;
}
