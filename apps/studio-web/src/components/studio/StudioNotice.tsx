import { Alert } from "antd";

export interface StudioNoticeValue {
  type: "success" | "error" | "info" | "warning";
  text: string;
}

export function StudioNotice({ notice }: { notice: StudioNoticeValue | null }) {
  if (!notice) return null;
  return (
    <div style={{ flex: "0 0 auto", padding: "12px 22px 0" }}>
      <Alert
        type={notice.type === "error" ? "error" : notice.type}
        message={notice.text}
        showIcon
        closable={notice.type === "success" || notice.type === "info"}
        banner={false}
      />
    </div>
  );
}
