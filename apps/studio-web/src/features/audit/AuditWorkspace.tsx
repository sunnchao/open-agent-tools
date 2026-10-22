import { useState } from "react";
import { StudioPage } from "../../components/studio/StudioPageHeader.js";
import { AuditCenterView } from "./AuditCenterView.js";
import { AuditDetailsDrawer } from "./AuditDetailsDrawer.js";
import type { AuditDetailSelection } from "./api.js";
import "./audit.css";

/** 审计工作区：统一入口与日志详情。 */
export function AuditWorkspace() {
  const [selection, setSelection] = useState<AuditDetailSelection | null>(null);

  return (
    <StudioPage
      eyebrow="Audit / Unified Audit Center"
      title="统一审计中心"
      description="IM 会话、问数、用量与 MCP 平台审计的统一入口，全链路留痕可追溯。"
    >
      <div className="audit-workspace">
        <AuditCenterView onViewDetails={setSelection} />
      </div>
      <AuditDetailsDrawer
        selection={selection}
        onClose={() => setSelection(null)}
        onSelect={setSelection}
      />
    </StudioPage>
  );
}
