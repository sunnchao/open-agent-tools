CREATE TYPE "usage_event_status" AS ENUM ('RESERVED', 'SUCCEEDED', 'FAILED');

CREATE TABLE "client_quotas" (
  "id" uuid PRIMARY KEY NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "api_clients" ("id") ON DELETE CASCADE,
  "service_id" uuid REFERENCES "mcp_services" ("id") ON DELETE CASCADE,
  "qps_limit" integer DEFAULT 0 NOT NULL CHECK ("qps_limit" >= 0),
  "daily_call_limit" integer DEFAULT 0 NOT NULL CHECK ("daily_call_limit" >= 0),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX "client_quotas_client_global_unique"
  ON "client_quotas" ("client_id")
  WHERE "service_id" IS NULL;
CREATE UNIQUE INDEX "client_quotas_client_service_unique"
  ON "client_quotas" ("client_id", "service_id")
  WHERE "service_id" IS NOT NULL;
CREATE INDEX "client_quotas_service_idx" ON "client_quotas" ("service_id");

CREATE TABLE "usage_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "api_clients" ("id") ON DELETE CASCADE,
  "service_id" uuid NOT NULL REFERENCES "mcp_services" ("id") ON DELETE CASCADE,
  "version_id" uuid NOT NULL REFERENCES "mcp_service_versions" ("id") ON DELETE RESTRICT,
  "tool_name" varchar(64) NOT NULL,
  "request_id" varchar(120) NOT NULL,
  "status" "usage_event_status" DEFAULT 'RESERVED' NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  "duration_ms" integer,
  CONSTRAINT "usage_events_duration_check" CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0)
);

CREATE INDEX "usage_events_client_created_idx"
  ON "usage_events" ("client_id", "created_at");
CREATE INDEX "usage_events_client_service_created_idx"
  ON "usage_events" ("client_id", "service_id", "created_at");
CREATE INDEX "usage_events_status_created_idx"
  ON "usage_events" ("status", "created_at");
CREATE INDEX "usage_events_request_idx" ON "usage_events" ("request_id");
