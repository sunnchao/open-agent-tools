import {
  hasRunDeclarations,
  runVariables,
  prepareRunInputs,
  type RunVariable,
} from "@open-agent-tools/workflow-contracts";
import { graphToRunNodes } from "./types.js";
import type { WorkflowGraph } from "./types.js";

interface InputBinding {
  name?: unknown;
  required?: unknown;
  source?: { type?: unknown; variable?: unknown };
}

interface OutputBinding {
  name?: unknown;
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function deriveWorkflowSchemas(graph: WorkflowGraph): {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
} {
  const inputProperties: Record<string, unknown> = {};
  const inputRequired = new Set<string>();
  const outputProperties: Record<string, unknown> = {};

  for (const node of graph.nodes) {
    const inputs = Array.isArray(node.data.config?.inputs)
      ? (node.data.config.inputs as InputBinding[])
      : [];
    for (const binding of inputs) {
      if (
        binding.source?.type !== "run" ||
        typeof binding.source.variable !== "string" ||
        !binding.source.variable.trim()
      ) {
        continue;
      }
      const variable = binding.source.variable.trim();
      inputProperties[variable] = {
        description:
          typeof binding.name === "string" && binding.name.trim()
            ? `Workflow input for ${binding.name.trim()}`
            : "Workflow input",
      };
      if (binding.required !== false) inputRequired.add(variable);
    }

    if (node.data.kind !== "end") continue;
    const outputs = Array.isArray(node.data.config?.outputs)
      ? (node.data.config.outputs as OutputBinding[])
      : [];
    for (const output of outputs) {
      if (typeof output.name === "string" && output.name.trim()) {
        outputProperties[output.name.trim()] = {};
      }
    }
  }

  const nodes = graphToRunNodes(graph);
  if (hasRunDeclarations(nodes)) {
    for (const key of Object.keys(inputProperties)) delete inputProperties[key];
    inputRequired.clear();
    for (const variable of runVariables(nodes)) {
      Object.defineProperty(inputProperties, variable.name, {
        enumerable: true,
        configurable: true,
        value: {
          ...(variable.type !== "any" ? { type: variable.type } : {}),
          ...(variable.defaultValue !== undefined ? { default: variable.defaultValue } : {}),
        },
      });
      if (variable.required !== false && variable.defaultValue === undefined)
        inputRequired.add(variable.name);
    }
  }
  return {
    inputSchema: objectSchema(inputProperties, [...inputRequired]),
    outputSchema: objectSchema(outputProperties, Object.keys(outputProperties)),
  };
}

export function validatePublishedInputs(
  schema: Record<string, unknown>,
  inputs: Record<string, unknown>,
): string[] {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const variables = Object.entries(properties).map(([name, value]) => {
    const property = value as { type?: RunVariable["type"]; default?: unknown };
    return {
      name,
      type: property.type ?? "any",
      required: required.includes(name),
      defaultValue: property.default,
    };
  });
  const typed = prepareRunInputs(variables, inputs).errors;
  const unknown = Object.keys(inputs)
    .filter((name) => !Object.hasOwn(properties, name))
    .map((name) => `input ${name} is not declared`);
  return [...unknown, ...typed];
}

export function collectWorkflowOutputs(
  graph: WorkflowGraph,
  nodeOutputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const node of graph.nodes) {
    if (node.data.kind !== "end") continue;
    Object.assign(result, nodeOutputs[node.id] ?? {});
  }
  return result;
}

export function createWorkflowOpenApi(
  origin: string,
  slug: string,
  name: string,
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: `${name} Workflow API`,
      version: "1.0.0",
      description: "Run the currently published workflow version.",
    },
    servers: [{ url: origin }],
    paths: {
      [`/v1/workflows/${slug}/run`]: {
        post: {
          operationId: "runWorkflow",
          summary: `Run ${name}`,
          security: [{ WorkflowApiKey: [] }],
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", maxLength: 200 },
              description: "Prevents duplicate workflow runs for the same request.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["inputs", "user"],
                  properties: {
                    inputs: inputSchema,
                    response_mode: { type: "string", enum: ["blocking", "streaming"] },
                    user: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Workflow completed or an SSE stream was opened.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      task_id: { type: "string" },
                      workflow_run_id: { type: "string" },
                      data: {
                        type: "object",
                        properties: {
                          status: { type: "string" },
                          outputs: outputSchema,
                        },
                      },
                    },
                  },
                },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            "400": { description: "Invalid input" },
            "401": { description: "Missing or invalid API key" },
            "403": { description: "API key is not allowed to run this workflow" },
            "429": { description: "Rate limit exceeded" },
          },
        },
      },
      "/v1/workflow-tasks/{taskId}/stop": {
        post: {
          operationId: "stopWorkflow",
          summary: "Stop an active workflow task",
          security: [{ WorkflowApiKey: [] }],
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Stop signal accepted" },
            "401": { description: "Missing or invalid API key" },
            "409": { description: "Task is no longer running" },
          },
        },
      },
      "/v1/workflow-runs/{runId}": {
        get: {
          operationId: "getWorkflowRun",
          summary: "Get workflow run details",
          security: [{ WorkflowApiKey: [] }],
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Workflow run detail" },
            "401": { description: "Missing or invalid API key" },
            "404": { description: "Workflow run not found" },
          },
        },
      },
      "/v1/workflow-runs/{runId}/events": {
        get: {
          operationId: "getWorkflowRunEvents",
          summary: "Replay persisted workflow events",
          security: [{ WorkflowApiKey: [] }],
          parameters: [
            { name: "runId", in: "path", required: true, schema: { type: "string" } },
            {
              name: "after",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 0 },
            },
          ],
          responses: {
            "200": {
              description: "Server-Sent Events stream",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
          },
        },
      },
      [`/v1/workflows/${slug}/schema`]: {
        get: {
          operationId: "getWorkflowSchema",
          summary: "Get the published input and output schemas",
          security: [{ WorkflowApiKey: [] }],
          responses: {
            "200": {
              description: "Published workflow schemas",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { input_schema: inputSchema, output_schema: outputSchema },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        WorkflowApiKey: { type: "http", scheme: "bearer", bearerFormat: "WORKFLOW_API_KEY" },
      },
    },
  };
}
