import type {
  ToolCallReservation,
  ToolCallReservationInput,
  ToolCallReservationResult,
  ToolCallSettlement,
} from "./repository.js";

export interface QuotaRepository {
  reserveToolCall(input: ToolCallReservationInput): Promise<ToolCallReservationResult>;
  settleToolCall(input: ToolCallSettlement): Promise<void>;
}

export class GatewayQuotaService {
  readonly #repository: QuotaRepository;
  readonly #now: () => string;
  readonly #onSettlementError: (error: unknown) => void;

  constructor(
    repository: QuotaRepository,
    options: {
      now?: () => string;
      onSettlementError?: (error: unknown) => void;
    } = {},
  ) {
    this.#repository = repository;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onSettlementError =
      options.onSettlementError ??
      ((error) => console.error("Failed to settle MCP tool usage", error));
  }

  async reserve(input: ToolCallReservation): Promise<ToolCallReservationResult> {
    return this.#repository.reserveToolCall({ ...input, now: this.#now() });
  }

  async settle(input: {
    requestId: string;
    status: "SUCCEEDED" | "FAILED";
    durationMs: number;
  }): Promise<void> {
    const finishedAt = this.#now();
    try {
      await this.#repository.settleToolCall({
        requestId: input.requestId,
        status: input.status,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        finishedAt,
      });
    } catch (error) {
      this.#onSettlementError(error);
    }
  }
}
