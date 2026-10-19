# 条件分支优化 Skill

## 基本信息
- **名称**: `condition-evaluator`
- **描述**: 提供可视化条件分支评估、变量聚合等工具，减少手动表达式编写。
- **作者**: Codex Agent
- **版本**: 1.0.0

## 核心功能

### 1. 条件分支评估器 (Condition Evaluator)
支持以下条件类型（可扩展）：

| 条件类型 | 描述 | 示例表达式 |
|---------|------|-----------|
| contains | 包含 | `text contains "关键词"` |
| not_contains | 不包含 | `text not contains "关键词"` |
| starts_with | 以...开头 | `text starts with "前缀"` |
| ends_with | 以...结尾 | `text ends with "后缀"` |
| equals | 等于 | `text equals "值"` |
| not_equals | 不等于 | `text not equals "值"` |
| is_empty | 为空 | `text is empty` |
| is_not_empty | 不为空 | `text is not empty` |
| greater_than | 大于（数值） | `number > 10` |
| less_than | 小于（数值） | `number < 10` |
| in | 在列表中 | `text in ["a", "b", "c"]` |

### 2. 变量聚合器 (Variable Aggregator)
将多个变量或分支结果聚合为单一变量，便于下游节点使用。

### 3. 智能变量选择器
提供智能变量提示，减少手动输入。

## 使用方法

### 安装方式
将此 Skill 放入 `~/.codex/skills/` 或项目 `skills/` 目录下。

### 使用示例

#### 1. 条件分支评估器
```yaml
type: condition-evaluator
conditions:
  - type: contains
    variable: user_input.text
    value: "关键词"
  - type: equals
    variable: sys.user_id
    value: "123"
```

#### 2. 变量聚合器
```yaml
type: variable-aggregator
input_variables:
  - name: valid_user
    type: boolean
    value: true
  - name: user_data
    type: object
    value: {"id": "123", "name": "张三"}
output_variable: aggregated_result
```

## 扩展计划
- 支持更多条件类型（JSON Path、时间格式等）
- 提供可视化编辑器界面
- 集成到 Dify 条件分支节点

