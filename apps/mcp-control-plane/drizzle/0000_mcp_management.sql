CREATE TYPE "mcp_service_type" AS ENUM ('MANAGED_MCP', 'REMOTE_MCP');
CREATE TYPE "mcp_service_status" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'DELETED');
CREATE TYPE "mcp_version_status" AS ENUM (
  'DRAFT',
  'VALIDATING',
  'BUILDING',
  'READY',
  'FAILED',
  'PUBLISHED',
  'SUPERSEDED'
);

CREATE TABLE "mcp_services" (
  "id" uuid PRIMARY KEY,
  "name" varchar(120) NOT NULL,
  "slug" varchar(64) NOT NULL,
  "type" "mcp_service_type" NOT NULL,
  "status" "mcp_service_status" NOT NULL DEFAULT 'DRAFT',
  "current_version_id" uuid,
  "revision" integer NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "deleted_at" timestamptz
);

CREATE UNIQUE INDEX "mcp_services_slug_unique" ON "mcp_services" ("slug");
CREATE INDEX "mcp_services_status_idx" ON "mcp_services" ("status");

CREATE TABLE "mcp_service_versions" (
  "id" uuid PRIMARY KEY,
  "service_id" uuid NOT NULL REFERENCES "mcp_services" ("id") ON DELETE RESTRICT,
  "version_number" integer NOT NULL CHECK ("version_number" > 0),
  "status" "mcp_version_status" NOT NULL DEFAULT 'DRAFT',
  "runtime_name" varchar(16),
  "runtime_version" varchar(16),
  "entry" text,
  "build_command" text,
  "limits" jsonb,
  "artifact_digest" text,
  "image_digest" text,
  "revision" integer NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "mcp_service_versions_service_number_unique" UNIQUE ("service_id", "version_number"),
  CONSTRAINT "mcp_service_versions_runtime_check" CHECK (
    ("runtime_name" IS NULL AND "runtime_version" IS NULL)
    OR ("runtime_name" = 'nodejs' AND "runtime_version" = '20')
  ),
  CONSTRAINT "mcp_service_versions_build_command_check" CHECK (
    "build_command" IS NULL OR "build_command" = 'npm run build'
  )
);

CREATE INDEX "mcp_service_versions_service_idx" ON "mcp_service_versions" ("service_id");
CREATE INDEX "mcp_service_versions_status_idx" ON "mcp_service_versions" ("status");

ALTER TABLE "mcp_services"
  ADD CONSTRAINT "mcp_services_current_version_fk"
  FOREIGN KEY ("current_version_id") REFERENCES "mcp_service_versions" ("id") ON DELETE RESTRICT;

CREATE TABLE "mcp_tools" (
  "id" uuid PRIMARY KEY,
  "version_id" uuid NOT NULL REFERENCES "mcp_service_versions" ("id") ON DELETE CASCADE,
  "name" varchar(64) NOT NULL,
  "description" text,
  "handler" varchar(128) NOT NULL,
  "input_schema" jsonb NOT NULL,
  "position" integer NOT NULL CHECK ("position" >= 0),
  CONSTRAINT "mcp_tools_version_name_unique" UNIQUE ("version_id", "name")
);

CREATE INDEX "mcp_tools_version_idx" ON "mcp_tools" ("version_id");

CREATE TABLE "mcp_prompts" (
  "id" uuid PRIMARY KEY,
  "version_id" uuid NOT NULL REFERENCES "mcp_service_versions" ("id") ON DELETE CASCADE,
  "name" varchar(64) NOT NULL,
  "title" varchar(200),
  "description" text,
  "arguments" jsonb NOT NULL,
  "messages" jsonb NOT NULL,
  "position" integer NOT NULL CHECK ("position" >= 0),
  CONSTRAINT "mcp_prompts_version_name_unique" UNIQUE ("version_id", "name")
);

CREATE INDEX "mcp_prompts_version_idx" ON "mcp_prompts" ("version_id");
