/**
 * NEW-API 业务字典：为采集到的 schema catalog 补充表/字段注释与枚举含义。
 *
 * 为什么需要：NEW-API（one-api 变体）建表不带 COMMENT，且大量字段是数值枚举
 * （如 logs.type=2 表示消费、users.status=1 表示启用），LLM 无法凭空猜出含义。
 * 本字典从 NEW-API 源码（common/constants.go、model/log.go、constant/channel.go 等）提取，
 * 属于"业务口径层"，与通用 schema 采集分离。
 *
 * 用法：collectMysqlCatalog() 之后调用 enrichNewApiCatalog(catalog) 增强。
 */
import type { SchemaCatalog, TableCatalog, EnumValue } from "../types.js";

const TABLE_COMMENTS: Record<string, string> = {
  abilities: "模型可用能力（渠道支持某模型的权限矩阵）",
  channels: "渠道（上游模型供应商接入配置，含 API Key）",
  chat_caches: "聊天会话缓存（上下文记忆）",
  checkins: "签到记录（每日签到赠额度）",
  logs: "使用日志（消费/充值/管理/错误等全量操作审计）",
  midjourneys: "Midjourney 绘画任务记录",
  migrations: "数据库迁移版本记录",
  models: "模型定义（模型名与展示信息）",
  options: "系统选项（KV 配置）",
  orders: "充值订单（订阅/套餐订单）",
  passkey_credentials: "Passkey 无密码登录凭证",
  payments: "支付记录（支付网关回调）",
  prefill_groups: "预填充分组（模型参数预填策略）",
  prices: "模型价格表（按模型/分组定价）",
  quota_data: "额度明细数据（按小时聚合的用户额度消耗）",
  redemptions: "兑换码（充值码，含已用状态）",
  setups: "系统初始化状态",
  statistics: "统计汇总（用户/请求/额度等日粒度统计）",
  tasks: "异步任务（如 Suno 音乐生成任务）",
  telegram_menus: "Telegram 机器人菜单",
  tokens: "API 令牌（用户创建的调用凭证）",
  top_ups: "充值单（用户充值记录，含支付状态）",
  two_fa_backup_codes: "两步验证备用码",
  two_fas: "两步验证（2FA）配置",
  user_operations: "用户操作记录（登录/安全操作等）",
  users: "用户（账号、角色、状态、额度）",
  vendors: "供应商（支付/上游服务商配置）",
};

