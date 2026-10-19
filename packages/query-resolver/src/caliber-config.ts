import { z } from "zod";

const orgEntrySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  parent: z.string().optional(),
});

const expenseValueSchema = z.enum(["TRAVEL", "MEAL", "ENTERTAIN", "ALL"]);
const statusValueSchema = z.enum(["APPROVED", "REJECTED", "PENDING", "ALL"]);
const timeFieldSchema = z.enum(["submit", "approve", "expense_date"]);

const wordPatternsSchema = <V extends z.ZodType<string>>(value: V) =>
  z.array(
    z.object({
      value,
      words: z.array(z.string().min(1)).min(1),
    }),
  );

/**
 * 可配置口径：抽取/解析所用模式与默认值全部外置。
 * org.directory 必填非空；其余段落缺省时沿用内置默认行为。
 */
export const CaliberConfigSchema = z.object({
  intent: z
    .object({
      /** 正则源串，创建期编译，非法正则立即抛错 */
      queryPatterns: z.array(z.string().min(1)).default([]),
      keywords: z.array(z.string().min(1)).default([]),
    })
    .default({ queryPatterns: [], keywords: [] }),
  org: z.object({
    directory: z.array(orgEntrySchema).min(1),
  }),
  date: z
    .object({
      timezone: z.string().min(1).default("Asia/Shanghai"),
    })
    .default({ timezone: "Asia/Shanghai" }),
  expense: z
    .object({
      patterns: wordPatternsSchema(expenseValueSchema).default([]),
      fallback: expenseValueSchema.default("TRAVEL"),
    })
    .default({ patterns: [], fallback: "TRAVEL" }),
  status: z
    .object({
      patterns: wordPatternsSchema(statusValueSchema).default([]),
      fallback: statusValueSchema.default("APPROVED"),
    })
    .default({ patterns: [], fallback: "APPROVED" }),
  defaults: z
    .object({
      timeField: timeFieldSchema.default("approve"),
    })
    .default({ timeField: "approve" }),
});

export type CaliberConfig = z.infer<typeof CaliberConfigSchema>;
export type CaliberConfigInput = z.input<typeof CaliberConfigSchema>;
