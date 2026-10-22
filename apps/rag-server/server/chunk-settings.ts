import type { ChunkStrategy } from "@open-agent-tools/rag";

export const MAX_SEPARATORS = 20;
export const MAX_SEPARATOR_LENGTH = 32;

export interface ChunkSettings {
  chunkSize: number;
  chunkOverlap: number;
  chunkStrategy: ChunkStrategy;
  separators: string[];
  semanticThreshold: number;
}

export function uploadChunkSettings(
  body: Record<string, unknown>,
  defaults: ChunkSettings,
): ChunkSettings {
  const requestedSize = Number(body.chunkSize);
  const requestedOverlap = Number(body.chunkOverlap);
  const chunkSize = Math.max(
    100,
    Math.min(4000, Number.isFinite(requestedSize) ? requestedSize : defaults.chunkSize),
  );
  return {
    chunkSize,
    chunkOverlap: Math.max(
      0,
      Math.min(
        chunkSize - 1,
        Number.isFinite(requestedOverlap) ? requestedOverlap : defaults.chunkOverlap,
      ),
    ),
    chunkStrategy: parseChunkStrategy(body.chunkStrategy, defaults.chunkStrategy),
    separators: parseSeparators(body.separators, defaults.separators),
    semanticThreshold: parseSemanticThreshold(body.semanticThreshold, defaults.semanticThreshold),
  };
}

export function parseSeparators(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined || value === null) return [...fallback];

  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("separators must be a JSON string array");
    }
  }
  if (!Array.isArray(parsed)) throw new Error("separators must be a JSON string array");
  if (parsed.length === 0 || parsed.length > MAX_SEPARATORS) {
    throw new Error(`separators must contain 1-${MAX_SEPARATORS} items`);
  }

  const separators: string[] = [];
  for (const separator of parsed) {
    if (typeof separator !== "string" || separator.length === 0) {
      throw new Error("each separator must be a non-empty string");
    }
    if (Array.from(separator).length > MAX_SEPARATOR_LENGTH) {
      throw new Error(`each separator must be at most ${MAX_SEPARATOR_LENGTH} characters`);
    }
    if (!separators.includes(separator)) separators.push(separator);
  }
  return separators;
}

export function parseChunkStrategy(
  value: unknown,
  fallback: ChunkStrategy = "fixed",
): ChunkStrategy {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "fixed" || value === "semantic") return value;
  throw new Error("chunkStrategy must be fixed or semantic");
}

export function parseSemanticThreshold(value: unknown, fallback = 0.75): number {
  if (value === undefined || value === null || value === "") return fallback;
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("semanticThreshold must be a number between 0 and 1");
  }
  return threshold;
}
