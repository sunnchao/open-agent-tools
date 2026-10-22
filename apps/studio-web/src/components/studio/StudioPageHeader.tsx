import type { CSSProperties, ReactNode } from "react";
import { Typography } from "antd";

export interface StudioPageHeaderProps {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

/** 管理页统一页头：编辑式眉题 + 中文标题 + 可选描述 + 右侧操作区。 */
export function StudioPageHeader({ eyebrow, title, description, actions }: StudioPageHeaderProps) {
  return (
    <header className="studio-page-header">
      <div className="studio-page-header__main">
        <Typography.Text className="studio-page-header__eyebrow">{eyebrow}</Typography.Text>
        <Typography.Title level={2} className="studio-page-header__title">
          {title}
        </Typography.Title>
        {description ? (
          <Typography.Paragraph className="studio-page-header__description">
            {description}
          </Typography.Paragraph>
        ) : null}
      </div>
      {actions ? <div className="studio-page-header__actions">{actions}</div> : null}
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
    <section className="studio-page">
      <StudioPageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={actions}
      />
      {extra ? <div className="studio-page__extra">{extra}</div> : null}
      <div className="studio-page__body" style={bodyStyle}>
        {children}
      </div>
    </section>
  );
}
