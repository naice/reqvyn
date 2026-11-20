/**
 * Dependency-free JSON Schema validator covering the commonly used subset of draft-07 / 2019-09 /
 * 2020-12 (and OpenAPI 3 component schemas). Unknown keywords are ignored. `format` checks are lenient.
 */

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

type Schema = Record<string, unknown> | boolean;

const MAX_ERRORS = 50;
const MAX_DEPTH = 200;

const FORMATS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/,
  'uri-reference': /^[^\s]*$/,
  url: /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+$/,
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  ipv4: /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/,
  ipv6: /^[0-9a-fA-F:.]+$/,
  hostname: /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*\.?$/,
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function short(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function decodePointerToken(t: string): string {
  return decodeURIComponent(t).replace(/~1/g, '/').replace(/~0/g, '~');
}

class Validator {
  readonly errors: string[] = [];
  constructor(private readonly root: unknown) {}

  private add(path: string, msg: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push(`${path || '$'}: ${msg}`);
  }

  private resolveRef(ref: string): Schema | undefined {
    if (!ref.startsWith('#')) return undefined;
    const pointer = ref.slice(1);
    if (pointer === '') return this.root as Schema;
    if (!pointer.startsWith('/')) return undefined;
    let cur: unknown = this.root;
    for (const tok of pointer.slice(1).split('/').map(decodePointerToken)) {
      if (typeof cur !== 'object' || cur === null) return undefined;
      cur = (cur as Record<string, unknown>)[tok];
    }
    return cur === undefined ? undefined : (cur as Schema);
  }

  /** Validate and return whether valid; errors are collected only when `collect` is true. */
  validate(schema: unknown, data: unknown, path: string, depth = 0, collect = true): boolean {
    if (depth > MAX_DEPTH) {
      if (collect) this.add(path, 'schema nesting too deep (possible $ref cycle)');
      return false;
    }
    if (schema === true || schema === undefined) return true;
    if (schema === false) {
      if (collect) this.add(path, 'no value is allowed here (schema is false)');
      return false;
    }
    if (typeof schema !== 'object' || schema === null) return true;
    const s = schema as Record<string, unknown>;
    let ok = true;
    const fail = (msg: string) => {
      ok = false;
      if (collect) this.add(path, msg);
    };

    if (typeof s.$ref === 'string') {
      const target = this.resolveRef(s.$ref);
      if (target === undefined) fail(`cannot resolve $ref "${s.$ref}" (only local references are supported)`);
      else if (!this.validate(target, data, path, depth + 1, collect)) ok = false;
    }

    // OpenAPI 3.0 `nullable`
    if (s.nullable === true && data === null) return ok;

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => matchesType(data, t))) fail(`expected type ${types.join(' | ')} but got ${typeOf(data)}`);
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, data))) {
      fail(`value ${short(data)} is not one of ${short(s.enum)}`);
    }
    if ('const' in s && !deepEqual(s.const, data)) fail(`value ${short(data)} does not equal const ${short(s.const)}`);

    if (typeof data === 'number') {
      if (typeof s.minimum === 'number') {
        if (s.exclusiveMinimum === true ? data <= s.minimum : data < s.minimum)
          fail(`${data} is less than ${s.exclusiveMinimum === true ? 'or equal to ' : ''}minimum ${s.minimum}`);
      }
      if (typeof s.maximum === 'number') {
        if (s.exclusiveMaximum === true ? data >= s.maximum : data > s.maximum)
          fail(`${data} is greater than ${s.exclusiveMaximum === true ? 'or equal to ' : ''}maximum ${s.maximum}`);
      }
      if (typeof s.exclusiveMinimum === 'number' && data <= s.exclusiveMinimum)
        fail(`${data} must be greater than ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === 'number' && data >= s.exclusiveMaximum)
        fail(`${data} must be less than ${s.exclusiveMaximum}`);
      if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
        const q = data / s.multipleOf;
        if (Math.abs(q - Math.round(q)) > 1e-9) fail(`${data} is not a multiple of ${s.multipleOf}`);
      }
    }

    if (typeof data === 'string') {
      const len = [...data].length;
      if (typeof s.minLength === 'number' && len < s.minLength) fail(`string length ${len} is less than minLength ${s.minLength}`);
      if (typeof s.maxLength === 'number' && len > s.maxLength) fail(`string length ${len} is greater than maxLength ${s.maxLength}`);
      if (typeof s.pattern === 'string') {
        try {
          if (!new RegExp(s.pattern, 'u').test(data)) fail(`string ${short(data)} does not match pattern ${s.pattern}`);
        } catch {
          try {
            if (!new RegExp(s.pattern).test(data)) fail(`string ${short(data)} does not match pattern ${s.pattern}`);
          } catch {
            fail(`invalid pattern in schema: ${s.pattern}`);
          }
        }
      }
      if (typeof s.format === 'string') {
        const re = FORMATS[s.format];
        let valid = re ? re.test(data) : true;
        if (valid && (s.format === 'date-time' || s.format === 'date')) valid = !Number.isNaN(Date.parse(data.replace(' ', 'T')));
        if (!valid) fail(`string ${short(data)} is not a valid ${s.format}`);
      }
    }

    if (Array.isArray(data)) {
      if (typeof s.minItems === 'number' && data.length < s.minItems) fail(`array has ${data.length} items, fewer than minItems ${s.minItems}`);
      if (typeof s.maxItems === 'number' && data.length > s.maxItems) fail(`array has ${data.length} items, more than maxItems ${s.maxItems}`);
      if (s.uniqueItems === true) {
        outer: for (let i = 0; i < data.length; i++)
          for (let j = i + 1; j < data.length; j++)
            if (deepEqual(data[i], data[j])) {
              fail(`array items at index ${i} and ${j} are equal but uniqueItems is required`);
              break outer;
            }
      }
      let tupleLen = 0;
      const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : undefined;
      if (tuple) {
        tupleLen = tuple.length;
        tuple.forEach((sub, i) => {
          if (i < data.length && !this.validate(sub, data[i], `${path}[${i}]`, depth + 1, collect)) ok = false;
        });
        const rest = Array.isArray(s.prefixItems) ? s.items : s.additionalItems;
        if (rest !== undefined && !Array.isArray(rest)) {
          for (let i = tupleLen; i < data.length; i++)
            if (!this.validate(rest, data[i], `${path}[${i}]`, depth + 1, collect)) ok = false;
        }
      } else if (s.items !== undefined) {
        data.forEach((item, i) => {
          if (!this.validate(s.items, item, `${path}[${i}]`, depth + 1, collect)) ok = false;
        });
      }
      if (s.contains !== undefined && !data.some((item) => this.validate(s.contains, item, path, depth + 1, false))) {
        fail('array does not contain an item matching "contains"');
      }
    }

    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (Array.isArray(s.required)) {
        for (const r of s.required as string[]) if (!(r in obj)) fail(`missing required property "${r}"`);
      }
      if (typeof s.minProperties === 'number' && keys.length < s.minProperties) fail(`object has fewer than ${s.minProperties} properties`);
      if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) fail(`object has more than ${s.maxProperties} properties`);
      const props = (typeof s.properties === 'object' && s.properties !== null ? s.properties : {}) as Record<string, unknown>;
      const patternProps = (typeof s.patternProperties === 'object' && s.patternProperties !== null ? s.patternProperties : {}) as Record<string, unknown>;
      for (const k of keys) {
        const childPath = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path || '$'}.${k}` : `${path || '$'}[${JSON.stringify(k)}]`;
        let matched = false;
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          matched = true;
          if (!this.validate(props[k], obj[k], childPath, depth + 1, collect)) ok = false;
        }
        for (const [pat, sub] of Object.entries(patternProps)) {
          let re: RegExp | undefined;
          try {
            re = new RegExp(pat);
          } catch {
            re = undefined;
          }
          if (re?.test(k)) {
            matched = true;
            if (!this.validate(sub, obj[k], childPath, depth + 1, collect)) ok = false;
          }
        }
        if (!matched && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) fail(`additional property "${k}" is not allowed`);
          else if (!this.validate(s.additionalProperties, obj[k], childPath, depth + 1, collect)) ok = false;
        }
      }
    }

    if (Array.isArray(s.allOf)) {
      for (const sub of s.allOf) if (!this.validate(sub, data, path, depth + 1, collect)) ok = false;
    }
    if (Array.isArray(s.anyOf)) {
      if (!s.anyOf.some((sub) => this.validate(sub, data, path, depth + 1, false))) {
        fail(`value ${short(data)} does not match any of the ${s.anyOf.length} anyOf schemas`);
      }
    }
    if (Array.isArray(s.oneOf)) {
      const n = s.oneOf.filter((sub) => this.validate(sub, data, path, depth + 1, false)).length;
      if (n !== 1) fail(`value ${short(data)} must match exactly one oneOf schema but matched ${n}`);
    }
    if (s.not !== undefined && this.validate(s.not, data, path, depth + 1, false)) fail('value must not match the "not" schema');
    if (s.if !== undefined) {
      const branch = this.validate(s.if, data, path, depth + 1, false) ? s.then : s.else;
      if (branch !== undefined && !this.validate(branch, data, path, depth + 1, collect)) ok = false;
    }
    return ok;
  }
}

/** Validate `data` against `schema`. Never throws; malformed schemas yield errors. */
export function validateJsonSchema(schema: unknown, data: unknown): SchemaValidationResult {
  if (schema !== true && schema !== false && (typeof schema !== 'object' || schema === null || Array.isArray(schema))) {
    return { valid: false, errors: ['schema must be a JSON object or boolean'] };
  }
  const v = new Validator(schema);
  try {
    const valid = v.validate(schema, data, '$');
    return { valid, errors: valid ? [] : v.errors.length ? v.errors : ['value does not match schema'] };
  } catch (e) {
    return { valid: false, errors: [`schema validation failed: ${(e as Error).message}`] };
  }
}
