/**
 * markdown 终端渲染验证脚本。
 * 用一段覆盖常见语法的示例 markdown 调用 renderMarkdown，打印到控制台，
 * 直观验证 marked-terminal 的渲染效果（标题/代码块/列表/表格/加粗/引用/链接）。
 *
 * 运行：pnpm render:demo   （或 npx tsx scripts/markdown-demo.ts）
 */
import { renderMarkdown } from "../src/ui/markdown.ts";

const sample = `# 标题 H1
## 标题 H2
### 标题 H3

这是一段**加粗**、*斜体*、\`行内代码\` 和[链接](https://example.com)的混排文本。

> 这是一段引用。
> 引用可以跨多行，用来强调重要结论。

无序列表：
- 苹果
- 香蕉
  - 子项：芒果
  - 子项：荔枝
- 橙子

有序列表：
1. 第一步
2. 第二步
3. 第三步

代码块（带语言标注）：

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
console.log(greet("world"));
\`\`\`

表格：

| 名称 | 类型 | 备注 |
|------|------|------|
| id   | int  | 主键 |
| name | text | 非空 |

~~删除线~~ 也可以渲染。
`;

console.log(renderMarkdown(sample));
console.log("\n--- 空输入边界 ---");
console.log(JSON.stringify(renderMarkdown("   ")));
