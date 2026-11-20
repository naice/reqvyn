/**
 * Dependency-free JSONPath subset used by scriptless assertions and request chaining.
 *
 * Supported syntax:
 *   $                 root (optional: bare paths such as `data.items[0].id` are implicitly rooted)
 *   .key  ['key']     child member (also ["key"], and unions ['a','b'])
 *   [n]  [-1]         array index (negative counts from the end), unions [0,2]
 *   .*  [*]           wildcard over array elements / object values
 *   ..key  ..*  ..[n] recursive descent
 *   [start:end:step]  array slice (Python semantics)
 *   [?(expr)]         filter: @ / $ paths, literals (numbers, 'strings', true, false, null),
 *                     ==, !=, <, <=, >, >=, =~ /regex/flags, &&, ||, !, parentheses, and bare
 *                     paths as existence checks (`[?(@.email)]`).
 *   .length           on arrays/strings when no such member exists
 */

export class JsonPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonPathError';
  }
}

type Selector =
  | { type: 'name'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' }
  | { type: 'slice'; start?: number; end?: number; step?: number }
  | { type: 'union'; items: Array<{ type: 'name'; name: string } | { type: 'index'; index: number }> }
  | { type: 'filter'; expr: FilterExpr };

interface Segment {
  recursive: boolean;
  selector: Selector;
}

type FilterExpr =
  | { type: 'or' | 'and'; left: FilterExpr; right: FilterExpr }
  | { type: 'not'; expr: FilterExpr }
  | { type: 'cmp'; op: '==' | '!=' | '<' | '<=' | '>' | '>=' | '=~'; left: Operand; right: Operand }
  | { type: 'exists'; operand: Operand };

type Operand =
  | { type: 'path'; root: '@' | '$'; segments: Segment[] }
  | { type: 'literal'; value: unknown }
  | { type: 'regex'; regex: RegExp };

export interface CompiledJsonPath {
  segments: Segment[];
  /** True when the path can select at most one node (no wildcards, slices, filters, unions or recursion). */
  definite: boolean;
}

const cache = new Map<string, CompiledJsonPath>();

export function compileJsonPath(expr: string): CompiledJsonPath {
  const cached = cache.get(expr);
  if (cached) return cached;
  const p = new Parser(expr);
  const segments = p.parseRootPath();
  const compiled: CompiledJsonPath = {
    segments,
    definite: segments.every((s) => !s.recursive && (s.selector.type === 'name' || s.selector.type === 'index')),
  };
  if (cache.size > 500) cache.clear();
  cache.set(expr, compiled);
  return compiled;
}

/** Evaluate a JSONPath expression and return every matching value (in document order). Throws JsonPathError on invalid syntax. */
export function jsonPath(data: unknown, expr: string): unknown[] {
  const compiled = compileJsonPath(expr);
  return evaluateSegments(compiled.segments, [data], data);
}

/** Like {@link jsonPath} but also reports whether the expression is definite (selects a single node). */
export function jsonPathQuery(data: unknown, expr: string): { values: unknown[]; definite: boolean } {
  const compiled = compileJsonPath(expr);
  return { values: evaluateSegments(compiled.segments, [data], data), definite: compiled.definite };
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function children(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObject(v)) return Object.values(v);
  return [];
}

function descendants(v: unknown, out: unknown[]): void {
  out.push(v);
  for (const c of children(v)) descendants(c, out);
}

function selectName(v: unknown, name: string, out: unknown[]): void {
  if (isObject(v)) {
    if (hasOwn(v, name)) out.push(v[name]);
  } else if (Array.isArray(v)) {
    if (name === 'length') out.push(v.length);
    else if (/^-?\d+$/.test(name)) selectIndex(v, Number(name), out);
  } else if (typeof v === 'string' && name === 'length') {
    out.push(v.length);
  }
}

function selectIndex(v: unknown, index: number, out: unknown[]): void {
  if (Array.isArray(v)) {
    const i = index < 0 ? v.length + index : index;
    if (i >= 0 && i < v.length) out.push(v[i]);
  } else if (isObject(v) && hasOwn(v, String(index))) {
    out.push(v[String(index)]);
  }
}

function applySelector(sel: Selector, v: unknown, root: unknown, out: unknown[]): void {
  switch (sel.type) {
    case 'name':
      selectName(v, sel.name, out);
      return;
    case 'index':
      selectIndex(v, sel.index, out);
      return;
    case 'wildcard':
      out.push(...children(v));
      return;
    case 'union':
      for (const item of sel.items) {
        if (item.type === 'name') selectName(v, item.name, out);
        else selectIndex(v, item.index, out);
      }
      return;
    case 'slice': {
      if (!Array.isArray(v)) return;
      const len = v.length;
      const step = sel.step ?? 1;
      if (step === 0) return;
      const norm = (n: number) => (n < 0 ? Math.max(len + n, step > 0 ? 0 : -1) : Math.min(n, step > 0 ? len : len - 1));
      if (step > 0) {
        const start = sel.start === undefined ? 0 : norm(sel.start);
        const end = sel.end === undefined ? len : norm(sel.end);
        for (let i = start; i < end; i += step) out.push(v[i]);
      } else {
        const start = sel.start === undefined ? len - 1 : norm(sel.start);
        const end = sel.end === undefined ? -1 : norm(sel.end);
        for (let i = start; i > end; i += step) out.push(v[i]);
      }
      return;
    }
    case 'filter':
      for (const c of children(v)) if (evalFilter(sel.expr, c, root)) out.push(c);
      return;
  }
}

function evaluateSegments(segments: Segment[], start: unknown[], root: unknown): unknown[] {
  let nodes = start;
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const n of nodes) {
      if (seg.recursive) {
        const all: unknown[] = [];
        descendants(n, all);
        for (const d of all) applySelector(seg.selector, d, root, next);
      } else {
        applySelector(seg.selector, n, root, next);
      }
    }
    nodes = next;
    if (nodes.length === 0) break;
  }
  return nodes;
}

