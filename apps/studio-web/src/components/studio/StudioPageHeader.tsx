import type { CSSProperties, ReactNode } from "react";
import { Flex, Typography } from "antd";

export interface StudioPageHeaderProps {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 20,
  minHeight: 74,
  flex: "0 0 auto",
  padding: "12px 22px",
  background: "var(--studio-surface)",
  borderBottom: "1px solid var(--studio-line)",
};

const eyebrowStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 2,
  textTransform: "uppercase",
  margin: 0,
};

/** 管理页统一页头:英文 eyebrow + 中文标题 + 可选描述 + 右侧操作区。 */
export function StudioPageHeader({ eyebrow, title, description, actions }: StudioPageHeaderProps) {
  return (
    <header className="studio-page-header" style={headerStyle}>
      <Flex vertical gap={2} style={{ minWidth: 0 }}>
        <Typography.Text type="secondary" style={eyebrowStyle}>
          {eyebrow}
        </Typography.Text>
        <Typography.Title level={4} style={{ margin: 0, fontSize: 22, fontWeight: 650 }}>
          {title}
        </Typography.Title>
        {description ? (
          <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 12 }}>
            {description}
          </Typography.Paragraph>
        ) : null}
      </Flex>
      {actions ? (
        <Flex gap={8} align="center" wrap style={{ flex: "0 0 auto" }}>
          {actions}
        </Flex>
      ) : null}
    </header>
  );
}

export interface StudioPageProps extends StudioPageHeaderProps {
  children: ReactNode;
  extra?: ReactNode;
  bodyStyle?: CSSProperties;
}

/** 管理页统一外壳:页头 + 内容区,不接管内容区自身布局,便于逐页增量迁移。 */
export function StudioPage({
  eyebrow,
  title,
  description,
  actions,
  children,
  extra,
  bodyStyle,
}: StudioPageProps) {
  return (
    <section
      className="studio-page"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        background: "var(--studio-bg)",
      }}
    >
      <StudioPageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={actions}
      />
      {extra}
      <div
        className="studio-page__body"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </section>
  );
}
