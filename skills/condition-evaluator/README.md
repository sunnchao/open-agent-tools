# Dify 条件分支优化 Skill

## 核心功能

### 1. 条件分支评估器 (Condition Evaluator)
支持完整的条件分支评估，替代手动编写表达式。

### 2. 变量聚合器 (Variable Aggregator)
将多个分支结果聚合为单一变量。

## 快速开始

### 1. 安装 Skill

```bash
# 移动到项目 skills 目录
cp -r condition-evaluator /path/to/your/project/skills/
```

### 2. 使用示例

#### 条件分支评估器
```yaml
type: condition-evaluator
conditions:
  - type: contains
    variable: user_input.text
    value: "关键词"
  - type: equals
    variable: sys.user_id
    value: "123"
  - type: greater_than
    variable: files.size
    value: 1000
```

#### 变量聚合器
```yaml
type: variable-aggregator
inputVariables:
  - name: is_valid
    type: boolean
    value: true
  - name: user_data
    type: object
    value: {"id": "123"}
output_variable: aggregated_result
```

## 详细文档

请查看 `condition-evaluator/README.md` 获取完整使用指南。

