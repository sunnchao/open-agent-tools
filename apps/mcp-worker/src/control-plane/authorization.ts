import type { Actor } from "./types.js";

export type ManagementErrorCode =
  | "CONFLICT"
  | "FORBIDDEN"
  | "IMMUTABLE_VERSION"
  | "INVALID_STATE"
  | "NOT_FOUND"
  | "UPSTREAM_ERROR"
  | "VALIDATION_ERROR";

export class ManagementError extends Error {
  readonly code: ManagementErrorCode;
  readonly details?: unknown;

  constructor(code: ManagementErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ManagementError";
    this.code = code;
    this.details = details;
  }
}

export function requireEditor(actor: Actor): void {
  if (actor.role === "auditor") {
    throw new ManagementError("FORBIDDEN", "This operation requires admin or operator access");
  }
}

export function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new ManagementError("FORBIDDEN", "This operation requires admin access");
  }
}
