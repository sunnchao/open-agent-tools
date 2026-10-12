import {
  ApiOutlined,
  BranchesOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FlagOutlined,
  GlobeOutlined,
  NodeIndexOutlined,
  PlayCircleFilled,
  UserOutlined,
  TableOutlined,
} from "../../lib/icons.js";
import type { NodeKind } from "./model.js";
import type { PaletteItem } from "./types.js";

export const palette: PaletteItem[] = [
  { kind: "start", label: "开始", description: "工作流入口", group: "输入" },
  { kind: "input", label: "用户输入", description: "定义输入变量", group: "输入" },
  { kind: "rag", label: "知识检索", description: "召回知识片段", group: "知识与模型" },
  { kind: "graph", label: "图谱检索", description: "子图多跳扩展", group: "知识与模型" },
  { kind: "sql", label: "SQL 问数", description: "自然语言查询数据库", group: "工具与逻辑" },
  { kind: "llm", label: "LLM", description: "生成或理解文本", group: "知识与模型" },
  { kind: "mcp", label: "MCP Tool", description: "调用 MCP 工具", group: "工具与逻辑" },
  { kind: "http", label: "HTTP 请求", description: "调用外部 API", group: "工具与逻辑" },
  { kind: "condition", label: "条件分支", description: "按表达式分流", group: "工具与逻辑" },
  { kind: "end", label: "结束", description: "定义最终输出", group: "输出" },
];

export const iconByKind: Record<NodeKind, React.ReactNode> = {
  start: <PlayCircleFilled />,
  input: <UserOutlined />,
  rag: <DatabaseOutlined />,
  graph: <NodeIndexOutlined />,
  sql: <TableOutlined />,
  llm: <ExperimentOutlined />,
  mcp: <ApiOutlined />,
  http: <GlobeOutlined />,
  condition: <BranchesOutlined />,
  end: <FlagOutlined />,
};

export function nodeColor(kind: NodeKind): string {
  if (kind === "rag") return "#c77921";
  if (kind === "graph") return "#534AB7";
  if (kind === "mcp") return "#16806a";
  if (kind === "http") return "#b46438";
  if (kind === "sql") return "#9a651f";
  if (kind === "condition") return "#7a5da6";
  if (kind === "llm") return "#356bc4";
  return "#69717d";
}