function operandValues(op: Operand, current: unknown, root: unknown): unknown[] {
  if (op.type === 'literal') return [op.value];
  if (op.type === 'regex') return [op.regex];
  return evaluateSegments(op.segments, [op.root === '@' ? current : root], root);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) => hasOwn(b as object, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

function compare(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case '==':
      return deepEqual(a, b);
    case '!=':
      return !deepEqual(a, b);
    case '=~':
      return b instanceof RegExp && typeof a === 'string' && (b.lastIndex = 0, b.test(a));
    default: {
      const bothNum = typeof a === 'number' && typeof b === 'number';
      const bothStr = typeof a === 'string' && typeof b === 'string';
      if (!bothNum && !bothStr) return false;
      const x = a as number | string;
      const y = b as number | string;
      if (op === '<') return x < y;
      if (op === '<=') return x <= y;
      if (op === '>') return x > y;
      return x >= y;
    }
  }
}

function evalFilter(expr: FilterExpr, current: unknown, root: unknown): boolean {
  switch (expr.type) {
    case 'or':
      return evalFilter(expr.left, current, root) || evalFilter(expr.right, current, root);
    case 'and':
      return evalFilter(expr.left, current, root) && evalFilter(expr.right, current, root);
    case 'not':
      return !evalFilter(expr.expr, current, root);
    case 'exists': {
      const vals = operandValues(expr.operand, current, root);
      if (expr.operand.type === 'literal') return Boolean(expr.operand.value);
      return vals.length > 0 && vals[0] !== undefined;
    }
    case 'cmp': {
      const left = operandValues(expr.left, current, root);
      const right = operandValues(expr.right, current, root);
      if (left.length === 0 || right.length === 0) return expr.op === '!=' && left.length !== right.length;
      return compare(expr.op, left[0], right[0]);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

const IDENT_START = /[A-Za-z_$À-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\-À-￿]/;

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  private fail(msg: string): never {
    throw new JsonPathError(`Invalid JSONPath "${this.src}": ${msg} at position ${this.pos}`);
  }

  private peek(offset = 0): string {
    return this.src.charAt(this.pos + offset);
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private skipWs(): void {
    while (!this.eof() && /\s/.test(this.peek())) this.pos++;
  }

  parseRootPath(): Segment[] {
    this.skipWs();
    const segments: Segment[] = [];
    if (this.peek() === '$') {
      this.pos++;
    } else if (!this.eof() && this.peek() !== '[' && this.peek() !== '.') {
      // Implicitly rooted bare path: "data.items[0].id"
      segments.push({ recursive: false, selector: { type: 'name', name: this.parseIdent() } });
    }
    segments.push(...this.parseSegments(false));
    this.skipWs();
    if (!this.eof()) this.fail(`unexpected "${this.peek()}"`);
    return segments;
  }

  /** Parse segments until a character that cannot continue a path. */
  private parseSegments(inFilter: boolean): Segment[] {
    const segments: Segment[] = [];
    for (;;) {
      if (inFilter) {
        // whitespace terminates paths inside filters unless followed by a segment char
        const save = this.pos;
        this.skipWs();
        if (this.peek() !== '.' && this.peek() !== '[') {
          this.pos = save;
          return segments;
        }
      }
      const c = this.peek();
      if (c === '.') {
        if (this.peek(1) === '.') {
          this.pos += 2;
          if (this.peek() === '[') segments.push({ recursive: true, selector: this.parseBracket() });
          else if (this.peek() === '*') {
            this.pos++;
            segments.push({ recursive: true, selector: { type: 'wildcard' } });
          } else segments.push({ recursive: true, selector: { type: 'name', name: this.parseIdent() } });
        } else {
          this.pos++;
          if (this.peek() === '*') {
            this.pos++;
            segments.push({ recursive: false, selector: { type: 'wildcard' } });
          } else if (this.peek() === '[') {
            segments.push({ recursive: false, selector: this.parseBracket() });
          } else segments.push({ recursive: false, selector: { type: 'name', name: this.parseIdent() } });
        }
      } else if (c === '[') {
        segments.push({ recursive: false, selector: this.parseBracket() });
      } else {
        return segments;
      }
    }
  }

  private parseIdent(): string {
    const start = this.pos;
    if (this.eof() || !(IDENT_START.test(this.peek()) || /[0-9]/.test(this.peek()))) this.fail('expected a member name');
    while (!this.eof() && IDENT_PART.test(this.peek())) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private parseString(): string {
    const quote = this.peek();
    this.pos++;
    let out = '';
    while (!this.eof() && this.peek() !== quote) {
      let c = this.peek();
      if (c === '\\') {
        this.pos++;
        c = this.peek();
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
        if (c === 'u') {
          const hex = this.src.slice(this.pos + 1, this.pos + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 5;
          continue;
        }
        out += map[c] ?? c;
        this.pos++;
        continue;
      }
      out += c;
      this.pos++;
    }
    if (this.eof()) this.fail('unterminated string');
    this.pos++;
    return out;
  }

  private parseInt(): number | undefined {
    this.skipWs();
    const m = /^-?\d+/.exec(this.src.slice(this.pos));
    if (!m) return undefined;
    this.pos += m[0].length;
    return Number(m[0]);
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.peek() !== ch) this.fail(`expected "${ch}"`);
    this.pos++;
  }

  private parseBracket(): Selector {
    this.pos++; // [
    this.skipWs();
    const c = this.peek();
    if (c === '*') {
      this.pos++;
      this.expect(']');
      return { type: 'wildcard' };
    }
    if (c === '?') {
      this.pos++;
      const expr = this.parseOr(); // parentheses are handled by parseUnary
      this.expect(']');
      return { type: 'filter', expr };
    }
    const items: Array<{ type: 'name'; name: string } | { type: 'index'; index: number }> = [];
    // slice?
    const save = this.pos;
    const first = this.parseInt();
    this.skipWs();
    if (this.peek() === ':') {
      const start = first;
      this.pos++;
      const end = this.parseInt();
      this.skipWs();
      let step: number | undefined;
      if (this.peek() === ':') {
        this.pos++;
        step = this.parseInt();
      }
      this.expect(']');
      return { type: 'slice', start, end, step };
    }
    this.pos = save;
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === "'" || ch === '"') items.push({ type: 'name', name: this.parseString() });
      else {
        const n = this.parseInt();
        if (n !== undefined) items.push({ type: 'index', index: n });
        else if (!this.eof() && IDENT_START.test(ch)) items.push({ type: 'name', name: this.parseIdent() });
        else this.fail('expected an index, quoted name, *, slice or filter');
      }
      this.skipWs();
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      this.expect(']');
      break;
    }
    if (items.length === 1) return items[0]!;
    return { type: 'union', items };
  }

  // Filter expressions -------------------------------------------------------------------------

  private parseOr(): FilterExpr {
    let left = this.parseAnd();
    for (;;) {
      this.skipWs();
      if (this.src.startsWith('||', this.pos)) {
        this.pos += 2;
        left = { type: 'or', left, right: this.parseAnd() };
      } else return left;
    }
  }

  private parseAnd(): FilterExpr {
    let left = this.parseUnary();
    for (;;) {
      this.skipWs();
      if (this.src.startsWith('&&', this.pos)) {
        this.pos += 2;
        left = { type: 'and', left, right: this.parseUnary() };
      } else return left;
    }
  }

  private parseUnary(): FilterExpr {
    this.skipWs();
    if (this.peek() === '!' && this.peek(1) !== '=') {
      this.pos++;
      return { type: 'not', expr: this.parseUnary() };
    }
    if (this.peek() === '(') {
      this.pos++;
      const e = this.parseOr();
      this.expect(')');
      return e;
    }
    const left = this.parseOperand();
    this.skipWs();
    const m = /^(==|!=|<=|>=|=~|<|>|===|!==)/.exec(this.src.slice(this.pos));
    if (!m) {
      if (left.type === 'regex') this.fail('a regular expression must be the right-hand side of =~');
      return { type: 'exists', operand: left };
    }
    let op = m[0];
    if (this.src.startsWith('===', this.pos)) op = '===';
    else if (this.src.startsWith('!==', this.pos)) op = '!==';
    this.pos += op.length;
    const norm = (op === '===' ? '==' : op === '!==' ? '!=' : op) as '==' | '!=' | '<' | '<=' | '>' | '>=' | '=~';
    const right = this.parseOperand();
    if (norm === '=~' && right.type !== 'regex') this.fail('=~ requires a /regex/ on the right-hand side');
    return { type: 'cmp', op: norm, left, right };
  }

  private parseOperand(): Operand {
    this.skipWs();
    const c = this.peek();
    if (c === '@' || c === '$') {
      this.pos++;
      return { type: 'path', root: c, segments: this.parseSegments(true) };
    }
    if (c === "'" || c === '"') return { type: 'literal', value: this.parseString() };
    if (c === '/') {
      this.pos++;
      let body = '';
      let inClass = false;
      while (!this.eof()) {
        const ch = this.peek();
        if (ch === '\\') {
          body += ch + this.peek(1);
          this.pos += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        body += ch;
        this.pos++;
      }
      if (this.eof()) this.fail('unterminated regular expression');
      this.pos++;
      const fm = /^[gimsuy]*/.exec(this.src.slice(this.pos));
      const flags = (fm?.[0] ?? '').replace('g', '');
      this.pos += fm?.[0].length ?? 0;
      try {
        return { type: 'regex', regex: new RegExp(body, flags) };
      } catch (e) {
        this.fail(`invalid regular expression /${body}/: ${(e as Error).message}`);
      }
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (num) {
      this.pos += num[0].length;
      return { type: 'literal', value: Number(num[0]) };
    }
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.src.startsWith(word, this.pos) && !IDENT_PART.test(this.peek(word.length))) {
        this.pos += word.length;
        return { type: 'literal', value };
      }
    }
    this.fail('expected @, $, a literal or a /regex/ in filter');
  }
}
