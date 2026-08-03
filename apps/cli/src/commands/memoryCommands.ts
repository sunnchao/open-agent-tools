import chalk from "chalk";
import {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type MemoryScope,
  type MemoryStore,
  type MemoryType,
} from "../store/memory.ts";

export interface MemoryCommandContext {
  store: MemoryStore;
  ask: (question: string) => Promise<string>;
}

function isScope(value: string | undefined): value is MemoryScope {
  return !!value && (MEMORY_SCOPES as readonly string[]).includes(value);
}

function isType(value: string | undefined): value is MemoryType {
  return !!value && (MEMORY_TYPES as readonly string[]).includes(value);
}

function printMeta(entry: ReturnType<MemoryStore["list"]>[number]): void {
  const review = entry.unreviewed ? chalk.yellow(" [待审核]") : "";
  const date = chalk.dim(new Date(entry.updatedAt).toLocaleString("zh-CN"));
  console.log(
    `  ${chalk.cyan(entry.slug)} ${chalk.magenta(`[${entry.scope}/${entry.type}]`)}${review} ${entry.headline} ${date}`,
  );
  if (entry.description && entry.description !== entry.headline) {
    console.log(chalk.dim(`    ${entry.description}`));
  }
}

function printMemoryHelp(): void {
  console.log(chalk.bold("\nMemory 命令:"));
  console.log(`  ${chalk.cyan("/memory search <query>")}       - 检索已审核记忆`);
  console.log(`  ${chalk.cyan("/memory list [type|scope]")}   - 列出记忆（含待审核）`);
  console.log(`  ${chalk.cyan("/memory read <slug> [scope]")} - 查看记忆全文`);
  console.log(`  ${chalk.cyan("/memory accept <slug> [scope]")} - 接受一条记忆提议`);
  console.log(`  ${chalk.cyan("/memory reject <slug> [scope]")} - 拒绝并删除待审核提议`);
  console.log(`  ${chalk.cyan("/memory review")}               - 逐条审核全部提议`);
  console.log(`  ${chalk.cyan("/memory daily [scope]")}        - 查看今日日志`);
  console.log(`  ${chalk.cyan("/memory quota")}                - 查看记忆配额`);
  console.log(`  ${chalk.cyan("/memory organize")}             - 查看重复合并建议（dry-run）`);
  console.log(`  ${chalk.cyan("/memory wipe [scope]")}         - 清空记忆（需输入确认短语）\n`);
}

