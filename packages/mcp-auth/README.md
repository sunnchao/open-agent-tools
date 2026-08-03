# MCP Auth

[English](./README_EN.md) | [平台总览](../../README.md)

`@open-agent-tools/mcp-auth` 提供 MCP Client API Key 的生成、解析和校验能力。Control Plane 使用它签发 Key，MCP Gateway 使用它校验 Bearer Token；原始 Secret 不需要写入数据库。

## Key 格式

```text
mcp.<key-id>.<secret>
```

- `key-id` 必须是小写 UUID，例如 `4d36e967-e325-11ce-bfc1-08002be10318`。
- `secret` 由 32 个随机字节编码为 43 个字符的 Base64URL 字符串。
- 格式不合法时，`parseApiKey` 返回 `null`，`verifyApiKey` 返回 `false`。

## 公开 API

| API                                  | 说明                                            |
| ------------------------------------ | ----------------------------------------------- |
| `createApiKey(keyId, secretSource?)` | 生成原始 Key 与可持久化的 scrypt Hash           |
| `parseApiKey(rawKey)`                | 解析并校验 Key 的结构，返回 `keyId` 和 `secret` |
| `verifyApiKey(rawKey, keyHash)`      | 重新派生密钥并使用恒定时间比较验证 Secret       |

`createApiKey` 返回：

```ts
interface CreatedApiKey {
  keyId: string;
  rawKey: string;
  keyHash: string;
}
```

`secretSource` 主要用于确定性测试。生产代码应使用默认的 `randomBytes(32)`。

## 使用示例

```ts
import { createApiKey, parseApiKey, verifyApiKey } from "@open-agent-tools/mcp-auth";

const created = await createApiKey("4d36e967-e325-11ce-bfc1-08002be10318");

// 只将 created.keyHash 持久化；created.rawKey 仅在创建响应中展示一次。
const parsed = parseApiKey(created.rawKey);
const valid = await verifyApiKey(created.rawKey, created.keyHash);
```

## Hash 格式

数据库中的 `keyHash` 使用以下自描述格式：

```text
scrypt$16384$8$1$<salt-base64url>$<derived-key-base64url>
```

固定参数：

| 参数                | 值            |
| ------------------- | ------------- |
| Cost `N`            | `16384`       |
| Block size `r`      | `8`           |
| Parallelization `p` | `1`           |
| Salt                | 16 个随机字节 |
| Derived key         | 32 字节       |
| `maxmem`            | 64 MiB        |

校验会拒绝算法标识或参数不匹配、Salt 缺失、派生结果长度不正确的 Hash。Secret 比较使用 Node.js `timingSafeEqual`。

## 安全约束

- 原始 API Key 是 Bearer Credential，只能在创建时向管理员展示一次。
- 数据库只存储 `keyId`、`keyHash`、状态、过期时间和关联 Client，不存储原始 Key 或 Secret。
- 日志、审计事件和错误响应不得包含原始 Key。
- Key 撤销、过期、Client 状态和 Grant 校验由 Gateway 的授权流程负责，本包只处理 Key 的密码学验证。
- `parseApiKey` 只验证结构，不代表 Key 已注册或仍然有效。

## 开发命令

```bash
pnpm --filter @open-agent-tools/mcp-auth build
pnpm --filter @open-agent-tools/mcp-auth typecheck
pnpm --filter @open-agent-tools/mcp-auth lint
pnpm --filter @open-agent-tools/mcp-auth test
```
