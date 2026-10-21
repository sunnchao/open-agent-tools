import type { ComponentProps } from "react";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { WorkspaceTab } from "../lib/types";

export type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

export const workspaceIcons: Record<WorkspaceTab, IconName> = {
  chat: "message-text-outline",
  mcp: "api",
  rag: "book-open-page-variant-outline",
  connectors: "transit-connection-variant",
  graph: "graph-outline",
  observatory: "database-search-outline",
  reports: "chart-box-outline",
  workflow: "sitemap-outline",
  settings: "tune-variant",
};
