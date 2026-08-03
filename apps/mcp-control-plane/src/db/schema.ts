import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { PromptDefinition } from "@open-agent-tools/mcp-contracts";
import type { McpServiceVersionRecord } from "../types.js";

export const mcpServiceTypeEnum = pgEnum("mcp_service_type", ["MANAGED_MCP", "REMOTE_MCP"]);
export const mcpServiceStatusEnum = pgEnum("mcp_service_status", [
  "DRAFT",
  "ACTIVE",
  "DISABLED",
  "DELETED",
]);
export const mcpVersionStatusEnum = pgEnum("mcp_version_status", [
  "DRAFT",
  "VALIDATING",
  "BUILDING",
  "READY",
  "FAILED",
  "PUBLISHED",
  "SUPERSEDED",
]);
export const apiClientStatusEnum = pgEnum("api_client_status", ["ACTIVE", "REVOKED"]);
export const apiKeyStatusEnum = pgEnum("api_key_status", ["ACTIVE", "REVOKED"]);
export const mcpBuildJobKindEnum = pgEnum("mcp_build_job_kind", ["INSPECT", "BUILD"]);
export const mcpBuildJobStatusEnum = pgEnum("mcp_build_job_status", [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
]);
export const mcpAdminRoleEnum = pgEnum("mcp_admin_role", ["admin", "operator", "auditor"]);
export const mcpAuditOutcomeEnum = pgEnum("mcp_audit_outcome", ["SUCCEEDED", "FAILED"]);

const timestampColumn = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const mcpServices = pgTable(
  "mcp_services",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 64 }).notNull(),
    type: mcpServiceTypeEnum("type").notNull(),
    status: mcpServiceStatusEnum("status").notNull().default("DRAFT"),
    currentVersionId: uuid("current_version_id"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
    deletedAt: timestampColumn("deleted_at"),
  },
  (table) => [
    uniqueIndex("mcp_services_slug_unique").on(table.slug),
    index("mcp_services_status_idx").on(table.status),
  ],
);

export const mcpServiceVersions = pgTable(
  "mcp_service_versions",
  {
    id: uuid("id").primaryKey(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => mcpServices.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    status: mcpVersionStatusEnum("status").notNull().default("DRAFT"),
    runtimeName: varchar("runtime_name", { length: 16 }),
    runtimeVersion: varchar("runtime_version", { length: 16 }),
    entry: text("entry"),
    buildCommand: text("build_command"),
    limits: jsonb("limits").$type<McpServiceVersionRecord["limits"]>(),
    artifactDigest: text("artifact_digest"),
    artifactObjectKey: text("artifact_object_key"),
    artifactSize: integer("artifact_size"),
    imageDigest: text("image_digest"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => [
    unique("mcp_service_versions_service_number_unique").on(table.serviceId, table.versionNumber),
    index("mcp_service_versions_service_idx").on(table.serviceId),
    index("mcp_service_versions_status_idx").on(table.status),
  ],
);

export const mcpBuildJobs = pgTable(
  "mcp_build_jobs",
  {
    id: uuid("id").primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => mcpServiceVersions.id, { onDelete: "restrict" }),
    kind: mcpBuildJobKindEnum("kind").notNull(),
    status: mcpBuildJobStatusEnum("status").notNull(),
    stage: varchar("stage", { length: 64 }).notNull(),
    artifactObjectKey: text("artifact_object_key").notNull(),
    artifactDigest: text("artifact_digest").notNull(),
    artifactSize: integer("artifact_size").notNull(),
    imageDigest: text("image_digest"),
    sbomObjectKey: text("sbom_object_key"),
    errorCode: varchar("error_code", { length: 64 }),
    attempt: integer("attempt").notNull().default(0),
    createdAt: timestampColumn("created_at").notNull(),
    startedAt: timestampColumn("started_at"),
    finishedAt: timestampColumn("finished_at"),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => [
    index("mcp_build_jobs_version_idx").on(table.versionId),
    index("mcp_build_jobs_status_idx").on(table.status),
  ],
);

export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: uuid("id").primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => mcpServiceVersions.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    description: text("description"),
    handler: varchar("handler", { length: 128 }).notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    unique("mcp_tools_version_name_unique").on(table.versionId, table.name),
    index("mcp_tools_version_idx").on(table.versionId),
  ],
);

export const mcpPrompts = pgTable(
  "mcp_prompts",
  {
    id: uuid("id").primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => mcpServiceVersions.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    title: varchar("title", { length: 200 }),
    description: text("description"),
    arguments: jsonb("arguments").$type<PromptDefinition["arguments"]>().notNull(),
    messages: jsonb("messages").$type<PromptDefinition["messages"]>().notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    unique("mcp_prompts_version_name_unique").on(table.versionId, table.name),
    index("mcp_prompts_version_idx").on(table.versionId),
  ],
);

export const apiClients = pgTable(
  "api_clients",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    status: apiClientStatusEnum("status").notNull().default("ACTIVE"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => [index("api_clients_status_idx").on(table.status)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(),
    status: apiKeyStatusEnum("status").notNull().default("ACTIVE"),
    expiresAt: timestampColumn("expires_at"),
    lastUsedAt: timestampColumn("last_used_at"),
    createdAt: timestampColumn("created_at").notNull(),
  },
  (table) => [index("api_keys_client_idx").on(table.clientId)],
);

export const clientGrants = pgTable(
  "client_grants",
  {
    id: uuid("id").primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => mcpServices.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    promptNames: text("prompt_names").array(),
    toolNames: text("tool_names").array(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => [
    unique("client_grants_client_service_unique").on(table.clientId, table.serviceId),
    index("client_grants_service_idx").on(table.serviceId),
  ],
);

export const mcpAuditEvents = pgTable(
  "mcp_audit_events",
  {
    id: uuid("id").primaryKey(),
    actorId: varchar("actor_id", { length: 120 }).notNull(),
    actorRole: mcpAdminRoleEnum("actor_role").notNull(),
    action: varchar("action", { length: 180 }).notNull(),
    target: text("target").notNull(),
    requestId: varchar("request_id", { length: 120 }).notNull(),
    outcome: mcpAuditOutcomeEnum("outcome").notNull(),
    statusCode: integer("status_code").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
  },
  (table) => [
    index("mcp_audit_events_created_idx").on(table.createdAt),
    index("mcp_audit_events_outcome_idx").on(table.outcome),
    index("mcp_audit_events_actor_idx").on(table.actorId),
  ],
);
