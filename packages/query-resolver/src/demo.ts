import { preQueryResolve } from "./preQueryResolve.js";
import { caliberToArgs, queryExpenseApprovalJsonSchema } from "./toolSchema.js";
import type { DraftSlots } from "./types.js";
import type { OrgDirectory } from "./resolvers/orgResolver.js";

const orgDirectory: OrgDirectory = [
  { code: "BJ-BRANCH", name: "北京分公司", aliases: ["北分", "北京分", "北京分公司"] },
  { code: "SH-BRANCH", name: "上海分公司", aliases: ["上分", "上海分"] },
  { code: "GZ-BRANCH", name: "广州分公司", aliases: ["广分", "广州分"] },
  { code: "BJ-HQ", name: "北京总部", aliases: ["总部", "北京总部", "集团总部"] },
];

// 演示歧义：把 BJ-HQ 的别名设为"华北分"，与"北分"形成重叠
const ambiguousDir: OrgDirectory = [
  { code: "BJ-BRANCH", name: "北京分公司", aliases: ["北分"] },
  { code: "BJ-HQ", name: "北分公司", aliases: ["华北分"] },
];

function run(label: string, utterance: string, partial: DraftSlots, dir: OrgDirectory, ctx: Partial<Parameters<typeof preQueryResolve>[2]> = {}) {
  return preQueryResolve(utterance, partial, {
    orgDirectory: dir,
    authorizedOrgs: ["BJ-BRANCH", "SH-BRANCH", "GZ-BRANCH"],
    ...ctx,
  }).then((r) => {
    console.log(`\n用户: ${utterance}`);
    if (r.ok) {
      console.log("✅ caliber:", JSON.stringify(r.caliber));
      console.log("→ tool args:", JSON.stringify(caliberToArgs(r.caliber)));
    } else {
      console.log(`⚠️ [${r.reason}] ${r.askUser}`);
    }
    return r;
  });
}

async function main() {
  console.log("===== 1) 成功路径（各自独立，无携带）=====");
  await run("a", "查一下北京分公司上个月的差旅报销审批", {}, orgDirectory);
  await run("b", "上海分 2026年7月 招待费 已通过", {}, orgDirectory);
  await run("c", "广州分 最近30天 餐饮", {}, orgDirectory);

  console.log("\n===== 2) 歧义 / 缺失 / 越权 / 反问 =====");
  await run("d", "北分 上月的差旅", {}, ambiguousDir); // 歧义：北分 vs 北分公司(总部)
  await run("e", "帮我看看差旅报销", {}, orgDirectory); // 缺组织
  await run("f", "最近30天深圳的差旅", {}, orgDirectory); // 组织未匹配
  await run("g", "北京分公司圣诞节那周的差旅", {}, orgDirectory, {
    llmExtract: () => ({ date_raw: "圣诞节那周" }), // 用户给了时间但解析不出
  });
  await run("h", "北京分公司上月差旅", {}, orgDirectory, { authorizedOrgs: ["SH-BRANCH"] }); // 越权

  console.log("\n===== 3) 多轮携带（上下文继承）=====");
  let partial: DraftSlots = {};
  const r1 = await run("i1", "北京分公司上个月的差旅报销审批", partial, orgDirectory);
  partial = r1.draft.slots;
  await run("i2", "换成已通过的", partial, orgDirectory); // 继承 org+period+expense，仅改 status
}

void queryExpenseApprovalJsonSchema;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
