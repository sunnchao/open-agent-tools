import { z } from "zod";

const CAPABILITY_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const HANDLER_NAME_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const PLACEHOLDER_PATTERN = /\{\{([a-zA-Z][a-zA-Z0-9_-]{0,63})\}\}/g;
const UTF8_ENCODER = new TextEncoder();

export const MAX_PROMPT_TEMPLATE_BYTES = 64 * 1024;

export const CapabilityNameSchema = z
  .string()
  .regex(CAPABILITY_NAME_PATTERN, "Invalid capability name");

const DescriptionSchema = z.string().max(2_000);

const JsonObjectSchema = z.record(z.string(), z.unknown()).superRefine((schema, context) => {
  if (schema.type !== "object") {
    context.addIssue({
      code: "custom",
      message: "Tool inputSchema.type must be object",
      path: ["type"],
    });
  }

  if (
    schema.properties !== undefined &&
    (typeof schema.properties !== "object" ||
      schema.properties === null ||
      Array.isArray(schema.properties))
  ) {
    context.addIssue({
      code: "custom",
      message: "Tool inputSchema.properties must be an object",
      path: ["properties"],
    });
  }

  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string"))
  ) {
    context.addIssue({
      code: "custom",
      message: "Tool inputSchema.required must contain property names",
      path: ["required"],
    });
  }
});

export const ManagedToolSchema = z
  .object({
    name: CapabilityNameSchema,
    description: DescriptionSchema.optional(),
    handler: z.string().regex(HANDLER_NAME_PATTERN, "Invalid JavaScript handler export name"),
    inputSchema: JsonObjectSchema,
  })
  .strict();

export const PromptArgumentSchema = z
  .object({
    name: CapabilityNameSchema,
    description: DescriptionSchema.optional(),
    required: z.boolean().default(false),
  })
  .strict();

export const PromptMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z
      .object({
        type: z.literal("text"),
        text: z.string().min(1),
      })
      .strict(),
  })
  .strict();

function templatePlaceholders(template: string): string[] | null {
  const placeholders: string[] = [];
  const unmatched = template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    placeholders.push(name);
    return "";
  });

  if (unmatched.includes("{{") || unmatched.includes("}}")) {
    return null;
  }

  return placeholders;
}

export const PromptDefinitionSchema = z
  .object({
    name: CapabilityNameSchema,
    title: z.string().min(1).max(200).optional(),
    description: DescriptionSchema.optional(),
    arguments: z.array(PromptArgumentSchema).default([]),
    messages: z.array(PromptMessageSchema).min(1),
  })
  .strict()
  .superRefine((prompt, context) => {
    const declaredArguments = new Set<string>();

    for (const [index, argument] of prompt.arguments.entries()) {
      if (declaredArguments.has(argument.name)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate Prompt argument: ${argument.name}`,
          path: ["arguments", index, "name"],
        });
      }
      declaredArguments.add(argument.name);
    }

    let templateBytes = 0;
    for (const [index, message] of prompt.messages.entries()) {
      templateBytes += UTF8_ENCODER.encode(message.content.text).byteLength;
      const placeholders = templatePlaceholders(message.content.text);

      if (placeholders === null) {
        context.addIssue({
          code: "custom",
          message: "Only exact {{argumentName}} placeholders are supported",
          path: ["messages", index, "content", "text"],
        });
        continue;
      }

      for (const placeholder of placeholders) {
        if (!declaredArguments.has(placeholder)) {
          context.addIssue({
            code: "custom",
            message: `Undeclared Prompt argument: ${placeholder}`,
            path: ["messages", index, "content", "text"],
          });
        }
      }
    }

    if (templateBytes > MAX_PROMPT_TEMPLATE_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Prompt template exceeds ${MAX_PROMPT_TEMPLATE_BYTES} bytes`,
        path: ["messages"],
      });
    }
  });

export const NodeRuntimeSchema = z
  .object({
    name: z.literal("nodejs"),
    version: z.literal("20"),
  })
  .strict();

export const BuildConfigurationSchema = z
  .object({
    command: z.literal("npm run build"),
  })
  .strict();

export const ExecutionLimitsSchema = z
  .object({
    timeoutMs: z.number().int().min(1).max(120_000),
    memoryMb: z.number().int().min(32).max(4_096),
    cpuMillis: z.number().int().min(10).max(8_000),
    network: z.literal("none"),
  })
  .strict();

function isSafeJavaScriptEntry(entry: string): boolean {
  if (entry.startsWith("/") || entry.includes("\\") || !entry.endsWith(".js")) {
    return false;
  }

  const segments = entry.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const ManagedMcpManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtime: NodeRuntimeSchema.optional(),
    entry: z.string().refine(isSafeJavaScriptEntry, "Invalid JavaScript entry path").optional(),
    build: BuildConfigurationSchema.optional(),
    tools: z.array(ManagedToolSchema).default([]),
    prompts: z.array(PromptDefinitionSchema).default([]),
    limits: ExecutionLimitsSchema.optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.tools.length === 0 && manifest.prompts.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one Tool or Prompt is required",
      });
    }

    const requiredToolFields = ["runtime", "entry", "limits"] as const;
    if (manifest.tools.length > 0) {
      for (const field of requiredToolFields) {
        if (manifest[field] === undefined) {
          context.addIssue({
            code: "custom",
            message: `${field} is required when Tools are configured`,
            path: [field],
          });
        }
      }
    } else {
      for (const field of [...requiredToolFields, "build"] as const) {
        if (manifest[field] !== undefined) {
          context.addIssue({
            code: "custom",
            message: `${field} is not allowed for a Prompt-only manifest`,
            path: [field],
          });
        }
      }
    }

    if (manifest.build !== undefined && manifest.entry === undefined) {
      context.addIssue({
        code: "custom",
        message: "entry is required when build is configured",
        path: ["entry"],
      });
    }

    for (const [field, capabilities] of [
      ["tools", manifest.tools],
      ["prompts", manifest.prompts],
    ] as const) {
      const names = new Set<string>();
      for (const [index, capability] of capabilities.entries()) {
        if (names.has(capability.name)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ${field} name: ${capability.name}`,
            path: [field, index, "name"],
          });
        }
        names.add(capability.name);
      }
    }
  });

export type ManagedMcpManifest = z.infer<typeof ManagedMcpManifestSchema>;
export type ManagedTool = z.infer<typeof ManagedToolSchema>;
export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;
export type PromptDefinition = z.infer<typeof PromptDefinitionSchema>;
export type PromptMessage = z.infer<typeof PromptMessageSchema>;