export async function handleMemoryCommand(
  input: string,
  context: MemoryCommandContext,
): Promise<boolean> {
  const trimmed = input.trim();
  if (trimmed === "/memory" || trimmed === "/memory help") {
    printMemoryHelp();
    return true;
  }
  if (!trimmed.startsWith("/memory ")) return false;

  const args = trimmed.slice("/memory ".length).trim().split(/\s+/);
  const subcommand = args[0] ?? "";

  try {
    if (subcommand === "search") {
      const query = trimmed.slice("/memory search ".length).trim();
      if (!query) {
        console.log(chalk.red("用法: /memory search <query>"));
        return true;
      }
      const matches = context.store.search(query, { limit: 20, includeUnreviewed: false });
      if (matches.length === 0) {
        console.log(chalk.dim("没有匹配的已审核记忆"));
      } else {
        console.log(chalk.bold(`\n记忆检索结果 (${matches.length}):`));
        for (const match of matches) {
          printMeta(match.meta);
          console.log(
            chalk.dim(`    score=${match.score.toFixed(2)} 命中=${match.matchedBy.join(",")}`),
          );
        }
        console.log();
      }
      return true;
    }

    if (subcommand === "list") {
      const filter = args[1];
      const entries = context.store.list({
        ...(isType(filter) ? { type: filter } : {}),
        ...(isScope(filter) ? { scope: filter } : {}),
        limit: 100,
        includeUnreviewed: true,
      });
      if (filter && !isType(filter) && !isScope(filter)) {
        console.log(chalk.red(`无效过滤器: ${filter}，应为 type 或 scope`));
        return true;
      }
      if (entries.length === 0) {
        console.log(chalk.dim("暂无记忆"));
      } else {
        console.log(chalk.bold(`\n长期记忆 (${entries.length}):`));
        for (const entry of entries) printMeta(entry);
        console.log();
      }
      return true;
    }

    if (subcommand === "read") {
      const slug = args[1];
      const scope = args[2];
      if (!slug || (scope && !isScope(scope))) {
        console.log(chalk.red("用法: /memory read <slug> [global|project]"));
        return true;
      }
      const entry = context.store.read(slug, isScope(scope) ? scope : undefined);
      if (!entry) {
        console.log(chalk.red(`记忆不存在: ${slug}`));
      } else {
        console.log(chalk.bold(`\n${entry.meta.headline}`));
        console.log(
          chalk.dim(
            `${entry.meta.slug} · ${entry.meta.scope}/${entry.meta.type} · ${entry.meta.unreviewed ? "待审核" : "已审核"}`,
          ),
        );
        console.log(`\n${entry.body}\n`);
      }
      return true;
    }

    if (subcommand === "accept") {
      const slug = args[1];
      const scope = args[2];
      if (!slug || (scope && !isScope(scope))) {
        console.log(chalk.red("用法: /memory accept <slug> [global|project]"));
        return true;
      }
      const entry = context.store.accept(slug, isScope(scope) ? scope : undefined);
      console.log(chalk.green(`✓ 已接受记忆: ${entry.meta.slug}`));
      return true;
    }

    if (subcommand === "reject") {
      const slug = args[1];
      const scope = args[2];
      if (!slug || (scope && !isScope(scope))) {
        console.log(chalk.red("用法: /memory reject <slug> [global|project]"));
        return true;
      }
      const entry = context.store.read(slug, isScope(scope) ? scope : undefined);
      if (!entry) {
        console.log(chalk.red(`记忆不存在: ${slug}`));
      } else if (!entry.meta.unreviewed) {
        console.log(chalk.red("仅能直接 reject 待审核记忆；已审核记忆请使用 wipe 或后续编辑能力"));
      } else {
        context.store.remove(slug, isScope(scope) ? scope : undefined, "review rejected");
        console.log(chalk.dim(`已拒绝并移除: ${slug}`));
      }
      return true;
    }

    if (subcommand === "review") {
      const pending = context.store
        .list({ limit: 100, includeUnreviewed: true })
        .filter((entry) => entry.unreviewed);
      if (pending.length === 0) {
        console.log(chalk.dim("没有待审核记忆"));
        return true;
      }
      let acceptRest = false;
      for (const meta of pending) {
        const entry = context.store.read(meta.slug, meta.scope);
        if (!entry) continue;
        console.log(chalk.bold(`\n${meta.headline}`));
        console.log(chalk.dim(`${meta.slug} · ${meta.scope}/${meta.type}`));
        console.log(entry.body.length > 1_000 ? `${entry.body.slice(0, 1_000)}…` : entry.body);
        let answer = "a";
        if (!acceptRest) {
          answer = (
            await context.ask(
              chalk.yellow("接受此记忆？ [a=接受 / A=接受本次剩余全部 / n=拒绝 / s=跳过] "),
            )
          ).trim();
        }
        if (answer === "A") acceptRest = true;
        if (answer === "a" || answer === "A" || answer === "" || acceptRest) {
          context.store.accept(meta.slug, meta.scope);
          console.log(chalk.green(`✓ 已接受: ${meta.slug}`));
        } else if (answer === "n") {
          context.store.remove(meta.slug, meta.scope, "review rejected");
          console.log(chalk.dim(`已拒绝: ${meta.slug}`));
        } else {
          console.log(chalk.dim(`已跳过: ${meta.slug}`));
        }
      }
      console.log();
      return true;
    }

    if (subcommand === "daily") {
      const scopeArg = args[1];
      if (scopeArg && !isScope(scopeArg)) {
        console.log(chalk.red("用法: /memory daily [global|project]"));
        return true;
      }
      const scope: MemoryScope = isScope(scopeArg) ? scopeArg : "project";
      const entry = context.store.todayDaily(scope);
      if (!entry) console.log(chalk.dim(`暂无 ${scope} 今日日志`));
      else console.log(chalk.bold(`\n${entry.meta.headline}\n`) + entry.body + "\n");
      return true;
    }

    if (subcommand === "quota") {
      console.log(chalk.bold("\n记忆配额:"));
      for (const item of context.store.quota()) {
        const usage = `${item.count}/${item.limit}`;
        console.log(
          `  ${chalk.cyan(item.scope)} ${item.exceeded ? chalk.red(usage) : chalk.green(usage)}`,
        );
      }
      console.log();
      return true;
    }

    if (subcommand === "organize") {
      const suggestions = context.store.organizeSuggestions();
      if (suggestions.length === 0) {
        console.log(chalk.dim("暂未发现高相似度记忆"));
      } else {
        console.log(chalk.bold("\n记忆整理建议（dry-run，不会修改文件）:"));
        for (const item of suggestions) {
          console.log(
            `  ${chalk.cyan(item.left.slug)} ↔ ${chalk.cyan(item.right.slug)} ${chalk.yellow(`${Math.round(item.similarity * 100)}%`)}`,
          );
        }
        console.log();
      }
      return true;
    }

    if (subcommand === "wipe") {
      const scopeArg = args[1];
      if (scopeArg && !isScope(scopeArg)) {
        console.log(chalk.red("用法: /memory wipe [global|project]"));
        return true;
      }
      const target = scopeArg ?? "全部 global 与 project";
      console.log(chalk.bold.red("⚠ 此操作会永久删除选定的长期记忆文件与索引记录。"));
      const confirmation = await context.ask(`如确定清空 ${target}，请输入 WIPE MEMORY: `);
      if (confirmation.trim() !== "WIPE MEMORY") {
        console.log(chalk.dim("已取消"));
        return true;
      }
      const removed = context.store.wipeAll(isScope(scopeArg) ? scopeArg : undefined);
      console.log(chalk.green(`✓ 已清空 ${removed} 条记忆`));
      return true;
    }

    printMemoryHelp();
    return true;
  } catch (error) {
    console.log(
      chalk.red(`Memory 操作失败: ${error instanceof Error ? error.message : String(error)}`),
    );
    return true;
  }
}
