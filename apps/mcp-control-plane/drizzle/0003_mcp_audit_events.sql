CREATE TYPE "public"."mcp_audit_outcome" AS ENUM('SUCCEEDED', 'FAILED');
CREATE TYPE "public"."mcp_admin_role" AS ENUM('admin', 'operator', 'auditor');

CREATE TABLE "mcp_audit_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "actor_id" varchar(120) NOT NULL,
  "actor_role" "mcp_admin_role" NOT NULL,
  "action" varchar(180) NOT NULL,
  "target" text NOT NULL,
  "request_id" varchar(120) NOT NULL,
  "outcome" "mcp_audit_outcome" NOT NULL,
  "status_code" integer NOT NULL,
  "duration_ms" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);

CREATE INDEX "mcp_audit_events_created_idx" ON "mcp_audit_events" USING btree ("created_at");
CREATE INDEX "mcp_audit_events_outcome_idx" ON "mcp_audit_events" USING btree ("outcome");
CREATE INDEX "mcp_audit_events_actor_idx" ON "mcp_audit_events" USING btree ("actor_id");
