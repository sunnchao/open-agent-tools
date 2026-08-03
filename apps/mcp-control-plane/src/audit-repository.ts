export type AuditOutcome = "SUCCEEDED" | "FAILED";

export interface AuditEventRecord {
  id: string;
  actorId: string;
  actorRole: "admin" | "operator" | "auditor";
  action: string;
  target: string;
  requestId: string;
  outcome: AuditOutcome;
  statusCode: number;
  durationMs: number;
  createdAt: string;
}

export interface AuditEventQuery {
  limit: number;
  outcome?: AuditOutcome;
  action?: string;
}

export interface AuditRepository {
  create(event: AuditEventRecord): Promise<void>;
  list(query: AuditEventQuery): Promise<AuditEventRecord[]>;
}

export class InMemoryAuditRepository implements AuditRepository {
  readonly events: AuditEventRecord[] = [];

  async create(event: AuditEventRecord): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async list(query: AuditEventQuery): Promise<AuditEventRecord[]> {
    return this.events
      .filter((event) => !query.outcome || event.outcome === query.outcome)
      .filter(
        (event) => !query.action || event.action.toLowerCase().includes(query.action.toLowerCase()),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, query.limit)
      .map((event) => structuredClone(event));
  }
}
