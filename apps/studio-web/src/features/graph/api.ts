import { createGraphClient } from "@open-agent-tools/studio-client";
import { ragRequest } from "../../lib/client.js";
export type {
  GraphNode,
  GraphEdge,
  GraphExport,
  DocumentGraph,
  EntityInfo,
  GraphRetrieveResult,
  GraphSourceState,
  SyncStatus,
  ReconcileResult,
} from "@open-agent-tools/api-contracts/graph";
export const { retrieveGraph, documentGraph, neighborsOf, syncStatus, reconcileGraph } =
  createGraphClient(ragRequest);
