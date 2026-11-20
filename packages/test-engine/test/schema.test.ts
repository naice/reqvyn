import { describe, expect, it } from 'vitest';
import { validateJsonSchema } from '../src/index.js';

const ok = (schema: unknown, data: unknown) => expect(validateJsonSchema(schema, data)).toEqual({ valid: true, errors: [] });
const bad = (schema: unknown, data: unknown, match?: RegExp) => {
  const r = validateJsonSchema(schema, data);
  expect(r.valid).toBe(false);
  expect(r.errors.length).toBeGreaterThan(0);
  if (match) expect(r.errors.join('\n')).toMatch(match);
};

describe('validateJsonSchema', () => {
  it('validates types including arrays of types and integer', () => {
    ok({ type: 'string' }, 'x');
    ok({ type: 'number' }, 1.5);
    ok({ type: 'number' }, 2);
    ok({ type: 'integer' }, 2);
    bad({ type: 'integer' }, 2.5, /expected type integer but got number/);
    ok({ type: ['string', 'null'] }, null);
    bad({ type: ['string', 'null'] }, 1, /string \| null/);
    ok({ type: 'array' }, []);
    bad({ type: 'object' }, [], /got array/);
    ok({ type: 'boolean' }, false);
    ok({ type: 'null' }, null);
  });

  it('validates properties, required and additionalProperties', () => {
    const s = { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id'], additionalProperties: false };
    ok(s, { id: 1, name: 'a' });
    bad(s, { name: 'a' }, /missing required property "id"/);
    bad(s, { id: 1, extra: true }, /additional property "extra" is not allowed/);
    bad(s, { id: 'x' }, /\$\.id: expected type integer/);
    ok({ additionalProperties: { type: 'number' } }, { a: 1, b: 2 });
    bad({ additionalProperties: { type: 'number' } }, { a: 'x' }, /\$\.a/);
    ok({ patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false }, { 'x-a': 'v' });
  });

  it('validates arrays', () => {
    ok({ items: { type: 'number' }, minItems: 1, maxItems: 3 }, [1, 2]);
    bad({ items: { type: 'number' } }, [1, 'a'], /\$\[1\]/);
    bad({ minItems: 2 }, [1], /fewer than minItems 2/);
    bad({ maxItems: 1 }, [1, 2], /more than maxItems 1/);
    ok({ uniqueItems: true }, [1, 2, { a: 1 }]);
    bad({ uniqueItems: true }, [{ a: 1 }, { a: 1 }], /uniqueItems/);
    ok({ items: [{ type: 'string' }, { type: 'number' }] }, ['a', 1]);
    bad({ items: [{ type: 'string' }, { type: 'number' }] }, [1, 'a']);
    bad({ items: [{ type: 'string' }], additionalItems: false }, ['a', 'b']);
    ok({ prefixItems: [{ type: 'string' }], items: { type: 'number' } }, ['a', 1, 2]);
    ok({ contains: { const: 3 } }, [1, 3]);
    bad({ contains: { const: 3 } }, [1, 2], /contains/);
  });

  it('validates enum, const, numbers and strings', () => {
    ok({ enum: ['a', 'b'] }, 'a');
    bad({ enum: ['a', 'b'] }, 'c', /not one of/);
    ok({ const: { x: [1] } }, { x: [1] });
    bad({ const: 1 }, 2, /const/);
    ok({ minimum: 1, maximum: 3 }, 3);
    bad({ minimum: 1 }, 0, /minimum 1/);
    bad({ maximum: 3 }, 4, /maximum 3/);
    bad({ exclusiveMinimum: 1 }, 1, /greater than 1/);
    bad({ exclusiveMaximum: 3 }, 3, /less than 3/);
    bad({ minimum: 1, exclusiveMinimum: true }, 1);
    ok({ multipleOf: 0.1 }, 0.3);
    bad({ multipleOf: 2 }, 3, /multiple of 2/);
    ok({ minLength: 2, maxLength: 3 }, 'ab');
    bad({ minLength: 2 }, 'a', /minLength/);
    bad({ maxLength: 1 }, 'ab', /maxLength/);
    ok({ pattern: '^[a-z]+$' }, 'abc');
    bad({ pattern: '^[a-z]+$' }, 'aB', /pattern/);
  });

  it('validates formats leniently', () => {
    ok({ format: 'email' }, 'ada@example.com');
    bad({ format: 'email' }, 'not-an-email', /email/);
    ok({ format: 'uri' }, 'https://example.com/x?y=1');
    bad({ format: 'uri' }, 'no scheme');
    ok({ format: 'date-time' }, '2024-01-02T03:04:05Z');
    ok({ format: 'date-time' }, '2024-01-02T03:04:05.123+02:00');
    bad({ format: 'date-time' }, '2024-13-45T99:99:99Z');
    ok({ format: 'uuid' }, '123e4567-e89b-12d3-a456-426614174000');
    bad({ format: 'uuid' }, '123', /uuid/);
    ok({ format: 'unknown-format' }, 'whatever');
    ok({ type: 'number', format: 'email' }, 1);
  });

  it('validates combinators', () => {
    ok({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 1);
    bad({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true, /anyOf/);
    ok({ oneOf: [{ type: 'integer' }, { type: 'string' }] }, 1);
    bad({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1, /matched 2/);
    ok({ allOf: [{ type: 'number' }, { minimum: 1 }] }, 2);
    bad({ allOf: [{ type: 'number' }, { minimum: 1 }] }, 0);
    ok({ not: { type: 'string' } }, 1);
    bad({ not: { type: 'string' } }, 'x', /not/);
    ok({ if: { type: 'string' }, then: { minLength: 2 }, else: { type: 'number' } }, 'ab');
    bad({ if: { type: 'string' }, then: { minLength: 2 }, else: { type: 'number' } }, true);
  });

  it('resolves local $refs', () => {
    const defs = { definitions: { id: { type: 'integer' } }, type: 'object', properties: { id: { $ref: '#/definitions/id' } } };
    ok(defs, { id: 1 });
    bad(defs, { id: 'x' });
    const $defs = { $defs: { name: { type: 'string', minLength: 1 } }, items: { $ref: '#/$defs/name' } };
    ok($defs, ['a']);
    bad($defs, ['']);
    const openapi = {
      components: { schemas: { User: { type: 'object', required: ['id'], properties: { friends: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } },
      $ref: '#/components/schemas/User',
    };
    ok(openapi, { id: 1, friends: [{ id: 2, friends: [] }] });
    bad(openapi, { id: 1, friends: [{}] }, /missing required property "id"/);
    bad({ $ref: '#/nope' }, 1, /cannot resolve \$ref/);
    bad({ $ref: 'http://example.com/schema.json' }, 1, /only local/);
    bad({ definitions: { a: { $ref: '#/definitions/a' } }, $ref: '#/definitions/a' }, 1, /too deep/);
  });

  it('supports boolean schemas and OpenAPI nullable', () => {
    ok(true, 1);
    bad(false, 1);
    ok({ properties: { a: false } }, {});
    bad({ properties: { a: false } }, { a: 1 });
    ok({ type: 'string', nullable: true }, null);
  });

  it('rejects malformed schema input without throwing', () => {
    expect(validateJsonSchema('nope', 1).valid).toBe(false);
    expect(validateJsonSchema(null, 1).valid).toBe(false);
    bad({ pattern: '([' }, 'x', /invalid pattern/);
  });
});
