import { z } from "zod";

export const EnvironmentVariableNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name")
  .refine(
    (name) => !/^(MCP_|NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_|PATH$|HOME$)/.test(name),
    "This environment variable is reserved by the runtime",
  );

const EnvironmentValueSchema = z
  .string()
  .max(8192)
  .refine((value) => !value.includes("\0"), "Environment values cannot contain null bytes");

function withinEnvironmentLimits(environment: Record<string, string | null>): boolean {
  const entries = Object.entries(environment);
  const encoder = new TextEncoder();
  return (
    entries.length <= 64 &&
    entries.reduce(
      (size, [name, value]) => size + name.length + encoder.encode(value ?? "").length + 2,
      0,
    ) <= 65_536
  );
}

export const ToolEnvironmentSchema = z
  .record(EnvironmentVariableNameSchema, EnvironmentValueSchema)
  .refine(withinEnvironmentLimits, "Environment exceeds the variable count or size limit");

// A null value retains a saved value; omitted names are removed.
export const ToolEnvironmentUpdateSchema = z
  .record(EnvironmentVariableNameSchema, EnvironmentValueSchema.nullable())
  .refine(withinEnvironmentLimits, "Environment exceeds the variable count or size limit");
