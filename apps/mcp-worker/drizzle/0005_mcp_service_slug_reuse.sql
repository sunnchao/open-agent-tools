DROP INDEX "mcp_services_slug_unique";

CREATE UNIQUE INDEX "mcp_services_slug_unique"
  ON "mcp_services" ("slug")
  WHERE "status" <> 'DELETED';
