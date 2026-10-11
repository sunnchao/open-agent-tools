ALTER TABLE mcp_services
  ADD COLUMN environment jsonb NOT NULL DEFAULT '{}'::jsonb;
