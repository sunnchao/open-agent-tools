/**
 * 发布应用的身份断言模式。
 *
 * 管理面（`enterpriseIdentityStatus` 的 LDAP 段）与请求面（`appChat` 的校验策略）
 * 必须读取同一份解析结果，否则状态展示与实际拦截会分叉。
 */
export type PublishedAppIdentityMode = "optional" | "required" | "required_for_groups";

export function publishedAppIdentityMode(
  env: NodeJS.ProcessEnv = process.env,
): PublishedAppIdentityMode {
  const value = env.PUBLISHED_APP_IDENTITY_MODE?.trim();
  return value === "required" || value === "required_for_groups" ? value : "optional";
}
