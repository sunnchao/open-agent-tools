import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AuditEventQuery, AuditEventRecord, AuditRepository } from "./audit-repository.js";
import { ManagementError } from "./management.js";
import type { Actor } from "./types.js";

export interface AuditServiceOptions {
  createId?: () => string;
  now?: () => string;
  onError?: (error: unknown) => void;
}

export interface HttpAuditInput {
  actor: Actor;
  method: string;
  route: string;
  target: string;
  requestId?: string;
  statusCode: number;
  durationMs: number;
}

const QuerySchema = z
  .object({
    limit: z.number().int().min(1).max(200),
    outcome: z.enum(["SUCCEEDED", "FAILED"]).optional(),
    action: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export class AuditService {
  readonly #repository: AuditRepository;
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #onError: (error: unknown) => void;
  #pending: Promise<void> = Promise.resolve();

  constructor(repository: AuditRepository, options: AuditServiceOptions = {}) {
    this.#repository = repository;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onError =
      options.onError ?? ((error) => console.error("Failed to write audit event", error));
  }

  recordHttp(input: HttpAuditInput): Promise<void> {
    const event: AuditEventRecord = {
      id: this.#createId(),
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: `${input.method.toUpperCase()} ${input.route}`.slice(0, 180),
      target: input.target.slice(0, 2_000),
      requestId: (input.requestId?.trim() || this.#createId()).slice(0, 120),
      outcome: input.statusCode < 400 ? "SUCCEEDED" : "FAILED",
      statusCode: input.statusCode,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      createdAt: this.#now(),
    };
    this.#pending = this.#pending
      .then(() => this.#repository.create(event))
      .catch((error) => this.#onError(error));
    return this.#pending;
  }

  async list(query: AuditEventQuery, actor: Actor): Promise<AuditEventRecord[]> {
    if (actor.role === "operator") {
      throw new ManagementError("FORBIDDEN", "Audit events require admin or auditor access");
    }
    const parsed = QuerySchema.parse(query);
    await this.#pending;
    return this.#repository.list(parsed);
  }
}
