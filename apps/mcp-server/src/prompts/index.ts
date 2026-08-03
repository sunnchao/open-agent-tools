import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildRoleContext, type RoleVariant } from "./role-info.js";

/**
 * 向 MCP 服务器注册上下文模板（prompt templates）。
 *
 * 这些模板通过 prompts/list 暴露，客户端用 prompts/get 获取具体消息，
 * 从而把角色设定与任务上下文注入到对话中。模板是「可参数化的提示」，
 * 区别于只读的 Resources 与可执行动作的 Tools。
 */
export function registerPrompts(server: McpServer): void {
  // 公共角色信息模板：注入共享的角色设定与行为准则，可按场景选择变体。
  server.registerPrompt(
    "role_context",
    {
      title: "公共角色信息（上下文模板）",
      description:
        "注入 open-agent-tools 的公共角色设定与行为准则；可按场景选择角色变体并指定本次重点。",
      argsSchema: {
        role: z
          .enum(["default", "assistant", "reviewer", "coder"])
          .describe("角色变体：default / assistant / reviewer / coder")
          .optional(),
        focus: z.string().describe("本次对话的重点方向（可选）").optional(),
      },
    },
    ({ role, focus }) => {
      const roleInfo = buildRoleContext((role as RoleVariant) ?? "default", focus);
      return {
        description: "公共角色信息与上下文设定",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `请根据以下角色设定与上下文开展工作：\n\n${roleInfo}`,
            },
          },
        ],
      };
    },
  );

  // 报表摘要模板：引用 reports 资源，生成结构化的摘要任务提示。
  server.registerPrompt(
    "summarize_reports",
    {
      title: "摘要财务报表（上下文模板）",
      description: "生成一段提示，要求读取指定审批状态的财务报表资源并给出结构化摘要。",
      argsSchema: {
        status: z
          .enum(["approved", "pending", "rejected"])
          .describe("报表审批状态：approved / pending / rejected"),
      },
    },
    ({ status }) => {
      const uri = `open-agent-tools://reports/${status}`;
      return {
        description: `摘要 ${status} 状态的财务报表`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `请读取资源 ${uri} 中的财务报表，并完成以下工作：\n` +
                `1. 用表格列出每条报表的 id、name、status；\n` +
                `2. 统计总数并说明整体审批分布；\n` +
                `3. 若有异常或缺失数据，单独指出。\n` +
                `数据以资源返回为准，不要臆测。`,
            },
          },
        ],
      };
    },
  );
}
