import { useEffect, useState } from "react";
import { App, Button, Card, Flex, Space, Tag, Typography } from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  DownloadOutlined,
  EyeOutlined,
} from "../lib/icons.js";

type ReportStatus = "approved" | "pending" | "rejected" | string;

type FinancialReport = {
  id: string;
  name: string;
  status: ReportStatus;
};

type FinancialReportCardProps = {
  reports?: FinancialReport[];
};

function isPending(status: ReportStatus): boolean {
  return status === "pending";
}

function downloadReportJson(report: FinancialReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${report.id}.json`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function statusColor(status: ReportStatus): string {
  if (status === "approved") return "success";
  if (status === "rejected") return "error";
  if (status === "pending") return "warning";
  return "default";
}

export function FinancialReportCard({ reports }: FinancialReportCardProps) {
  const { message } = App.useApp();
  const [insideReports, setInsideReports] = useState<FinancialReport[]>([]);

  useEffect(() => {
    setInsideReports(reports ?? []);
  }, [reports]);

  const updateStatus = (id: string, status: "approved" | "rejected") => {
    setInsideReports((prev) =>
      prev.map((report) => (report.id === id ? { ...report, status } : report)),
    );
  };

  if (insideReports.length === 0) {
    return null;
  }

  return (
    <Flex vertical gap={10}>
      {insideReports.map((report) => {
        const pending = isPending(report.status);
        return (
          <Card key={report.id} size="small" title={report.name} extra={<Tag color={statusColor(report.status)}>{report.status}</Tag>}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {report.id}
            </Typography.Text>
            <Space wrap style={{ marginTop: 12 }}>
              <Button
                size="small"
                icon={<EyeOutlined />}
                onClick={() =>
                  message.info(`${report.name} · ${report.status} · ${report.id}`)
                }
              >
                详情
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                disabled={!pending}
                onClick={() => {
                  updateStatus(report.id, "approved");
                  message.success(`已批准 ${report.name}`);
                }}
              >
                批准
              </Button>
              <Button
                size="small"
                danger
                icon={<CloseOutlined />}
                disabled={!pending}
                onClick={() => {
                  updateStatus(report.id, "rejected");
                  message.error(`已驳回 ${report.name}`);
                }}
              >
                驳回
              </Button>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                onClick={() => {
                  downloadReportJson(report);
                  message.info(`已下载 ${report.id}.json`);
                }}
              >
                下载
              </Button>
            </Space>
          </Card>
        );
      })}
    </Flex>
  );
}
