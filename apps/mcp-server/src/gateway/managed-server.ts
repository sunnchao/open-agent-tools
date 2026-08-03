import { randomUUID } from "node:crypto";
import { renderPrompt, PromptRenderError } from "@open-agent-tools/mcp-contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AuthorizedService } from "./access.js";
import type { ToolExecutor } from "./tool-executor.js";

export interface ManagedMcpServerOptions {
  executor?: ToolExecutor;
  createRequestId?: () => string;
  now?: () => string;
}

export function createManagedMcpServer(
  authorized: AuthorizedService,
  options: ManagedMcpServerOptions = {},
): McpServer {
  const capabilities = {
    ...(authorized.snapshot.tools.length === 0 ? {} : { tools: {} }),
    ...(authorized.snapshot.prompts.length === 0 ? {} : { prompts: {} }),
  };
  const server = new McpServer(
    {
      name: authorized.snapshot.serviceSlug,
      version: authorized.snapshot.versionId,
    },
    { capabilities },
  );

  if (authorized.snapshot.tools.length > 0) {
    registerToolHandlers(server, authorized, options);
  }

  if (authorized.snapshot.prompts.length > 0) {
    server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      requireScope(authorized, "prompts:list");
      return {
        prompts: authorized.snapshot.prompts
          .filter(
            (prompt) => authorized.promptNames === null || authorized.promptNames.has(prompt.name),
          )
          .map((prompt) => ({
            name: prompt.name,
            ...(prompt.title === undefined ? {} : { title: prompt.title }),
            ...(prompt.description === undefined ? {} : { description: prompt.description }),
            ...(prompt.arguments.length === 0 ? {} : { arguments: prompt.arguments }),
          })),
      };
    });

    server.server.setRequestHandler(
      GetPromptRequestSchema,
      async (request): Promise<GetPromptResult> => {
        requireScope(authorized, "prompts:get");
        const prompt = authorized.snapshot.prompts.find(
          (candidate) =>
            candidate.name === request.params.name &&
            (authorized.promptNames === null || authorized.promptNames.has(candidate.name)),
        );
        if (!prompt) {
          throw new McpError(ErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
        }

        try {
          const rendered = renderPrompt(prompt, request.params.arguments ?? {});
          return {
            ...(rendered.description === undefined ? {} : { description: rendered.description }),
            messages: rendered.messages,
          };
        } catch (error) {
          if (error instanceof PromptRenderError) {
            throw new McpError(
              ErrorCode.InvalidParams,
              error.argumentName
                ? `Invalid Prompt argument: ${error.argumentName}`
                : "Invalid Prompt output",
            );
          }
          throw error;
        }
      },
    );
  }

  return server;
}

function registerToolHandlers(
  server: McpServer,
  authorized: AuthorizedService,
  options: ManagedMcpServerOptions,
): void {
  const validators = toolValidators(authorized);

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    requireScope(authorized, "tools:list");
    return {
      tools: authorized.snapshot.tools
        .filter((tool) => authorized.toolNames === null || authorized.toolNames.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema,
        })),
    };
  });

  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      requireScope(authorized, "tools:call");
      const tool = authorized.snapshot.tools.find(
        (candidate) =>
          candidate.name === request.params.name &&
          (authorized.toolNames === null || authorized.toolNames.has(candidate.name)),
      );
      if (!tool) {
        throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
      }

      const validate = validators.get(tool.name);
      if (validate === null || validate === undefined) {
        throw new McpError(ErrorCode.InternalError, "Published Tool schema is unavailable");
      }
      const argumentsValue = request.params.arguments ?? {};
      if (!validate(argumentsValue)) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid Tool arguments");
      }

      const requestId = (options.createRequestId ?? randomUUID)();
      const imageDigest = authorized.snapshot.imageDigest;
      const limits = authorized.snapshot.limits;
      if (!options.executor || imageDigest === null || limits === null) {
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution is unavailable (requestId: ${requestId})`,
        );
      }

      try {
        return await options.executor.execute({
          requestId,
          serviceId: authorized.snapshot.serviceId,
          versionId: authorized.snapshot.versionId,
          imageDigest,
          toolName: tool.name,
          arguments: argumentsValue,
          context: {
            clientId: authorized.clientId,
            deadlineAt: new Date(
              Date.parse((options.now ?? (() => new Date().toISOString()))()) + limits.timeoutMs,
            ).toISOString(),
          },
          limits,
        });
      } catch {
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed (requestId: ${requestId})`,
        );
      }
    },
  );
}

function toolValidators(authorized: AuthorizedService): Map<string, ValidateFunction | null> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return new Map(
    authorized.snapshot.tools.map((tool) => {
      try {
        return [tool.name, ajv.compile(tool.inputSchema)] as const;
      } catch {
        return [tool.name, null] as const;
      }
    }),
  );
}

function requireScope(
  authorized: AuthorizedService,
  scope: "prompts:list" | "prompts:get" | "tools:list" | "tools:call",
): void {
  if (!authorized.scopes.has(scope)) {
    throw new McpError(ErrorCode.InvalidRequest, `Forbidden: missing scope ${scope}`);
  }
}
