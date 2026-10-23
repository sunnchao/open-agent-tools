import { getDefaultSchemaSource, getSchemaSource, type SchemaSourceWithSecret } from "./store.js";

export function resolveSchemaSource(sourceId?: string): SchemaSourceWithSecret {
  const source = sourceId
    ? getSchemaSource(sourceId, { requireEnabled: true })
    : getDefaultSchemaSource({ requireEnabled: true });
  if (!source) {
    throw new Error(
      sourceId ? "schema source not found or disabled" : "no enabled schema source configured",
    );
  }
  return source;
}
