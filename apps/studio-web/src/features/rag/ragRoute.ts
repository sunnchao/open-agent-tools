import type { StudioRoute } from "../../lib/routing.js";

/** 知识库工作区的三个视图：文档 / 图谱 / 运营分析。 */
export type RagView = "documents" | "graph" | "analytics";

export interface RagRouteState {
  initialView?: RagView;
  initialSource?: string | null;
}

const RAG_VIEWS: readonly RagView[] = ["documents", "graph", "analytics"];

function isRagView(value: string | undefined): value is RagView {
  return value !== undefined && (RAG_VIEWS as readonly string[]).includes(value);
}

/**
 * 从 hash 路由解析知识库视图参数。
 *
 * - 历史 `#/graph` / `#/graph/<source>` 已被知识库吸收：固定进入图谱视图，
 *   且首段是文档名（不是视图名），这是新旧路由最容易混淆的地方。
 * - 知识库自身的 `#/rag/<view>/<source>` 直接按视图名解析。
 * - 其余 `#/rag` 路由保持默认（文档视图），不影响既有书签。
 */
export function ragRouteState(route: StudioRoute): RagRouteState {
  if (route.workspace === "graph") {
    return { initialView: "graph", initialSource: route.segments[0] ?? null };
  }
  if (route.workspace !== "rag") return {};
  const [view, source] = route.segments;
  if (!isRagView(view)) return {};
  return { initialView: view, initialSource: source ?? null };
}
