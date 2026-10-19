import { Modal } from "antd";
import type { ModalFuncProps } from "antd";

export interface ConfirmActionOptions {
  title: string;
  content?: React.ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  onOk: () => void | Promise<void>;
}

/** 统一确认框:替换全部 window.confirm,危险操作默认红色确认按钮。 */
export function confirmAction(options: ConfirmActionOptions): void {
  const { title, content, okText, cancelText, danger = true, onOk } = options;
  const props: ModalFuncProps = {
    title,
    content,
    centered: true,
    okText: okText ?? (danger ? "确认删除" : "确认"),
    cancelText: cancelText ?? "取消",
    okButtonProps: danger ? { danger: true } : undefined,
    onOk,
  };
  Modal.confirm(props);
}
