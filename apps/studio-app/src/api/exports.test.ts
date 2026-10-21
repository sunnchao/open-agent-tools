import { describe, expect, it } from "vitest";
import { auditExportPath, filenameFromDisposition, usageExportPath } from "./exports";
import { employeeEntryPath, localMessage } from "./apps";
import { brandTitle } from "./branding";

describe("exports/apps/branding helpers", () => {
  it("builds export paths", () => {
    expect(auditExportPath({ status: "succeeded", search: "a" }, "csv")).toContain("format=csv");
    expect(auditExportPath({ status: "succeeded" }, "csv")).not.toContain("limit=");
    expect(usageExportPath({ all: true, days: 7 }, "json")).toContain("workspaceId=*");
  });
  it("parses filenames", () => {
    expect(filenameFromDisposition(null, "a.csv")).toBe("a.csv");
    expect(
      filenameFromDisposition("attachment; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.csv", "a.csv"),
    ).toBe("报表.csv");
    expect(filenameFromDisposition('attachment; filename="b.csv"', "a.csv")).toBe("b.csv");
  });
  it("supports employee entries", () => {
    expect(employeeEntryPath("hr")).toBe("#/app/hr");
    expect(employeeEntryPath("hr", "tok")).toContain("access_token=tok");
    expect(localMessage("user", "hi").status).toBe("complete");
    expect(brandTitle("ACME")).toBe("ACME · Studio");
  });
});
