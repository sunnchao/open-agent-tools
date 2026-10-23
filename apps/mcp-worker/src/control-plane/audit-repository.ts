import type { AuditEvent } from "@open-agent-tools/observability/audit";

export type AuditOutcome = "SUCCEEDED" | "FAILED";
export type AuditEventRecord = AuditEvent;
export type AuditEventSummary = Omit<AuditEventRecord, "input" | "output" | "context">;

export interface AuditEventQuery {
  limit: number;
  outcome?: AuditOutcome;
  action?: string;
}

export interface AuditRepository {
  create(event: AuditEventRecord): Promise<void>;
  list(query: AuditEventQuery): Promise<AuditEventSummary[]>;
  get(id: string): Promise<AuditEventRecord | null>;
  getMany(ids: readonly string[]): Promise<AuditEventRecord[]>;
}

export class InMemoryAuditRepository implements AuditRepository {
  readonly events: AuditEventRecord[] = [];

  async create(event: AuditEventRecord): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async list(query: AuditEventQuery): Promise<AuditEventSummary[]> {
    return this.events
      .filter((event) => !query.outcome || event.outcome === query.outcome)
      .filter(
        (event) => !query.action || event.action.toLowerCase().includes(query.action.toLowerCase()),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, query.limit)
      .map(({ input: _input, output: _output, context: _context, ...event }) =>
        structuredClone(event),
      );
  }

  async get(id: string): Promise<AuditEventRecord | null> {
    const event = this.events.find((item) => item.id === id);
    return event ? structuredClone(event) : null;
  }

  async getMany(ids: readonly string[]): Promise<AuditEventRecord[]> {
    const byId = new Map(this.events.map((event) => [event.id, event]));
    return ids.flatMap((id) => {
      const event = byId.get(id);
      return event ? [structuredClone(event)] : [];
    });
  }
}
