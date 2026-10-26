import { useState } from "react";
import { Tabs } from "antd";
import { StudioPage } from "../../components/studio/StudioPageHeader.js";
import { MemoryFactDrawer } from "./MemoryFactDrawer.js";
import { MemoryFactsTable } from "./MemoryFactsTable.js";
import { MemoryOverview } from "./MemoryOverview.js";
import { MemoryReviewQueue } from "./MemoryReviewQueue.js";
import { MemoryForgetPanel } from "./MemoryForgetPanel.js";
import "./memory.css";

type MemoryTab = "overview" | "facts" | "review" | "forget";

const TAB_KEYS: MemoryTab[] = ["overview", "facts", "review", "forget"];

/** 记忆工作区：总览 / 事实库 / 待审核 / 遗忘。路由 `#/memory` 与 `#/memory/fact/<id>`。 */
export function MemoryWorkspace({
  factId,
  onOpenFact,
}: {
  factId: string | null;
  onOpenFact: (id: string | null) => void;
}) {
  const [tab, setTab] = useState<MemoryTab>(factId ? "facts" : "overview");
  // 子页改动（审核/遗忘）后递增，让事实表与总览各自刷新。
  const [revision, setRevision] = useState(0);

  const openFact = (id: string) => {
    setTab("facts");
    onOpenFact(id);
  };

  return (
    <StudioPage
      eyebrow="Memory / Long-term Facts"
      title="记忆"
      description="长期事实的审核、检索与追溯。记忆只做逻辑失效，历史版本可查；物理删除走遗忘流程。"
    >
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(TAB_KEYS.includes(key as MemoryTab) ? (key as MemoryTab) : "overview")}
        aria-label="记忆分类"
        items={[
          {
            key: "overview",
            label: "总览",
            children: <MemoryOverview key={`overview-${revision}`} onOpenFact={openFact} />,
          },
          {
            key: "facts",
            label: "事实库",
            children: (
              <MemoryFactsTable
                key={`facts-${revision}`}
                factId={factId}
                onOpenFact={onOpenFact}
                onChanged={() => setRevision((value) => value + 1)}
              />
            ),
          },
          {
            key: "review",
            label: "待审核",
            children: (
              <MemoryReviewQueue
                key={`review-${revision}`}
                onOpenFact={openFact}
              />
            ),
          },
          {
            key: "forget",
            label: "遗忘",
            children: (
              // 不挂 revision key：删除成功的结果提示由面板自己持有，
              // 重挂会把它冲掉，用户看不到反馈。总览/事实库在切换时重新拉取。
              <MemoryForgetPanel onForgotten={() => setRevision((value) => value + 1)} />
            ),
          },
        ]}
      />

      <MemoryFactDrawer
        factId={factId}
        onClose={() => onOpenFact(null)}
        onChanged={() => setRevision((value) => value + 1)}
      />
    </StudioPage>
  );
}
