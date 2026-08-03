import { describe, expect, it } from "vitest";
import { parseSseBuffer } from "../lib/api.js";

describe("parseSseBuffer", () => {
  it("parses a single complete SSE event", () => {
    const { events, rest } = parseSseBuffer('data: {"delta":"hi"}\n\n');
    expect(events).toEqual([{ delta: "hi" }]);
    expect(rest).toBe("");
  });

  it("returns incomplete trailing data as rest without parsing it", () => {
    const { events, rest } = parseSseBuffer('data: {"delta":"hi"}\n\ndata: {"delta":"par');
    expect(events).toEqual([{ delta: "hi" }]);
    expect(rest).toBe('data: {"delta":"par');
  });

  it("ignores non-data lines", () => {
    const buf = 'event: ping\ndata: {"a":1}\n\n';
    const { events } = parseSseBuffer(buf);
    expect(events).toEqual([{ a: 1 }]);
  });

  it("parses multiple events and tool_call / tool_result shapes", () => {
    const buf =
      'data: {"tool_call":{"id":"c1","name":"get_financial_reports","arguments":"{}"}}\n\n' +
      'data: {"tool_result":{"id":"c1","name":"get_financial_reports","ui":{"type":"financial_report_card","props":{"reports":[]}}}}\n\n';
    const { events } = parseSseBuffer(buf);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      tool_call: { id: "c1", name: "get_financial_reports", arguments: "{}" },
    });
    expect(events[1]).toEqual({
      tool_result: {
        id: "c1",
        name: "get_financial_reports",
        ui: { type: "financial_report_card", props: { reports: [] } },
      },
    });
  });

  it("drops malformed JSON events but keeps the rest", () => {
    const buf = 'data: {bad json}\n\ndata: {"ok":true}\n\n';
    const { events } = parseSseBuffer(buf);
    expect(events).toEqual([{ ok: true }]);
  });
});
