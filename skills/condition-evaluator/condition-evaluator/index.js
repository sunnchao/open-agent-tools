const { d, log } = require('@dify-ai/core');

// 条件评估器 - 支持更多条件类型
const conditionEvaluator = {
  name: 'condition-evaluator',
  version: '1.0.0',
  
  evaluate: (params) => {
    const { conditions, variables } = params;
    if (!conditions || !Array.isArray(conditions)) {
      return false;
    }
    
    // 按顺序执行所有条件（AND 逻辑）
    for (const condition of conditions) {
      const { type, variable, value, operator } = condition;
      
      if (!variable) {
        continue;
      }
      
      const variableValue = variables[variable];
      if (variableValue === undefined) {
        return false;
      }
      
      let result = false;
      
      switch (type) {
        case 'contains':
          result = String(variableValue).includes(String(value || ''));
          break;
        case 'not_contains':
          result = !String(variableValue).includes(String(value || ''));
          break;
        case 'starts_with':
          result = String(variableValue).startsWith(String(value || ''));
          break;
        case 'ends_with':
          result = String(variableValue).endsWith(String(value || ''));
          break;
        case 'equals':
          result = variableValue === value;
          break;
        case 'not_equals':
          result = variableValue !== value;
          break;
        case 'is_empty':
          result = variableValue === null || variableValue === undefined || 
                  (typeof variableValue === 'string' && variableValue.trim() === '');
          break;
        case 'is_not_empty':
          result = variableValue !== null && variableValue !== undefined && 
                  (typeof variableValue !== 'string' || variableValue.trim() !== '');
          break;
        case 'greater_than':
          result = Number(variableValue) > Number(value);
          break;
        case 'less_than':
          result = Number(variableValue) < Number(value);
          break;
        case 'in':
          const values = Array.isArray(value) ? value : [value];
          result = values.includes(variableValue);
          break;
        case 'regex':
          try {
            const regex = new RegExp(value);
            result = regex.test(String(variableValue));
          } catch (e) {
            result = false;
          }
          break;
        default:
          result = false;
      }
      
      if (!result) {
        return false;
      }
    }
    
    return true;
  }
};

// 变量聚合器
const variableAggregator = {
  name: 'variable-aggregator',
  version: '1.0.0',
  
  aggregate: (params) => {
    const { inputVariables, outputVariable } = params;
    
    if (!inputVariables || !Array.isArray(inputVariables)) {
      return null;
    }
    
    const result = {};
    for (const item of inputVariables) {
      if (item.name) {
        result[item.name] = item.value;
      }
    }
    
    return result;
  }
};

module.exports = {
  conditionEvaluator,
  variableAggregator
};

