CREATE TYPE "public"."mcp_build_job_kind" AS ENUM('INSPECT', 'BUILD');
CREATE TYPE "public"."mcp_build_job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "mcp_service_versions" ADD COLUMN "artifact_object_key" text;
ALTER TABLE "mcp_service_versions" ADD COLUMN "artifact_size" integer;

CREATE TABLE "mcp_build_jobs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "version_id" uuid NOT NULL,
  "kind" "mcp_build_job_kind" NOT NULL,
  "status" "mcp_build_job_status" NOT NULL,
  "stage" varchar(64) NOT NULL,
  "artifact_object_key" text NOT NULL,
  "artifact_digest" text NOT NULL,
  "artifact_size" integer NOT NULL,
  "image_digest" text,
  "sbom_object_key" text,
  "error_code" varchar(64),
  "attempt" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL
);

ALTER TABLE "mcp_build_jobs" ADD CONSTRAINT "mcp_build_jobs_version_id_mcp_service_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."mcp_service_versions"("id") ON DELETE restrict ON UPDATE no action;
CREATE INDEX "mcp_build_jobs_version_idx" ON "mcp_build_jobs" USING btree ("version_id");
CREATE INDEX "mcp_build_jobs_status_idx" ON "mcp_build_jobs" USING btree ("status");
