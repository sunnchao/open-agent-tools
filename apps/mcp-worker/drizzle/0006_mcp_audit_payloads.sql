ALTER TYPE "mcp_admin_role" ADD VALUE IF NOT EXISTS 'client';

ALTER TABLE "mcp_audit_events"
  ADD COLUMN "source" text NOT NULL DEFAULT 'control-plane',
  ADD COLUMN "input" jsonb,
  ADD COLUMN "output" jsonb,
  ADD COLUMN "context" jsonb;
