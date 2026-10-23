import { createWorkflowClient } from "@open-agent-tools/studio-client";
import type {
  WorkflowVersionRecord as SharedVersion,
  WorkflowDetailRecord as SharedDetail,
  WorkflowRunHistory as SharedHistory,
} from "@open-agent-tools/workflow-contracts";
import type { WorkflowSnapshot } from "./types.js";
import { studioFetch } from "../../lib/client.js";

export type {
  WorkflowAppRecord,
  WorkflowApiKeyRecord,
  WorkflowRunRecord,
  WorkflowRunEventRecord,
} from "@open-agent-tools/workflow-contracts";
export type WorkflowVersionRecord = SharedVersion<WorkflowSnapshot>;
export type WorkflowDetailRecord = SharedDetail<WorkflowSnapshot>;
export type WorkflowRunHistory = SharedHistory<WorkflowSnapshot>;

export const {
  fetchWorkflows,
  fetchWorkflow,
  createWorkflow,
  duplicateWorkflow,
  deleteWorkflow,
  saveWorkflowDraft,
  publishWorkflow,
  rollbackWorkflow,
  createWorkflowKey,
  revokeWorkflowKey,
  fetchWorkflowRuns,
  fetchWorkflowRunEvents,
} = createWorkflowClient<WorkflowSnapshot>(studioFetch);
