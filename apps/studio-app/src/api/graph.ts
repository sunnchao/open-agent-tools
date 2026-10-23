import { createGraphClient } from "@open-agent-tools/studio-client";
import { ragRequest } from "../lib/http";
export type {
  GraphNode,
  GraphEdge,
  GraphExport,
  EntityInfo,
  GraphRetrieveResult,
  EntityListResult,
  RelationTypeStat,
  GraphSourceState,
  SyncStatus,
  ReconcileResult,
} from "@open-agent-tools/api-contracts/graph";
export const {
  retrieveGraph,
  neighborsOf,
  listEntities,
  relationTypes,
  syncStatus,
  reconcileGraph,
} = createGraphClient(ragRequest);
