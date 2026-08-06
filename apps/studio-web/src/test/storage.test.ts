import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessions, loadSessions, saveSessions } from "../lib/storage.js";
import type { Session } from "../types.js";

const mockSession: Session = {
  id: "test-1",
  title: "Test session",
  messages: [
    {
      id: "m1",
      role: "user",
      content: "查一下 approved 的报表",
      createdAt: 1000,
      status: "complete",
    },
    {
      id: "m2",
      role: "assistant",
      content: "好的，结果如下。",
      createdAt: 1001,
      status: "complete",
      toolCalls: [
        {
          id: "call_1",
          name: "get_financial_reports",
          arguments: '{"status":"approved"}',
          status: "done",
          ui: {
            type: "financial_report_card",
            props: {
              reports: [{ id: "report1", name: "Report 1", status: "approved" }],
            },
          },
        },
      ],
    },
  ],
  updatedAt: 1001,
  resources: { mcpTools: [], rag: { sources: [], topK: 5 } },
};

describe("storage", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("loadSessions returns empty array when nothing stored", () => {
    expect(loadSessions()).toEqual([]);
  });

  it("saveSessions then loadSessions round-trips", () => {
    saveSessions([mockSession]);
    expect(loadSessions()).toEqual([mockSession]);
  });

  it("loadSessions returns empty array on corrupt JSON", () => {
    localStorage.setItem("open-agent-tools.chat.v1", "{not valid json");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadSessions()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("clearSessions removes stored data", () => {
    saveSessions([mockSession]);
    clearSessions();
    expect(loadSessions()).toEqual([]);
  });

  it("round-trips a session that includes function-calling (toolCalls) records", () => {
    saveSessions([mockSession]);
    const loaded = loadSessions();
    expect(loaded).toEqual([mockSession]);
    expect(loaded[0]!.messages[1]!.toolCalls?.[0]!.name).toBe("get_financial_reports");
    expect(loaded[0]!.messages[1]!.toolCalls?.[0]!.ui).toEqual(
      mockSession.messages[1]!.toolCalls?.[0]!.ui,
    );
  });

  it("adds default resources when loading a legacy session", () => {
    const { resources: _resources, ...legacy } = mockSession;
    localStorage.setItem("open-agent-tools.chat.v1", JSON.stringify([legacy]));
    expect(loadSessions()[0]?.resources).toEqual({
      mcpTools: [],
      rag: { sources: [], topK: 5 },
    });
  });
});
