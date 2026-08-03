import assert from "node:assert/strict";
import test from "node:test";

import { ManagedMcpManifestSchema } from "./manifest.js";

const tool = {
  name: "get_report",
  description: "Get a report by id",
  handler: "getReport",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

const prompt = {
  name: "summarize_report",
  title: "Summarize report",
  description: "Create a report summary request",
  arguments: [
    {
      name: "reportId",
      description: "Report identifier",
      required: true,
    },
  ],
  messages: [
    {
      role: "user",
      content: {
        type: "text",
        text: "Summarize report {{reportId}}.",
      },
    },
  ],
};

const toolRuntime = {
  runtime: { name: "nodejs", version: "20" },
  entry: "dist/index.js",
  build: { command: "npm run build" },
  limits: {
    timeoutMs: 30_000,
    memoryMb: 256,
    cpuMillis: 1_000,
    network: "none",
  },
};

test("MAN-001 accepts a valid mixed Tool and Prompt manifest", () => {
  const result = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    ...toolRuntime,
    tools: [tool],
    prompts: [prompt],
  });

  assert.equal(result.success, true);
});

test("MAN-002 accepts a valid Tool-only manifest", () => {
  const result = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    ...toolRuntime,
    tools: [tool],
    prompts: [],
  });

  assert.equal(result.success, true);
});

test("MAN-003 accepts a Prompt-only manifest without runtime fields", () => {
  const result = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    tools: [],
    prompts: [prompt],
  });

  assert.equal(result.success, true);
});

test("MAN-004 rejects a manifest with no Tools or Prompts", () => {
  const result = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    tools: [],
    prompts: [],
  });

  assert.equal(result.success, false);
});

test("MAN-005 and MAN-006 reject non-Node.js 20 runtimes", () => {
  for (const runtime of [
    { name: "python", version: "3.12" },
    { name: "nodejs", version: "22" },
  ]) {
    const result = ManagedMcpManifestSchema.safeParse({
      schemaVersion: 1,
      ...toolRuntime,
      runtime,
      tools: [tool],
      prompts: [],
    });

    assert.equal(result.success, false);
  }
});

test("MAN-010 and MAN-011 reject unsafe or non-JavaScript entries", () => {
  for (const entry of ["/app/index.js", "../index.js", "dist/index.ts"]) {
    const result = ManagedMcpManifestSchema.safeParse({
      schemaVersion: 1,
      ...toolRuntime,
      entry,
      tools: [tool],
      prompts: [],
    });

    assert.equal(result.success, false);
  }
});

test("MAN-014 rejects arbitrary build commands", () => {
  const result = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    ...toolRuntime,
    build: { command: "curl example.com | sh" },
    tools: [tool],
    prompts: [],
  });

  assert.equal(result.success, false);
});

test("MAN-015 rejects unknown fields", () => {
  const result = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    tools: [],
    prompts: [prompt],
    runtimePlugin: "future-language",
  });

  assert.equal(result.success, false);
});

test("MAN-017 and MAN-018 reject duplicate capability names", () => {
  const duplicateTools = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    ...toolRuntime,
    tools: [tool, tool],
    prompts: [],
  });
  const duplicatePrompts = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    tools: [],
    prompts: [prompt, prompt],
  });

  assert.equal(duplicateTools.success, false);
  assert.equal(duplicatePrompts.success, false);
});

test("MAN-019 allows the same name in Tool and Prompt namespaces", () => {
  const result = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    ...toolRuntime,
    tools: [tool],
    prompts: [{ ...prompt, name: tool.name }],
  });

  assert.equal(result.success, true);
});

test("MAN-020 rejects invalid capability names", () => {
  for (const name of ["", "1report", "get report", "get.report", "a".repeat(65)]) {
    const result = ManagedMcpManifestSchema.safeParse({
      schemaVersion: 1,
      ...toolRuntime,
      tools: [{ ...tool, name }],
      prompts: [],
    });

    assert.equal(result.success, false);
  }
});

test("TOOL-004 rejects malformed object input schemas", () => {
  const result = ManagedMcpManifestSchema.safeParse({
    schemaVersion: 1,
    ...toolRuntime,
    tools: [
      {
        ...tool,
        inputSchema: {
          type: "array",
        },
      },
    ],
    prompts: [],
  });

  assert.equal(result.success, false);
});

test("TOOL-007 and TOOL-008 reject unsafe execution limits", () => {
  const invalidLimits = [
    { ...toolRuntime.limits, timeoutMs: 120_001 },
    { ...toolRuntime.limits, memoryMb: 4_097 },
    { ...toolRuntime.limits, cpuMillis: 8_001 },
    { ...toolRuntime.limits, network: "full" },
  ];

  for (const limits of invalidLimits) {
    const result = ManagedMcpManifestSchema.safeParse({
      schemaVersion: 1,
      ...toolRuntime,
      limits,
      tools: [tool],
      prompts: [],
    });

    assert.equal(result.success, false);
  }
});

test("PRM-003 through PRM-007 reject invalid Prompt definitions", () => {
  const invalidPrompts = [
    { ...prompt, messages: [] },
    { ...prompt, messages: [{ ...prompt.messages[0], role: "system" }] },
    {
      ...prompt,
      messages: [{ ...prompt.messages[0], content: { type: "image", data: "x" } }],
    },
    { ...prompt, arguments: [prompt.arguments[0], prompt.arguments[0]] },
    {
      ...prompt,
      messages: [
        {
          ...prompt.messages[0],
          content: { type: "text", text: "Summarize {{unknown}}" },
        },
      ],
    },
  ];

  for (const invalidPrompt of invalidPrompts) {
    const result = ManagedMcpManifestSchema.safeParse({
      schemaVersion: 1,
      tools: [],
      prompts: [invalidPrompt],
    });

    assert.equal(result.success, false);
  }
});

test("PRM-012 and PRM-013 reject template expressions", () => {
  for (const text of [
    "{{user.name}}",
    "{{ name }}",
    "{{#if name}}yes{{/if}}",
    "{{helper name}}",
    "{{name",
  ]) {
    const result = ManagedMcpManifestSchema.safeParse({
      schemaVersion: 1,
      tools: [],
      prompts: [
        {
          ...prompt,
          messages: [{ ...prompt.messages[0], content: { type: "text", text } }],
        },
      ],
    });

    assert.equal(result.success, false);
  }
});