/** 表名 → 列名 → 列注释（只写采集器猜不出的业务语义） */
const COLUMN_COMMENTS: Record<string, Record<string, string>> = {
  users: {
    username: "登录名（查询用户时用它匹配，如 root）",
    display_name: "显示名称（展示用，查询用户时不要用它匹配）",
    role: "角色：0=游客 1=普通用户 10=管理员 100=超级管理员",
    status: "状态：1=启用 2=禁用",
    quota: "剩余额度（1 额度 = $0.000002 / 500K tokens 的换算单位）",
    used_quota: "已用额度",
    request_count: "请求次数",
    group: "用户分组（影响可用模型与价格）",
    aff_code: "邀请码",
    aff_count: "邀请人数",
    aff_quota: "邀请返利额度",
    is_arbitrage: "是否风控标记（套利检测）",
  },
  tokens: {
    key: "API Key（sk- 开头，仅显示掩码）",
    status: "状态：1=启用 2=禁用 3=过期 4=额度耗尽",
    created_time: "创建时间（Unix 秒）",
    accessed_time: "最后使用时间（Unix 秒）",
    expired_time: "过期时间（Unix 秒，0=永不过期）",
    remain_quota: "剩余额度",
    unlimited_quota: "是否无限额度：0=否 1=是",
    used_quota: "已用额度",
    model_limits_enabled: "是否启用模型限制：0=否 1=是",
    model_limits: "允许的模型列表（逗号分隔）",
  },
  channels: {
    type: "渠道类型（1=OpenAI 2=Midjourney 3=Azure 8=自定义 14=Anthropic 24=Gemini 25=Moonshot 43=DeepSeek 60=NewAPI 等，见字典）",
    key: "渠道 API Key（敏感）",
    status: "状态：1=启用 2=手动禁用 3=自动禁用（连续失败）",
    name: "渠道名称",
    weight: "权重（负载均衡随机权重）",
    base_url: "上游 Base URL",
    models: "支持的模型列表（逗号分隔）",
    group: "渠道分组",
    priority: "优先级（数字越大越优先）",
    test_time: "最后测试时间",
    response_time: "响应耗时（毫秒）",
  },
  logs: {
    type: "日志类型：1=充值 2=消费 3=管理 4=系统 5=错误 6=退款 7=登录 91=归档 92=管理员错误 93=订阅支付 94=签到",
    created_at: "创建时间（Unix 秒）",
    content: "日志内容摘要",
    username: "操作用户名",
    token_name: "令牌名（敏感）",
    model_name: "使用的模型名",
    quota: "本次消费额度",
    prompt_tokens: "输入 tokens 数（敏感）",
    completion_tokens: "输出 tokens 数（敏感）",
    is_stream: "是否流式：0=否 1=是",
    is_error: "是否错误：0=否 1=是",
    channel_id: "渠道 ID",
    user_id: "用户 ID",
    request_time: "请求耗时（毫秒）",
  },
  orders: {
    status: "订单状态：pending=待支付 success=已支付 closed=已关闭/取消",
    amount: "支付金额（分）",
    order_amount: "订单金额（元）",
    order_currency: "订单币种（如 CNY）",
    quota: "购买额度",
    fee: "手续费",
    trade_no: "平台交易号",
    gateway_no: "支付网关交易号",
  },
  top_ups: {
    status: "充值状态：pending=待支付 success=成功 failed=失败 expired=已过期",
    amount: "充值金额（元）",
    quota: "到账额度",
    trade_no: "交易号",
  },
  payments: {
    status: "支付状态：pending=待支付 success=成功 failed=失败",
    amount: "支付金额",
  },
  redemptions: {
    status: "兑换码状态：1=启用 2=禁用 3=已使用",
    quota: "兑换额度",
  },
  statistics: {
    type: "统计类型：0=按天 1=按小时",
    quota: "额度用量",
    prompt_tokens: "输入 tokens 总数",
    completion_tokens: "输出 tokens 总数",
  },
  quota_data: {
    user_id: "用户 ID",
    quota: "额度增量",
    model_name: "模型名",
    prompt_tokens: "输入 tokens 数",
    completion_tokens: "输出 tokens 数",
    created_at: "时间（Unix 秒）",
  },
  midjourneys: {
    action: "MJ 动作：imagine/upsample/variation/reroll/blend/describe/shorten",
    status: "MJ 任务状态：queued=排队 submitted=已提交 progress=执行中 success=成功 failure=失败",
    prompt: "绘画提示词",
    model_name: "模型名",
  },
  tasks: {
    platform: "任务平台：suno=音乐 mj=绘画",
    action: "动作：generate/remix 等",
    status: "任务状态",
    model_name: "模型名",
    prompt: "提示词",
  },
  users_quota: {
    quota: "用户剩余额度",
  },
  checkins: {
    quota: "签到奖励额度",
  },
};

