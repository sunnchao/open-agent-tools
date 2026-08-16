import {
  ApiOutlined,
  BranchesOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FlagOutlined,
  NodeIndexOutlined,
  PlayCircleFilled,
  UserOutlined,
} from "../../lib/icons.js";
import type { NodeKind } from "../../features/workflow/model.js";
import type { PaletteItem } from "./types.js";

export const palette: PaletteItem[] = [
  { kind: "start", label: "开始", description: "工作流入口", group: "输入" },
  { kind: "input", label: "用户输入", description: "定义输入变量", group: "输入" },
  { kind: "rag", label: "知识检索", description: "召回知识片段", group: "知识与模型" },
  { kind: "graph", label: "图谱检索", description: "子图多跳扩展", group: "知识与模型" },
  { kind: "llm", label: "LLM", description: "生成或理解文本", group: "知识与模型" },
  { kind: "mcp", label: "MCP Tool", description: "调用 MCP 工具", group: "工具与逻辑" },
  { kind: "condition", label: "条件分支", description: "按表达式分流", group: "工具与逻辑" },
  { kind: "end", label: "结束", description: "定义最终输出", group: "输出" },
];

export const iconByKind: Record<NodeKind, React.ReactNode> = {
  start: <PlayCircleFilled />,
  input: <UserOutlined />,
  rag: <DatabaseOutlined />,
  graph: <NodeIndexOutlined />,
  llm: <ExperimentOutlined />,
  mcp: <ApiOutlined />,
  condition: <BranchesOutlined />,
  end: <FlagOutlined />,
};

export function nodeColor(kind: NodeKind): string {
  if (kind === "rag") return "#c77921";
  if (kind === "graph") return "#534AB7";
  if (kind === "mcp") return "#16806a";
  if (kind === "condition") return "#7a5da6";
  if (kind === "llm") return "#356bc4";
  return "#69717d";
}
