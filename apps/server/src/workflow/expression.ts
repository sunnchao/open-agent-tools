type Token =
  | { type: "literal"; value: unknown }
  | { type: "operator"; value: string }
  | { type: "left" }
  | { type: "right" }
  | { type: "eof" };

const operators = ["===", "!==", ">=", "<=", "==", "!=", "&&", "||", ">", "<", "!"];

function tokenize(source: string): Token[] {
  if (source.length > 10_000) throw new Error("condition expression is too long");
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ type: "left" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "right" });
      index += 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < source.length) {
        const value = source[end]!;
        if (!escaped && value === '"') break;
        escaped = !escaped && value === "\\";
        if (value !== "\\") escaped = false;
        end += 1;
      }
      if (end >= source.length) throw new Error("unterminated string literal");
      const raw = source.slice(index, end + 1);
      try {
        tokens.push({ type: "literal", value: JSON.parse(raw) as unknown });
      } catch {
        throw new Error("invalid string literal");
      }
      index = end + 1;
      continue;
    }
    const number = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      tokens.push({ type: "literal", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const keyword = source.slice(index).match(/^(true|false|null)\b/);
    if (keyword) {
      tokens.push({
        type: "literal",
        value: keyword[0] === "true" ? true : keyword[0] === "false" ? false : null,
      });
      index += keyword[0].length;
      continue;
    }
    const operator = operators.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push({ type: "operator", value: operator });
      index += operator.length;
      continue;
    }
    throw new Error(`unsupported token near ${JSON.stringify(source.slice(index, index + 16))}`);
  }

  tokens.push({ type: "eof" });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): unknown {
    const value = this.parseOr();
    if (this.current().type !== "eof") throw new Error("unexpected token after expression");
    return value;
  }

  private current(): Token {
    return this.tokens[this.index] ?? { type: "eof" };
  }

  private matchOperator(value: string): boolean {
    const token = this.current();
    if (token.type !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private parseOr(): unknown {
    let value = this.parseAnd();
    while (this.matchOperator("||")) {
      const right = this.parseAnd();
      value = Boolean(value) || Boolean(right);
    }
    return value;
  }

  private parseAnd(): unknown {
    let value = this.parseEquality();
    while (this.matchOperator("&&")) {
      const right = this.parseEquality();
      value = Boolean(value) && Boolean(right);
    }
    return value;
  }

  private parseEquality(): unknown {
    let value = this.parseComparison();
    for (;;) {
      if (this.matchOperator("===") || this.matchOperator("==")) {
        value = Object.is(value, this.parseComparison());
      } else if (this.matchOperator("!==") || this.matchOperator("!=")) {
        value = !Object.is(value, this.parseComparison());
      } else {
        return value;
      }
    }
  }

  private parseComparison(): unknown {
    let value = this.parseUnary();
    for (;;) {
      if (this.matchOperator(">=")) value = compare(value, this.parseUnary(), ">=");
      else if (this.matchOperator("<=")) value = compare(value, this.parseUnary(), "<=");
      else if (this.matchOperator(">")) value = compare(value, this.parseUnary(), ">");
      else if (this.matchOperator("<")) value = compare(value, this.parseUnary(), "<");
      else return value;
    }
  }

  private parseUnary(): unknown {
    if (this.matchOperator("!")) return !Boolean(this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const token = this.current();
    if (token.type === "literal") {
      this.index += 1;
      return token.value;
    }
    if (token.type === "left") {
      this.index += 1;
      const value = this.parseOr();
      if (this.current().type !== "right") throw new Error("missing closing parenthesis");
      this.index += 1;
      return value;
    }
    throw new Error("expected a literal or parenthesized expression");
  }
}

function compare(left: unknown, right: unknown, operator: ">=" | "<=" | ">" | "<"): boolean {
  if (!(
    (typeof left === "number" && typeof right === "number") ||
    (typeof left === "string" && typeof right === "string")
  )) {
    throw new Error("comparison operands must have matching string or number types");
  }
  if (operator === ">=") return left >= right;
  if (operator === "<=") return left <= right;
  if (operator === ">") return left > right;
  return left < right;
}

export function evaluateConditionExpression(source: string): boolean {
  const result = new Parser(tokenize(source)).parse();
  if (typeof result !== "boolean") throw new Error("condition expression must return boolean");
  return result;
}
