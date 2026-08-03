#!/usr/bin/env node

import { runToolInvocation } from "./runner.js";

try {
  await runToolInvocation({
    packageRoot: process.env.MCP_PACKAGE_ROOT ?? "/app",
    inputPath: process.env.MCP_TOOL_INPUT ?? "/run/tool/input.json",
    outputPath: process.env.MCP_TOOL_OUTPUT ?? "/run/tool/output.json",
  });
} catch {
  console.error("Node.js Tool runner failed before producing output");
  process.exitCode = 1;
}
