import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actorFromClaims } from "./auth.js";

describe("OIDC admin role mapping", () => {
  it("maps supported roles and applies least privilege ordering", () => {
    assert.deepEqual(actorFromClaims({ sub: "user-1", roles: ["auditor"] }), {
      id: "user-1",
      role: "auditor",
    });
    assert.deepEqual(actorFromClaims({ sub: "user-2", roles: ["auditor", "admin"] }), {
      id: "user-2",
      role: "admin",
    });
  });

  it("supports a configured role claim", () => {
    assert.deepEqual(actorFromClaims({ sub: "user-1", groups: "operator" }, "groups"), {
      id: "user-1",
      role: "operator",
    });
  });

  it("rejects missing subjects and unsupported roles", () => {
    assert.equal(actorFromClaims({ roles: ["admin"] }), null);
    assert.equal(actorFromClaims({ sub: "user-1", roles: ["viewer"] }), null);
  });
});