/** 表名 → 列名 → 枚举值含义（数值/字符串 → 业务含义） */
const ENUM_MEANINGS: Record<string, Record<string, Record<string, string>>> = {
  users: {
    role: { "0": "游客", "1": "普通用户", "10": "管理员", "100": "超级管理员" },
    status: { "1": "启用", "2": "禁用" },
  },
  tokens: {
    status: { "1": "启用", "2": "禁用", "3": "过期", "4": "额度耗尽" },
    unlimited_quota: { "0": "否", "1": "是" },
  },
  channels: {
    type: {
      "1": "OpenAI", "2": "Midjourney", "3": "Azure", "4": "Ollama", "8": "自定义",
      "14": "Anthropic", "15": "Baidu", "16": "Zhipu", "17": "Ali", "20": "OpenRouter",
      "24": "Gemini", "25": "Moonshot", "34": "Cohere", "35": "MiniMax", "36": "SunoAPI",
      "40": "SiliconFlow", "41": "VertexAi", "43": "DeepSeek", "45": "VolcEngine",
      "48": "Xai", "50": "Kling", "55": "Sora", "56": "Replicate", "57": "Codex", "60": "NewAPI",
    },
    status: { "1": "启用", "2": "手动禁用", "3": "自动禁用" },
  },
  logs: {
    type: {
      "0": "未知", "1": "充值", "2": "消费", "3": "管理", "4": "系统", "5": "错误",
      "6": "退款", "7": "登录", "91": "归档", "92": "管理员错误", "93": "订阅支付", "94": "签到",
    },
    is_stream: { "0": "否", "1": "是" },
    is_error: { "0": "否", "1": "是" },
  },
  orders: {
    status: { pending: "待支付", success: "已支付", closed: "已关闭/取消" },
  },
  top_ups: {
    status: { pending: "待支付", success: "成功", failed: "失败", expired: "已过期" },
  },
  payments: {
    status: { pending: "待支付", success: "成功", failed: "失败" },
  },
  redemptions: {
    status: { "1": "启用", "2": "禁用", "3": "已使用" },
  },
  statistics: {
    type: { "0": "按天", "1": "按小时" },
  },
  midjourneys: {
    action: { imagine: "文生图", upsample: "放大", variation: "变体", reroll: "重绘", blend: "融合", describe: "图生文", shorten: "缩短提示" },
    status: { queued: "排队", submitted: "已提交", progress: "执行中", success: "成功", failure: "失败" },
  },
};

/** 把业务字典合并进 catalog（幂等：重复执行不叠加）。 */
export function enrichNewApiCatalog(catalog: SchemaCatalog): SchemaCatalog {
  return {
    ...catalog,
    tables: catalog.tables.map((t) => enrichTable(t)),
  };
}

function enrichTable(table: TableCatalog): TableCatalog {
  const tableComment = TABLE_COMMENTS[table.table.name];
  const colComments = COLUMN_COMMENTS[table.table.name] ?? {};
  const enumMap = ENUM_MEANINGS[table.table.name] ?? {};

  return {
    ...table,
    table: {
      ...table.table,
      comment: table.table.comment || tableComment,
    },
    columns: table.columns.map((c) => {
      const comment = c.comment || colComments[c.name];
      // 合并已有枚举值与业务字典枚举含义
      const enums = enumMap[c.name];
      const hasEnum = enums !== undefined;
      return {
        ...c,
        comment,
        sensitivity:
          c.sensitivity === "sensitive"
            ? c.sensitivity
            : c.name === "key" || /(password|secret|token)/.test(c.name)
              ? "sensitive"
              : c.sensitivity,
        ...(hasEnum ? { enumHint: enums } : {}),
      };
    }),
    enums: mergeEnums(table.enums, table.table.name, enumMap),
  };
}

function mergeEnums(
  existing: TableCatalog["enums"],
  tableName: string,
  enumMap: Record<string, Record<string, string>>,
): TableCatalog["enums"] {
  const merged: TableCatalog["enums"] = [...existing];
  for (const [column, meanings] of Object.entries(enumMap)) {
    const entry = merged.find((e) => e.column === column);
    const values: EnumValue[] = Object.entries(meanings).map(([value, meaning]) => ({ value, meaning }));
    if (entry) {
      entry.values = values;
    } else {
      merged.push({ table: tableName, column, values });
    }
  }
  return merged;
}
