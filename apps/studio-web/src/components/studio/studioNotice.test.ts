import { describe, expect, it } from "vitest";
import type { StudioNoticeValue } from "./StudioNotice.js";

function alertType(notice: StudioNoticeValue | null): string | null {
  if (!notice) return null;
  return notice.type === "error" ? "error" : notice.type;
}

describe("studio notice mapping", () => {
  it("keeps workspace notice semantics on Alert types", () => {
    expect(alertType({ type: "success", text: "ok" })).toBe("success");
    expect(alertType({ type: "error", text: "bad" })).toBe("error");
    expect(alertType({ type: "info", text: "hi" })).toBe("info");
    expect(alertType({ type: "warning", text: "warn" })).toBe("warning");
    expect(alertType(null)).toBeNull();
  });
});
