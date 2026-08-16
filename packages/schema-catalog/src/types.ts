/**
 * Schema Catalog 公共类型。
 *
 * 设计原则：Catalog 是"元数据"（表/列/关系/枚举/抽样），不是业务数据；
 * 采集是系统表只读查询，渲染/选择阶段才决定给 LLM 注入多少（Level 0/1/2 渐进加载）。
 */

/** 数据源类型，当前支持 MySQL（PostgreSQL 采集器可后续扩展）。 */
export type CatalogSource = "mysql";

/** 字段敏感度：默认不注入，除非业务显式要求。 */
export type ColumnSensitivity = "normal" | "sensitive";

/** 字段在渲染裁剪时的档位。 */
export type ColumnTier = "required" | "common" | "full";

export interface TableMeta {
  name: string;
  schema: string;
  comment?: string;
  /** 行数估计（information_schema 中的近似值，非精确 count）。 */
  approxRows?: number;
  /** 采集时间戳。 */
  collectedAt: string;
}

export interface ColumnMeta {
  table: string;
  schema: string;
  name: string;
  /** MySQL 原生类型（如 varchar(64) / int / decimal(10,2)）。 */
  columnType: string;
  /** 是否可空。 */
  nullable: boolean;
  /** 是否主键。 */
  isPrimary: boolean;
  /** 是否唯一。 */
  isUnique: boolean;
  /** 是否有索引。 */
  hasIndex: boolean;
  comment?: string;
  /** 字段默认值（原文，来自 information_schema）。 */
  defaultValue?: string;
  sensitivity: ColumnSensitivity;
  tier: ColumnTier;
  /** 枚举值含义提示（业务字典注入，如 status: {"1":"启用","2":"禁用"}）。 */
  enumHint?: Record<string, string>;
}

/** 外键 / 可 join 路径。 */
export interface RelationMeta {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

/** 枚举值及业务含义（如 status: PENDING → 待审批）。 */
export interface EnumValue {
  value: string;
  meaning?: string;
}

export interface EnumMeta {
  table: string;
  column: string;
  values: EnumValue[];
}

/** 高频过滤字段的抽样统计（帮助 LLM 猜 WHERE，但只对高频字段做）。 */
export interface SampleMeta {
  table: string;
  column: string;
  distinctCount: number;
  topValues: Array<{ value: string; count: number }>;
  min?: string;
  max?: string;
}

/** 一张表的完整 catalog 条目。 */
export interface TableCatalog {
  table: TableMeta;
  columns: ColumnMeta[];
  relations: RelationMeta[];
  enums: EnumMeta[];
  samples: SampleMeta[];
}

/** 整个 schema 的 catalog。 */
export interface SchemaCatalog {
  source: CatalogSource;
  /** 数据库名（MySQL 的 schema 名）。 */
  database: string;
  collectedAt: string;
  /** 目录版本（配合 DDL 快照对账 / 工具版本）。 */
  version?: string;
  tables: TableCatalog[];
}

/** 采集配置：哪些库表要采、采样上限等。 */
export interface CollectOptions {
  /** 连接串（mysql://user:pass@host:port/db）。 */
  connectionString: string;
  /** 目标数据库名；缺省取连接串里的 db。 */
  database?: string;
  /** 表过滤：不填 = 全部业务表（排除系统表）；支持通配符（如 "report_%"）。 */
  tableFilter?: string[];
  /** 采样：对高频过滤字段采集 TOP 值分布的表数上限。 */
  sampleTableLimit?: number;
  /** 采样：单字段 TOP 值数量上限。 */
  sampleTopK?: number;
  /** 采样：仅当 distinct 数不超过该值才采 TOP 分布。 */
  sampleDistinctCap?: number;
  /** 是否跳过采样（默认 false）。 */
  skipSamples?: boolean;
  /** 是否跳过系统表（information_schema/mysql/performance_schema/sys），默认 true。 */
  skipSystemSchemas?: boolean;
}
