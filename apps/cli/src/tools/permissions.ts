export type PermissionDecision = "allow" | "deny" | "always";

/**
 * 权限管理器：对危险工具（写文件 / 编辑 / 执行命令）在运行前征求用户意见。
 * 用户选择“本次会话始终允许”后，该工具名会被记忆，不再重复询问。
 */
export class PermissionManager {
  private alwaysAllow = new Set<string>();
  private readonly confirm: (name: string, args: string) => Promise<PermissionDecision>;

  constructor(confirm: (name: string, args: string) => Promise<PermissionDecision>) {
    this.confirm = confirm;
  }

  isAutoAllowed(name: string): boolean {
    return this.alwaysAllow.has(name);
  }

  /** 返回 true 表示允许执行，false 表示拒绝。 */
  async decide(name: string, args: string): Promise<boolean> {
    if (this.alwaysAllow.has(name)) return true;
    const decision = await this.confirm(name, args);
    if (decision === "always") {
      this.alwaysAllow.add(name);
      return true;
    }
    return decision === "allow";
  }
}
