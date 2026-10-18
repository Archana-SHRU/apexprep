/**
 * A safe evaluator for the function plots in a visual explanation: `y = f(x)` written by the model as
 * text, e.g. `2*x^2 - 3x + 1` or `sin(x)/x`.
 *
 * It is a small recursive-descent parser, not `eval` and not `new Function`: the only things a formula
 * can contain are numbers, `x`, the constants `pi` and `e`, the four operators, `^`, parentheses and a
 * fixed list of functions. Anything else is a parse error, so a model cannot smuggle code into a graph.
 * Size is bounded so a pathological formula cannot cost more than a trivial one. Pure.
 */

type Node =
  | { t: 'num'; v: number }
  | { t: 'x' }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { t: 'fn'; name: FnName; a: Node };

const FUNCTIONS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
} as const;
type FnName = keyof typeof FUNCTIONS;

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export const EXPRESSION_LIMITS = { chars: 200, nodes: 200 } as const;

type Token = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const num = /^(\d+(?:\.\d+)?|\.\d+)/.exec(src.slice(i));
    if (num) {
      tokens.push({ k: 'num', v: Number(num[1]) });
      i += num[1]!.length;
      continue;
    }
    const id = /^[a-z][a-z0-9]*/i.exec(src.slice(i));
    if (id) {
      tokens.push({ k: 'id', v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    if ('+-*/^()'.includes(ch)) {
      tokens.push({ k: 'op', v: ch });
      i += 1;
      continue;
    }
    if (ch === '×' || ch === '·') {
      tokens.push({ k: 'op', v: '*' });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character "${ch}"`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  nodes = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.expr();
    if (this.pos !== this.tokens.length) throw new Error('unexpected input after the end of the formula');
    return node;
  }

  private count<T extends Node>(node: T): T {
    this.nodes += 1;
    if (this.nodes > EXPRESSION_LIMITS.nodes) throw new Error('formula is too complex');
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return t?.k === 'op' && t.v === v;
  }

  private expr(): Node {
    let node = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.pos++] as { v: '+' | '-' }).v;
      node = this.count({ t: 'bin', op, a: node, b: this.term() });
    }
    return node;
  }

  private term(): Node {
    let node = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = (this.tokens[this.pos++] as { v: '*' | '/' }).v;
        node = this.count({ t: 'bin', op, a: node, b: this.unary() });
        continue;
      }
      // Implicit multiplication: "3x", "2(x+1)", "x sin(x)".
      const next = this.peek();
      if (next && (next.k === 'num' || next.k === 'id' || (next.k === 'op' && next.v === '('))) {
        node = this.count({ t: 'bin', op: '*', a: node, b: this.power() });
        continue;
      }
      return node;
    }
  }

  private unary(): Node {
    if (this.isOp('-')) {
      this.pos += 1;
      return this.count({ t: 'neg', a: this.unary() });
    }
    if (this.isOp('+')) {
      this.pos += 1;
      return this.unary();
    }
    return this.power();
  }

  /** `^` binds tighter than unary minus and is right-associative: -x^2 = -(x^2), 2^3^2 = 2^9. */
  private power(): Node {
    const base = this.primary();
    if (this.isOp('^')) {
      this.pos += 1;
      return this.count({ t: 'bin', op: '^', a: base, b: this.unary() });
    }
    return base;
  }

  private primary(): Node {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error('the formula ends too early');
    if (t.k === 'num') return this.count({ t: 'num', v: t.v });
    if (t.k === 'op' && t.v === '(') {
      const inner = this.expr();
      if (!this.isOp(')')) throw new Error('missing closing parenthesis');
      this.pos += 1;
      return inner;
    }
    if (t.k === 'id') {
      if (t.v === 'x') return this.count({ t: 'x' });
      // Own properties only: `in` would also accept inherited names such as "constructor" or "toString".
      if (Object.hasOwn(CONSTANTS, t.v)) return this.count({ t: 'num', v: CONSTANTS[t.v]! });
      if (Object.hasOwn(FUNCTIONS, t.v)) {
        if (!this.isOp('(')) throw new Error(`${t.v} needs parentheses`);
        this.pos += 1;
        const arg = this.expr();
        if (!this.isOp(')')) throw new Error('missing closing parenthesis');
        this.pos += 1;
        return this.count({ t: 'fn', name: t.v as FnName, a: arg });
      }
      throw new Error(`unknown name "${t.v}"`);
    }
    throw new Error(`unexpected "${t.v}"`);
  }
}

function evaluate(node: Node, x: number): number {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'x':
      return x;
    case 'neg':
      return -evaluate(node.a, x);
    case 'fn':
      return FUNCTIONS[node.name](evaluate(node.a, x));
    case 'bin': {
      const a = evaluate(node.a, x);
      const b = evaluate(node.b, x);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '^':
          return a ** b;
      }
    }
  }
}

export type CompiledExpression = { ok: true; fn: (x: number) => number } | { ok: false; reason: string };

/** Parses a formula in `x` into an evaluator, or says why it cannot. */
export function compileExpression(src: string): CompiledExpression {
  if (src.length === 0 || src.length > EXPRESSION_LIMITS.chars) return { ok: false, reason: `a formula must be 1-${EXPRESSION_LIMITS.chars} characters` };
  try {
    const tree = new Parser(tokenize(src.replace(/^\s*y\s*=\s*/i, ''))).parse();
    return { ok: true, fn: (x: number) => evaluate(tree, x) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the formula could not be read' };
  }
}

/**
 * Samples `f` across [xMin, xMax] and splits the curve wherever it leaves [yMin, yMax] or is undefined,
 * so an asymptote is drawn as a gap rather than a vertical line across the chart.
 */
export function sampleCurve(fn: (x: number) => number, domain: { xMin: number; xMax: number; yMin: number; yMax: number }, samples = 160): [number, number][][] {
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  for (let i = 0; i <= samples; i += 1) {
    const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / samples;
    const y = fn(x);
    if (Number.isFinite(y) && y >= domain.yMin && y <= domain.yMax) {
      current.push([round4(x), round4(y)]);
    } else if (current.length > 0) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
