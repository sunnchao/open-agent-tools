import type { Request } from "express";
import { trimmedString } from "@open-agent-tools/api-contracts/values";

/** Published-app tokens may arrive through a header or a share-link query. */
export function appAccessToken(req: Request): string | null {
  return trimmedString(req.header("x-app-access-token")) ?? trimmedString(req.query.access_token);
}
