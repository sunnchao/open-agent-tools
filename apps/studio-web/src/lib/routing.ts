import { safeDecodeUriComponent } from "@open-agent-tools/api-contracts/values";

/**
 * Studio 使用 hash 路由（`#/chat`、`#/workflow`）。
 *
 * 工作区之后的路径段用于定位具体实体，刷新页面时可以直接回到同一处：
 * - `#/chat/<sessionId>`：对话页定位到某个会话。
 * - `#/workflow/<workflowId>`：工作流详情（编排）页。
 * - `#/workflow/<workflowId>/access`：工作流访问点页。
 */

/** 解析后的 hash 路由。 */
export interface StudioRoute {
  /** 首段：工作区 ID（chat / workflow / ...）。 */
  workspace: string;
  /** 其余段：实体 ID 与子页面标记。 */
  segments: string[];
}

/**
 * 解析 `#/chat/<sessionId>` 形式的 hash 路由。
 * 兼容历史上不带斜杠的写法（`#chat`）。
 */
export function parseHashRoute(hash: string): StudioRoute {
  const raw = hash.replace(/^#/, "").replace(/^\/+/, "");
  const parts = raw.split("/").filter((part) => part.length > 0);
  const [workspace = "", ...segments] = parts;
  return {
    workspace: workspace.toLowerCase(),
    segments: segments.map(safeDecodeUriComponent),
  };
}

/**
 * 编码路径段。保留 `:` —— 会话 / 工作流 ID 里常见 `app-<hash>:<uuid>` 这类写法，
 * 转义成 `%3A` 会让地址栏难以辨认；其余分隔符照常转义，解析时能还原。
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}

/**
 * 生成 `#/chat/<sessionId>` 形式的 hash 路由（不含 `#`）。
 * 空段会被忽略，因此 `buildHashRoute("workflow", [])` 得到 `/workflow`。
 */
export function buildHashRoute(
  workspace: string,
  segments: Array<string | null | undefined> = [],
): string {
  const tail = segments
    .filter((segment): segment is string => typeof segment === "string" && segment.length > 0)
    .map(encodeSegment);
  return `/${[workspace, ...tail].join("/")}`;
}

/** 判断两条路由是否等价，用于跳过无意义的 hashchange 重渲染。 */
export function sameRoute(left: StudioRoute, right: StudioRoute): boolean {
  return (
    left.workspace === right.workspace &&
    left.segments.length === right.segments.length &&
    left.segments.every((segment, index) => segment === right.segments[index])
  );
}
