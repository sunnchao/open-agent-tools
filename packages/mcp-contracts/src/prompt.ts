import { PromptDefinitionSchema, type PromptDefinition } from "./manifest.js";

const PLACEHOLDER_PATTERN = /\{\{([a-zA-Z][a-zA-Z0-9_-]{0,63})\}\}/g;

export const DEFAULT_MAX_PROMPT_OUTPUT_BYTES = 256 * 1024;

export type PromptRenderErrorCode =
  | "INVALID_ARGUMENT_VALUE"
  | "MISSING_REQUIRED_ARGUMENT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "UNDECLARED_ARGUMENT";

export class PromptRenderError extends Error {
  readonly code: PromptRenderErrorCode;
  readonly argumentName?: string;

  constructor(code: PromptRenderErrorCode, message: string, argumentName?: string) {
    super(message);
    this.name = "PromptRenderError";
    this.code = code;
    this.argumentName = argumentName;
  }
}

export interface RenderPromptOptions {
  maxOutputBytes?: number;
}

export interface RenderedPrompt {
  description?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: {
      type: "text";
      text: string;
    };
  }>;
}

export function renderPrompt(
  definition: PromptDefinition,
  argumentsByName: Record<string, string>,
  options: RenderPromptOptions = {},
): RenderedPrompt {
  const prompt = PromptDefinitionSchema.parse(definition);
  const declaredArguments = new Map(prompt.arguments.map((argument) => [argument.name, argument]));

  for (const [name, value] of Object.entries(argumentsByName)) {
    if (!declaredArguments.has(name)) {
      throw new PromptRenderError(
        "UNDECLARED_ARGUMENT",
        `Prompt argument is not declared: ${name}`,
        name,
      );
    }
    if (typeof value !== "string") {
      throw new PromptRenderError(
        "INVALID_ARGUMENT_VALUE",
        `Prompt argument must be a string: ${name}`,
        name,
      );
    }
  }

  for (const argument of prompt.arguments) {
    if (argument.required && argumentsByName[argument.name] === undefined) {
      throw new PromptRenderError(
        "MISSING_REQUIRED_ARGUMENT",
        `Required Prompt argument is missing: ${argument.name}`,
        argument.name,
      );
    }
  }

  const messages = prompt.messages.map((message) => ({
    role: message.role,
    content: {
      type: "text" as const,
      text: message.content.text.replace(
        PLACEHOLDER_PATTERN,
        (_match, name: string) => argumentsByName[name] ?? "",
      ),
    },
  }));

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_PROMPT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new RangeError("maxOutputBytes must be a positive safe integer");
  }

  const outputBytes = messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content.text, "utf8"),
    0,
  );
  if (outputBytes > maxOutputBytes) {
    throw new PromptRenderError(
      "OUTPUT_LIMIT_EXCEEDED",
      `Rendered Prompt exceeds ${maxOutputBytes} bytes`,
    );
  }

  return {
    ...(prompt.description === undefined ? {} : { description: prompt.description }),
    messages,
  };
}
