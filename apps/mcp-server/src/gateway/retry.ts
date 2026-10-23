/** Return the HTTP Retry-After delay in whole seconds, never less than one. */
export function retryAfterSeconds(targetMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((targetMs - nowMs) / 1_000));
}
