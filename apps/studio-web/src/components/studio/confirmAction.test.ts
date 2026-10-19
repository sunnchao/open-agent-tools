import { describe, expect, it, vi } from "vitest";
import { Modal } from "antd";
import { confirmAction } from "./confirmAction.js";

describe("confirmAction", () => {
  it("uses danger confirm defaults for destructive actions", () => {
    const spy = vi.spyOn(Modal, "confirm").mockImplementation((() => undefined) as never);
    const onOk = vi.fn();
    try {
      confirmAction({ title: "删除连接器", content: "删除后不可恢复", onOk });
      expect(spy).toHaveBeenCalledTimes(1);
      const config = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(config["title"]).toBe("删除连接器");
      expect(config["okText"]).toBe("确认删除");
      expect(config["cancelText"]).toBe("取消");
      expect(config["centered"]).toBe(true);
      expect(config["okButtonProps"]).toEqual({ danger: true });
      expect(config["onOk"]).toBe(onOk);
    } finally {
      spy.mockRestore();
    }
  });

  it("supports non-danger confirm copy", () => {
    const spy = vi.spyOn(Modal, "confirm").mockImplementation((() => undefined) as never);
    try {
      confirmAction({ title: "立即同步", danger: false, onOk: () => undefined });
      const config = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(config["okText"]).toBe("确认");
      expect(config["okButtonProps"]).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
