import { useEffect, useMemo, useState } from "react";
import { Select } from "antd";
import { fetchWorkspaces, type Workspace } from "../workspaces/api.js";
import { getWorkspaceId } from "../../lib/client.js";

/**
 * 工作区选择器。
 *
 * 服务端按 `x-workspace-id` 头归集数据，且声明了不存在的工作区会直接 400，
 * 因此这里只提供真实存在的工作区选项。
 */
export function WorkspaceSelect({
  value,
  onChange,
  ariaLabel,
  allowAll = true,
  width = 200,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  allowAll?: boolean;
  width?: number;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  useEffect(() => {
    let active = true;
    void fetchWorkspaces()
      .then((list) => {
        if (active) setWorkspaces(list);
      })
      .catch(() => {
        // 工作区列表不可用时退化为自由输入，避免整页不可用。
        if (active) setWorkspaces([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const options = useMemo(
    () => [
      ...(allowAll ? [{ value: "", label: "当前空间" }] : []),
      ...workspaces.map((item) => ({ value: item.id, label: item.name })),
    ],
    [workspaces, allowAll],
  );

  if (workspaces.length === 0) {
    return (
      <Select
        aria-label={ariaLabel}
        value={value || undefined}
        onChange={(next) => onChange(next)}
        options={options}
        style={{ width }}
        placeholder="当前空间"
        showSearch
        optionFilterProp="label"
        notFoundContent="无可用工作区"
      />
    );
  }

  return (
    <Select
      aria-label={ariaLabel}
      value={value || (allowAll ? "" : getWorkspaceId())}
      onChange={(next) => onChange(next)}
      options={options}
      style={{ width }}
      showSearch
      optionFilterProp="label"
    />
  );
}
