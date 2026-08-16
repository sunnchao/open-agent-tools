# schema-catalog（Schema 采集 / 存储 / 渐进加载）

把 MySQL（后续可扩 PostgreSQL）的元数据采集成 **Catalog**（表/列/关系/枚举/抽样），
并支持 **Level 0/1/2 渐进式加载**，把注入给 LLM 的 schema 从"全量 180K token"压到"骨架几 K + 按需几 K"。

> 配套设计：`docs/AI报表SQL查询工具开发文档.md` 的 Text-to-SQL 章节、`packages/query-resolver`（口径字典）。

## 一、采集 MySQL Schema

```bash
# 连接串里的库名即目标库
MYSQL_URL='mysql://user:pass@host:3306/mydb' \
  pnpm --filter @open-agent-tools/schema-catalog collect \
  --out schema-catalog.json

# 只采业务表（通配符）
MYSQL_URL='...' pnpm --filter @open-agent-tools/schema-catalog collect --filter 'report_%,org'

# 跳过抽样（大库或只想要结构）
MYSQL_URL='...' pnpm --filter @open-agent-tools/schema-catalog collect --skip-samples
```

采集只读 `information_schema`（表/列/键/索引/外键 + 对高频过滤字段做 TOP 值抽样），零业务风险。
产物是单个 JSON：`SchemaCatalog`（见 `src/types.ts`）。

## 二、渐进式加载（省 token 三件套）

| 层级 | 内容 | 量级 | 何时用 |
|---|---|---|---|
| **Level 0 骨架** | `renderSkeleton()`：表名 + 一句话注释 + 行数级 | 200 表 ≈ 2~6K token | system prompt 常驻 |
| **Level 1 选中表** | `PreRegisteredSelector`（意图→表）或 `searchTables`（关键词/RAG） | 3 张表 ≈ 1.5~3K token | 意图识别后 |
| **Level 2 分档裁剪** | `renderTableSchemaTiered()`：required+common 默认，full 按需；敏感字段默认剔除 | 再砍一半 | 每次注入前 |

```ts
import { collectMysqlCatalog, renderSkeleton, renderTableSchemaTiered, PreRegisteredSelector } from "@open-agent-tools/schema-catalog";

const catalog = await collectMysqlCatalog({ connectionString });

const skeleton = renderSkeleton(catalog);                                   // Level 0
const sel = new PreRegisteredSelector([{ intent: "report_approval_query", tables: ["report_submission", "org"] }]);
const tables = sel.selectTables(catalog, "report_approval_query");          // Level 1
const prompt = tables.map((t) => renderTableSchemaTiered(t)).join("\n\n");  // Level 2
```

> 探索式查询兜底：`searchTables(catalog, "待审批的报表")` 关键词评分（中文二元组），
> 或接入 `packages/rag` 的向量+BM25 做语义检索（schema chunk 化入 RAG）。

## 三、字段分档与敏感字段

- **required**：主键/唯一键 + `status|type|org|*_at` 等高频过滤维度；
- **common**：`*_id|*_no|*_code|*_name` 等常用业务字段；
- **full**：长文本/大字段，默认不注入；
- **sensitive**（手机号/密码/密钥/身份证等启发式）：默认剔除，除非业务显式要求。

## 四、对账与版本化

采集 JSON 可与 DDL/migration 快照 diff（`version` 字段），漂移即生成变更记录；
建议随工具包版本一起提交 `schema-catalog.json`，保证"Agent 看到的 schema"与"发布的工具版本"一致。

## 五、测试

```bash
pnpm --filter @open-agent-tools/schema-catalog test            # 单元测试
MYSQL_TEST_URL='mysql://...' pnpm --filter @open-agent-tools/schema-catalog test   # 集成（真库）
```

---

## 六、NEW-API 业务字典增强（schema-catalog.enriched.json）

NEW-API（one-api 变体）建表**不带表/字段 COMMENT**，且大量状态是数值枚举
（`logs.type=2`=消费、`users.status=1`=启用、`channels.type=43`=DeepSeek），
LLM 无法凭空猜出含义。仓库已内置从 NEW-API 源码提取的业务字典：

```bash
# 离线增强（不需要数据库连接）
pnpm --filter @open-agent-tools/schema-catalog enrich-newapi   --in schema-catalog.json --out schema-catalog.enriched.json
```

增强内容（幂等，可重复执行）：
- 27 张表全部补注释；
- 16 个枚举列补含义（users.role/status、tokens.status、channels.type/status、logs.type、orders.status、top_ups.status、midjourneys.action/status 等）；
- 21 个敏感字段标记（password/key/token 等默认不注入 LLM）。

渲染时枚举会随字段一起输出：
```
- `status` bigint -- 状态：1=启用 2=禁用 [枚举: 1=启用, 2=禁用]
- `type` bigint -- 日志类型：1=充值 2=消费 3=管理 ... [枚举: ...]
```

> 其他业务库（非 NEW-API）建议仿照 `src/dict/newapi.ts` 写自己的字典模块：
> 表注释 → 字段注释 → 枚举含义 → 敏感标记，采集后离线 enrich。
