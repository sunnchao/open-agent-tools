import type { DocumentMetadataPatch } from "@open-agent-tools/rag";
import type { QueryFeedbackRating } from "./analytics.js";

export function documentMetadataPatch(value: unknown): DocumentMetadataPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("document metadata must be an object");
  }
  const body = value as Record<string, unknown>;
  const patch: DocumentMetadataPatch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160) {
      throw new Error("title must contain 1-160 characters");
    }
    patch.title = body.title.trim();
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 20) {
      throw new Error("tags must be an array with at most 20 items");
    }
    const tags: string[] = [];
    for (const item of body.tags) {
      if (typeof item !== "string" || !item.trim() || item.trim().length > 40) {
        throw new Error("each tag must contain 1-40 characters");
      }
      const tag = item.trim();
      if (!tags.includes(tag)) tags.push(tag);
    }
    patch.tags = tags;
  }
  if (body.allowedGroups !== undefined) {
    patch.allowedGroups = accessGroups(body.allowedGroups);
  }
  if (patch.title === undefined && patch.tags === undefined && patch.allowedGroups === undefined) {
    throw new Error("title, tags or allowedGroups is required");
  }
  return patch;
}

/** 文档可见分组：空数组表示公开；最多 50 个、每个 1-60 字符。 */
export function accessGroups(value: unknown, field = "allowedGroups"): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`${field} must be an array with at most 50 items`);
  }
  const groups: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.trim().length > 60 ||
      item.trim() === "*"
    ) {
      if (typeof item === "string" && item.trim() === "*") {
        throw new Error(`${field} cannot contain "*"`);
      }
      throw new Error(`each ${field} item must contain 1-60 characters`);
    }
    const group = item.trim();
    if (!groups.includes(group)) groups.push(group);
  }
  return groups;
}

export function queryFeedback(value: unknown): {
  rating: QueryFeedbackRating;
  comment?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("feedback must be an object");
  }
  const body = value as Record<string, unknown>;
  if (body.rating !== "positive" && body.rating !== "negative") {
    throw new Error("rating must be positive or negative");
  }
  if (body.comment !== undefined && typeof body.comment !== "string") {
    throw new Error("comment must be a string");
  }
  const comment = typeof body.comment === "string" ? body.comment.trim() : undefined;
  if (comment && comment.length > 500) throw new Error("comment must be at most 500 characters");
  return { rating: body.rating, ...(comment ? { comment } : {}) };
}
