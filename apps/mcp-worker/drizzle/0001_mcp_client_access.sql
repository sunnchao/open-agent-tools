CREATE TYPE "api_client_status" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "api_key_status" AS ENUM ('ACTIVE', 'REVOKED');

CREATE TABLE "api_clients" (
  "id" uuid PRIMARY KEY,
  "name" varchar(120) NOT NULL,
  "status" "api_client_status" NOT NULL DEFAULT 'ACTIVE',
  "revision" integer NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);

CREATE INDEX "api_clients_status_idx" ON "api_clients" ("status");

CREATE TABLE "api_keys" (
  "id" uuid PRIMARY KEY,
  "client_id" uuid NOT NULL REFERENCES "api_clients" ("id") ON DELETE CASCADE,
  "key_hash" text NOT NULL,
  "status" "api_key_status" NOT NULL DEFAULT 'ACTIVE',
  "expires_at" timestamptz,
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL
);

CREATE INDEX "api_keys_client_idx" ON "api_keys" ("client_id");

CREATE TABLE "client_grants" (
  "id" uuid PRIMARY KEY,
  "client_id" uuid NOT NULL REFERENCES "api_clients" ("id") ON DELETE CASCADE,
  "service_id" uuid NOT NULL REFERENCES "mcp_services" ("id") ON DELETE CASCADE,
  "scopes" text[] NOT NULL,
  "prompt_names" text[],
  "tool_names" text[],
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "client_grants_client_service_unique" UNIQUE ("client_id", "service_id")
);

CREATE INDEX "client_grants_service_idx" ON "client_grants" ("service_id");
