import { describe, expect, it } from "vitest";
import type { McpService, McpVersion } from "./api.js";
import {
  constrainGrantScopes,
  grantCapabilities,
  supportsGrantScope,
} from "./grantCapabilities.js";

function service(currentVersionId: string | null): McpService {
  return {
    id: "service-1",
    name: "Service",
    slug: "service",
    type: "MANAGED_MCP",
    status: "ACTIVE",
    currentVersionId,
    revision: 1,
  };
}

function version(input: {
  id?: string;
  status?: McpVersion["status"];
  tools?: McpVersion["tools"];
  prompts?: McpVersion["prompts"];
}): McpVersion {
  return {
    id: input.id ?? "version-1",
    serviceId: "service-1",
    versionNumber: 1,
    status: input.status ?? "PUBLISHED",
    runtime: null,
    entry: null,
    buildCommand: null,
    limits: null,
    artifactDigest: null,
    artifactObjectKey: null,
    artifactSize: null,
    imageDigest: null,
    tools: input.tools ?? [],
    prompts: input.prompts ?? [],
    revision: 1,
  };
}

describe("MCP grant capabilities", () => {
  it("allows only Tool scopes for a Tool-only published service", () => {
    const capabilities = grantCapabilities(service("version-1"), [
      version({
        tools: [
          {
            id: "tool-1",
            name: "echo",
            handler: "echo",
            inputSchema: { type: "object" },
          },
        ],
      }),
    ]);

    expect(supportsGrantScope("tools:list", capabilities)).toBe(true);
    expect(supportsGrantScope("prompts:list", capabilities)).toBe(false);
    expect(
      constrainGrantScopes(
        ["mcp:connect", "tools:list", "tools:call", "prompts:list", "prompts:get"],
        capabilities,
      ),
    ).toEqual(["mcp:connect", "tools:list", "tools:call"]);
  });

  it("allows only Prompt scopes for a Prompt-only published service", () => {
    const capabilities = grantCapabilities(service("version-1"), [
      version({
        prompts: [
          {
            id: "prompt-1",
            name: "summarize",
            arguments: [],
            messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
          },
        ],
      }),
    ]);

    expect(
      constrainGrantScopes(
        ["mcp:connect", "tools:list", "tools:call", "prompts:list", "prompts:get"],
        capabilities,
      ),
    ).toEqual(["mcp:connect", "prompts:list", "prompts:get"]);
  });

  it("allows only Gateway access when there is no current published version", () => {
    const capabilities = grantCapabilities(service(null), [version({ status: "DRAFT" })]);

    expect(constrainGrantScopes(["tools:list", "prompts:list"], capabilities)).toEqual([
      "mcp:connect",
    ]);
    expect(capabilities.versionNumber).toBeNull();
  });
});
