# 条件评估器 Skill

## 安装方法

### 1. 安装到项目

```bash
# 将此目录移动到项目 skills 目录
cp -r condition-evaluator /path/to/your/project/skills/
```

### 2. 启用 Skill

在 Dify 工作流设置中启用此 Skill。

## 使用示例

### 1. 条件分支评估器

```yaml
type: condition-evaluator
conditions:
  - type: contains
    variable: user_input.query
    value: "Dify"
  - type: equals
    variable: sys.user_id
    value: "user_123"
  - type: greater_than
    variable: files.size
    value: 1000
  - type: in
    variable: user_input.category
    value: ["tech", "business", "design"]
```

### 2. 变量聚合器

```yaml
type: variable-aggregator
inputVariables:
  - name: is_valid
    type: boolean
    value: true
  - name: user_info
    type: object
    value:
      id: "user_123"
      name: "张三"
      email: "user@example.com"
output_variable: final_result
```

## 条件类型支持

### 字符串条件
- `contains` - 包含
- `not_contains` - 不包含
- `starts_with` - 以...开头
- `ends_with` - 以...结尾
- `equals` - 等于
- `not_equals` - 不等于
- `is_empty` - 为空
- `is_not_empty` - 不为空
- `regex` - 正则匹配

### 数值条件
- `greater_than` - 大于
- `less_than` - 小于

### 列表条件
- `in` - 在列表中

## 变量聚合器功能

将多个变量聚合为一个对象，便于下游节点统一使用。

## 扩展建议

- 支持更多条件类型
- 提供可视化编辑界面
- 集成到 Dify 条件分支节点

## 贡献

欢迎提交 PR，扩展此 Skill 的功能！

