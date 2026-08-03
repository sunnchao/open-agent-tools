import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { REPORTS } from "../tools/index.js";

// 资源文件与当前模块同目录；构建时由 scripts/copy-assets.mjs 一并拷到 dist/resources。
const RESOURCES_DIR = dirname(fileURLToPath(import.meta.url));

interface FileResource {
  name: string;
  uri: string;
  description: string;
  mimeType: string;
  file: string;
}

// 静态文件资源：文本与图片。
const FILE_RESOURCES: FileResource[] = [
  {
    name: "Welcome",
    uri: "open-agent-tools://resources/welcome.txt",
    description: "欢迎语与资源清单说明（纯文本）。",
    mimeType: "text/plain",
    file: "welcome.txt",
  },
  {
    name: "README",
    uri: "open-agent-tools://resources/readme.md",
    description: "MCP 服务项目说明文档（Markdown）。",
    mimeType: "text/markdown",
    file: "readme.md",
  },
  {
    name: "Architecture Diagram",
    uri: "open-agent-tools://resources/diagram.svg",
    description: "服务架构示意图（SVG 矢量图）。",
    mimeType: "image/svg+xml",
    file: "diagram.svg",
  },
  {
    name: "Logo",
    uri: "open-agent-tools://resources/logo.png",
    description: "项目 Logo（PNG 位图）。",
    mimeType: "image/png",
    file: "logo.png",
  },
];

function isTextual(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") || mimeType === "image/svg+xml" || mimeType === "application/json"
  );
}

/**
 * 向 MCP 服务器注册资源：
 * - 静态文件资源（文本 / 图片），从磁盘读取后按 MIME 类型返回 text 或 blob。
 * - 动态资源模板 open-agent-tools://reports/{status}，按审批状态返回财务报表 JSON。
 */
export function registerResources(server: McpServer): void {
  for (const r of FILE_RESOURCES) {
    server.resource(
      r.name,
      r.uri,
      { description: r.description, mimeType: r.mimeType },
      async (uri) => {
        const data = await readFile(join(RESOURCES_DIR, r.file));
        const content = isTextual(r.mimeType)
          ? { uri: uri.href, mimeType: r.mimeType, text: data.toString("utf-8") }
          : { uri: uri.href, mimeType: r.mimeType, blob: data.toString("base64") };
        return { contents: [content] };
      },
    );
  }

  server.resource(
    "Financial Reports",
    new ResourceTemplate("open-agent-tools://reports/{status}", { list: undefined }),
    {
      description: "按审批状态（approved / pending / rejected）返回财务报表数据。",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const status = String(variables.status);
      const reports = REPORTS[status] ?? [];
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ status, reports }, null, 2),
          },
        ],
      };
    },
  );
}
