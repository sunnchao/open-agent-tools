import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ManagedMcpManifestSchema,
  ToolRunnerInputSchema,
  type ToolRunnerInput,
} from "@open-agent-tools/mcp-contracts";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export type RunnerErrorCode =
  | "HANDLER_FAILED"
  | "HANDLER_NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_MANIFEST"
  | "INVALID_RESULT"
  | "MODULE_LOAD_FAILED"
  | "OUTPUT_LIMIT"
  | "TOOL_NOT_FOUND";

class RunnerFailure extends Error {
  constructor(public readonly code: RunnerErrorCode) {
    super(code);
    this.name = "RunnerFailure";
  }
}

export interface RunToolInvocationOptions {
  packageRoot: string;
  inputPath: string;
  outputPath: string;
  maxOutputBytes?: number;
}

interface HandlerModule {
  handlers?: Record<string, unknown>;
}

function parseJson(contents: string, code: RunnerErrorCode): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new RunnerFailure(code);
  }
}

function requirePlainJsonValue(root: unknown): void {
  const pending: unknown[] = [root];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      continue;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) continue;
      throw new RunnerFailure("INVALID_RESULT");
    }
    if (typeof value !== "object") {
      throw new RunnerFailure("INVALID_RESULT");
    }
    if (visited.has(value)) {
      throw new RunnerFailure("INVALID_RESULT");
    }
    visited.add(value);

    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw new RunnerFailure("INVALID_RESULT");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new RunnerFailure("INVALID_RESULT");
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (isArray && key === "length") continue;
      if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new RunnerFailure("INVALID_RESULT");
      }
      pending.push(descriptor.value);
    }

    if (isArray) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new RunnerFailure("INVALID_RESULT");
        }
      }
    }
  }
}

function validateHandlerResult(value: unknown): CallToolResult {
  requirePlainJsonValue(value);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "content") ||
    !Array.isArray((value as { content?: unknown }).content)
  ) {
    throw new RunnerFailure("INVALID_RESULT");
  }

  const parsed = CallToolResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new RunnerFailure("INVALID_RESULT");
  }

  return { ...parsed.data, isError: parsed.data.isError ?? false };
}

function toolContext(input: ToolRunnerInput): Readonly<Record<string, string>> {
  return Object.freeze({ requestId: input.requestId, ...input.context });
}

async function executeInvocation(
  packageRoot: string,
  input: ToolRunnerInput,
): Promise<CallToolResult> {
  let manifestContents: string;
  try {
    manifestContents = await readFile(resolve(packageRoot, "mcp.json"), "utf8");
  } catch {
    throw new RunnerFailure("INVALID_MANIFEST");
  }
  const manifestResult = ManagedMcpManifestSchema.safeParse(
    parseJson(manifestContents, "INVALID_MANIFEST"),
  );
  if (!manifestResult.success || manifestResult.data.entry === undefined) {
    throw new RunnerFailure("INVALID_MANIFEST");
  }

  const tool = manifestResult.data.tools.find((candidate) => candidate.name === input.toolName);
  if (tool === undefined) {
    throw new RunnerFailure("TOOL_NOT_FOUND");
  }

  let entryModule: HandlerModule;
  try {
    entryModule = (await import(
      pathToFileURL(resolve(packageRoot, ...manifestResult.data.entry.split("/"))).href
    )) as HandlerModule;
  } catch {
    throw new RunnerFailure("MODULE_LOAD_FAILED");
  }

  let handler: unknown;
  try {
    handler = entryModule.handlers?.[tool.handler];
  } catch {
    throw new RunnerFailure("HANDLER_NOT_FOUND");
  }
  if (typeof handler !== "function") {
    throw new RunnerFailure("HANDLER_NOT_FOUND");
  }

  let handlerResult: unknown;
  try {
    handlerResult = await handler(input.arguments, toolContext(input));
  } catch {
    throw new RunnerFailure("HANDLER_FAILED");
  }

  try {
    return validateHandlerResult(handlerResult);
  } catch (error) {
    if (error instanceof RunnerFailure) throw error;
    throw new RunnerFailure("INVALID_RESULT");
  }
}

function safeErrorResult(code: RunnerErrorCode, requestId?: string): CallToolResult {
  return {
    content: [{ type: "text", text: "Tool execution failed." }],
    isError: true,
    _meta: {
      "open-agent-tools/error": {
        code,
        ...(requestId === undefined ? {} : { requestId }),
      },
    },
  };
}

function serializeResult(result: CallToolResult): Buffer {
  return Buffer.from(JSON.stringify(result), "utf8");
}

export async function runToolInvocation(options: RunToolInvocationOptions): Promise<void> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 256) {
    throw new TypeError("maxOutputBytes must be an integer of at least 256 bytes");
  }

  let result: CallToolResult;
  let requestId: string | undefined;
  try {
    const inputResult = ToolRunnerInputSchema.safeParse(
      parseJson(await readFile(options.inputPath, "utf8"), "INVALID_INPUT"),
    );
    if (!inputResult.success) {
      throw new RunnerFailure("INVALID_INPUT");
    }
    requestId = inputResult.data.requestId;
    result = await executeInvocation(options.packageRoot, inputResult.data);
  } catch (error) {
    const code = error instanceof RunnerFailure ? error.code : "INVALID_INPUT";
    result = safeErrorResult(code, requestId);
  }

  let output = serializeResult(result);
  if (output.byteLength > maxOutputBytes) {
    output = serializeResult(safeErrorResult("OUTPUT_LIMIT", requestId));
  }
  if (output.byteLength > maxOutputBytes) {
    throw new RunnerFailure("OUTPUT_LIMIT");
  }

  await writeFile(options.outputPath, output, { flag: "wx", mode: 0o600 });
}
