import { describe, expect, it } from "vitest";
import { formatBytes, formatShortDateTime } from "./format.js";

describe("format helpers", () => {
  it("formats byte sizes with the existing zero-value policies", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(0, "--")).toBe("--");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("keeps invalid dates visible and formats valid dates locally", () => {
    expect(formatShortDateTime("not-a-date")).toBe("not-a-date");
    expect(formatShortDateTime("")).toBe("--");
    expect(formatShortDateTime("2026-10-23T12:34:00.000Z")).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});
