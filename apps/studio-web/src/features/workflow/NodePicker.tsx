import { Button, Empty, Flex, Input, List, Modal, Tooltip, Typography } from "antd";
import { useState } from "react";
import { iconByKind, palette } from "./palette.js";
import type { NodeKind } from "./model.js";
import type { NodePickerState } from "./types.js";
import { CloseOutlined } from "../../lib/icons.js";

export function NodePicker({
  state,
  hasStart,
  onChoose,
  onClose,
  existingNodes = [],
  onChooseExisting,
}: {
  state: NodePickerState;
  hasStart: boolean;
  onChoose: (kind: NodeKind) => void;
  onClose: () => void;
  existingNodes?: Array<{ id: string; label: string; kind?: NodeKind }>;
  onChooseExisting?: (nodeId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const existingChoices = existingNodes.filter(
    (node) => !normalized || `${node.label} ${node.id}`.toLocaleLowerCase().includes(normalized),
  );
  const choices = palette.filter((item) => {
    if (state.edgeId && (item.kind === "start" || item.kind === "end")) return false;
    return (
      !normalized ||
      `${item.label} ${item.description} ${item.group} ${item.kind}`
        .toLocaleLowerCase()
        .includes(normalized)
    );
  });
  const title = state.sourceNodeId ? "选择下一节点" : state.edgeId ? "插入节点" : "添加节点";
  const hint = state.sourceNodeId
    ? "选择后自动连接当前分支"
    : state.edgeId
      ? "原连接会自动拆分"
      : "添加到当前画布";
  return (
    <Modal
      open
      centered
      title={title}
      footer={null}
      onCancel={onClose}
      width={520}
    >
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
        <Tooltip title="关闭节点选择器">
          <Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭节点选择器" onClick={onClose} />
        </Tooltip>
      </Flex>
      <Input.Search
        autoFocus
        allowClear
        value={query}
        placeholder="搜索节点"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            if (state.sourceNodeId && existingChoices[0] && onChooseExisting)
              onChooseExisting(existingChoices[0].id);
            else {
              const first = choices.find(
                (item) => item.kind !== "start" || (!hasStart && !state.sourceNodeId),
              );
              if (first) onChoose(first.kind);
            }
          }
        }}
        style={{ marginBottom: 12 }}
      />
      {state.sourceNodeId && existingNodes.length > 0 ? (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已有节点
          </Typography.Text>
          <List
            size="small"
            style={{ marginBottom: 12 }}
            dataSource={existingChoices}
            renderItem={(node) => (
              <List.Item
                actions={[<Button key="connect" type="link" size="small" onClick={() => onChooseExisting?.(node.id)}>连接</Button>]}
              >
                <List.Item.Meta
                  avatar={<span aria-hidden="true">{iconByKind[node.kind ?? "input"]}</span>}
                  title={node.label}
                  description={node.id}
                />
              </List.Item>
            )}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            新建节点
          </Typography.Text>
        </>
      ) : null}
      <List
        size="small"
        dataSource={choices}
        renderItem={(item) => {
          const disabled = item.kind === "start" && (hasStart || Boolean(state.sourceNodeId));
          return (
            <List.Item
              actions={[
                <Button
                  key="add"
                  type="link"
                  size="small"
                  disabled={disabled}
                  title={disabled ? "工作流只能有一个开始节点" : item.description}
                  onClick={() => onChoose(item.kind)}
                >
                  {item.group}
                </Button>,
              ]}
            >
              <List.Item.Meta
                avatar={<span aria-hidden="true">{iconByKind[item.kind]}</span>}
                title={item.label}
                description={item.description}
              />
            </List.Item>
          );
        }}
      />
      {choices.length === 0 && existingChoices.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的节点" />
      ) : null}
    </Modal>
  );
}
