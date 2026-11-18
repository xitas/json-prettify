// Unit tests for JSON Schema validation and schema generation in assets/js/json-tools.js.
// (The official test suite runs in schema-suite.test.js.) Run with: node --test

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/js/json-tools.js');

const v = (data, schema, opts) => T.validateSchema(data, schema, opts);
const messages = (data, schema, opts) => v(data, schema, opts).errors.map(e => e.message);
const fmt = parts => T.formatPath(parts, 'js') || '(root)';

describe('validateSchema: messages in plain English', () => {
  test('types, required keys and sizes', () => {
    assert.deepEqual(messages('5', { type: 'number' }), ['Expected a number, got a string']);
    assert.deepEqual(messages(1.5, { type: 'integer' }), ['Expected an integer, got a number with a fraction (1.5)']);
    assert.deepEqual(messages(null, { type: ['string', 'array'] }), ['Expected a string or an array, got null']);
    assert.deepEqual(messages({}, { required: ['email'] }), ['Missing required key email']);
    assert.deepEqual(messages([1, 2, 3, 4, 5, 6], { maxItems: 5 }), ['Must have at most 5 items (has 6)']);
    assert.deepEqual(messages([], { minItems: 1 }), ['Must have at least 1 item (has 0)']);
    assert.deepEqual(messages({ a: 1, b: 2 }, { maxProperties: 1 }), ['Must have at most 1 key (has 2)']);
  });

  test('numbers, strings, enums and objects', () => {
    assert.deepEqual(messages(-1, { minimum: 0 }), ['Must be at least 0']);
    assert.deepEqual(messages(0, { exclusiveMinimum: 0 }), ['Must be greater than 0']);
    assert.deepEqual(messages(11, { maximum: 10 }), ['Must be at most 10']);
    assert.deepEqual(messages(0.35, { multipleOf: 0.1 }), ['Must be a multiple of 0.1']);
    assert.deepEqual(messages('ab', { minLength: 3 }), ['Must have at least 3 characters (has 2)']);
    assert.deepEqual(messages('ABC', { pattern: '^[a-z]+$' }), ['Must match the pattern ^[a-z]+$']);
    assert.deepEqual(messages('x', { enum: ['a', 'b', 1] }), ['Must be one of: "a", "b", 1']);
    assert.deepEqual(messages(4, { const: 5 }), ['Must be exactly 5']);
    assert.deepEqual(messages({ a: 1, extra: 2 }, { properties: { a: {} }, additionalProperties: false }), ['Key "extra" is not allowed']);
    assert.deepEqual(messages({ a: 1 }, { dependentRequired: { a: ['b'] } }), ['Key a requires key b']);
    assert.deepEqual(messages({ BAD: 1 }, { propertyNames: { pattern: '^[a-z]+$' } }), ['Key "BAD": must match the pattern ^[a-z]+$']);
    assert.deepEqual(messages([1, 2, 1], { uniqueItems: true }), ['Items must be unique; items 0 and 2 are the same']);
    assert.deepEqual(messages([1], { contains: { type: 'string' } }), ['Must contain at least 1 item matching the "contains" schema (has 0)']);
    assert.deepEqual(messages(1, { not: { type: 'number' } }), ['Must not match the schema in "not"']);
    assert.deepEqual(messages(1, false), ['No value is allowed here']);
  });

  test('each error has the path to the value, its keyword and where in the schema', () => {
    const r = v({ users: [{ name: 'A' }, { name: 5 }] }, { properties: { users: { items: { properties: { name: { type: 'string' } } } } } });
    assert.equal(r.valid, false);
    assert.equal(r.errors.length, 1);
    assert.equal(fmt(r.errors[0].path), 'users[1].name');
    assert.equal(r.errors[0].keyword, 'type');
    assert.equal(r.errors[0].schemaPath, '#/properties/users/items/properties/name/type');
    const k = v({ a: 1, x: 2 }, { additionalProperties: false, properties: { a: {} } }).errors[0];
    assert.equal(fmt(k.path), 'x');   // the key that is not allowed, so a click goes there
  });
});

describe('validateSchema: numbers and strings done right', () => {
  test('multipleOf works with decimals despite floating point', () => {
    for (const [x, m, ok] of [[0.3, 0.1, true], [0.7, 0.1, true], [19.99, 0.01, true], [0.0075, 0.0001, true], [4.5, 1.5, true], [1.1, 0.1, true],
      [0.35, 0.1, false], [10, 3, false], [1e308, 0.123456789, false], [-0.6, 0.2, true], [0, 0.1, true], [2e-7, 1e-7, true]]) {
      assert.equal(T.isMultipleOf(x, m), ok, `${x} multipleOf ${m}`);
      assert.equal(v(x, { multipleOf: m }).valid, ok, `${x} multipleOf ${m} (validate)`);
    }
  });

  test('string length counts characters, not UTF-16 units or bytes (an emoji is 1)', () => {
    assert.equal(T.codePointLength('😀😀'), 2);
    assert.equal(v('😀😀', { maxLength: 2 }).valid, true);
    assert.equal(v('😀😀', { minLength: 3 }).valid, false);
    assert.equal(v('été', { maxLength: 3 }).valid, true);
  });
});

describe('validateSchema: anyOf and oneOf name the closest option', () => {
  const shapes = {
    anyOf: [
      { type: 'object', properties: { kind: { const: 'circle' }, radius: { type: 'number' } }, required: ['kind', 'radius'] },
      { type: 'object', properties: { kind: { const: 'square' }, side: { type: 'number' } }, required: ['kind', 'side'] }
    ]
  };
  test('a tagged shape with one wrong field reports only that field, from the matching option', () => {
    const r = v({ kind: 'square', side: 'big' }, shapes);
    assert.equal(r.errors[0].keyword, 'anyOf');
    assert.match(r.errors[0].message, /closest is option 2/);
    assert.deepEqual(r.errors.slice(1).map(e => fmt(e.path) + ': ' + e.message), ['side: Expected a number, got a string']);
    assert.equal(r.errors[1].within, 'anyOf option 2');
  });
  test('when only the type is wrong, one short message lists the allowed types', () => {
    assert.deepEqual(messages(true, { anyOf: [{ type: 'string' }, { type: 'number' }] }), ['Expected a string or a number, got a boolean']);
  });
  test('oneOf: no match names the closest option; several matches are named', () => {
    const r = v({ kind: 'circle' }, { oneOf: shapes.anyOf });
    assert.match(r.errors[0].message, /oneOf.*closest is option 1/);
    assert.deepEqual(r.errors.slice(1).map(e => e.message), ['Missing required key radius']);
    assert.deepEqual(messages(5, { oneOf: [{ type: 'number' }, { minimum: 1 }, { type: 'string' }] }), ['Must match exactly one option of "oneOf", but matches options 1 and 2']);
  });
});

describe('validateSchema: references', () => {
  test('$ref, $defs, $anchor, $id in the same document and recursive schemas', () => {
    const tree = { $defs: { node: { type: 'object', properties: { value: { type: 'number' }, children: { type: 'array', items: { $ref: '#/$defs/node' } } } } }, $ref: '#/$defs/node' };
    assert.equal(v({ value: 1, children: [{ value: 2, children: [{ value: 3 }] }] }, tree).valid, true);
    assert.equal(fmt(v({ value: 1, children: [{ children: [{ value: 'x' }] }] }, tree).errors[0].path), 'children[0].children[0].value');
    assert.equal(v('x', { $defs: { s: { $anchor: 'str', type: 'string' } }, $ref: '#str' }).valid, true);
    assert.equal(v(1, { $id: 'https://example.com/root', $defs: { s: { $id: 'string.json', type: 'string' } }, $ref: 'string.json' }).valid, false);
    assert.equal(v([1], { definitions: { n: { type: 'number' } }, items: { $ref: '#/definitions/n' }, $schema: 'http://json-schema.org/draft-07/schema#' }).valid, true);
  });

  test('a reference outside the schema is a clear error, and nothing is downloaded', () => {
    const calls = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (...a) => { calls.push(a); return Promise.reject(new Error('no')); };
    try {
      const r = v({}, { $ref: 'https://example.com/schemas/user.json' });
      assert.match(r.schemaError, /External references aren’t supported, so nothing is downloaded/);
      assert.match(T.runSchemaCheck('{}', '{"properties": {"a": {"$ref": "other.json#/x"}}}', {}).message || '', /^$/);
      assert.match(T.runSchemaCheck('{"a": 1}', '{"properties": {"a": {"$ref": "other.json#/x"}}}', {}).message, /points outside this schema/);
    } finally { globalThis.fetch = saved; }
    assert.equal(calls.length, 0);
  });

  test('a broken pattern is reported as a problem with the schema', () => {
    assert.match(v('x', { pattern: '(' }).schemaError, /isn’t a valid regular expression/);
  });
});

describe('validateSchema: drafts and formats', () => {
  test('the draft comes from $schema, with 2020-12 by default', () => {
    assert.equal(v(1, {}).draft, '2020-12');
    assert.equal(v(1, { $schema: 'http://json-schema.org/draft-07/schema#' }).draft, '07');
    assert.equal(v(1, { $schema: 'https://json-schema.org/draft/2019-09/schema' }).draft, '2020-12');
    assert.match(v(1, { $schema: 'https://json-schema.org/draft/2019-09/schema' }).note, /2019-09 is checked with the draft 2020-12 rules/);
    // draft-07: items as a list, and $ref replaces its siblings
    assert.equal(v([1, 'x'], { $schema: 'http://json-schema.org/draft-07/schema#', items: [{ type: 'number' }], additionalItems: false }).valid, false);
    assert.equal(v(5, { $schema: 'http://json-schema.org/draft-07/schema#', definitions: { a: {} }, $ref: '#/definitions/a', type: 'string' }).valid, true);
  });

  test('format is a note unless checking formats is on', () => {
    assert.equal(v('not an email', { format: 'email' }).valid, true);
    const on = { formats: true };
    for (const [format, good, bad] of [['date-time', '2026-11-18T10:00:00Z', '2026-13-01T10:00:00Z'], ['date', '2024-02-29', '2023-02-29'],
      ['time', '23:59:60Z', '24:00:00Z'], ['email', 'a.b@example.com', 'a..b@example.com'], ['uri', 'https://example.com/a?b#c', '/relative'],
      ['uuid', '2eb8aa08-aa98-11ea-b4aa-73b441d16380', '2eb8aa08-aa98-11ea-b4aa-73b441d1638'], ['ipv4', '192.168.0.1', '192.168.0.256'],
      ['ipv6', '::ffff:192.168.0.1', '1::2::3'], ['hostname', 'www.example.com', '-bad.example'], ['regex', '^a+$', '(']]) {
      assert.equal(v(good, { format }, on).valid, true, `${format} ${good}`);
      assert.equal(v(bad, { format }, on).valid, false, `${format} ${bad}`);
      assert.match(v(bad, { format }, on).errors[0].message, /^Must be a valid /);
    }
  });
});

describe('grouping and lines', () => {
  test('one problem in many places is one group, with the count and the first paths', () => {
    const data = { users: Array.from({ length: 300 }, (_, i) => ({ name: 'u' + i })) };
    const r = v(data, { properties: { users: { items: { required: ['email'] } } } });
    assert.equal(r.errors.length, 300);
    const groups = T.groupSchemaErrors(r.errors);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 300);
    assert.equal(groups[0].message, 'Missing required key email');
    assert.equal(groups[0].paths.length, 50);
    assert.equal(fmt(groups[0].paths[1]), 'users[1]');
  });

  test('errors stop at the cap and say so', () => {
    const r = v(Array.from({ length: 5000 }, () => 'x'), { items: { type: 'number' } }, { maxErrors: 100 });
    assert.equal(r.errors.length, 100);
    assert.equal(r.truncated, true);
  });

  test('line numbers of the values with errors', () => {
    const text = '{\n  "a": 1,\n  "list": [\n    "x",\n    5\n  ]\n}';
    assert.deepEqual(T.linesOfPaths(text, [['a'], ['list', 1], ['list'], [], ['missing']]), [2, 5, 3, 1, null]);
    const r = T.runSchemaCheck(text, '{"properties": {"list": {"items": {"type": "string"}}}}', {});
    assert.equal(r.status, 'ok');
    assert.equal(r.errors[0].line, 5);
  });
});

describe('runSchemaCheck', () => {
  test('reports which side is not valid JSON, and the data’s own $schema', () => {
    assert.equal(T.runSchemaCheck('{"a":', '{}', {}).side, 'data');
    assert.equal(T.runSchemaCheck('{}', '{"type":', {}).side, 'schema');
    const r = T.runSchemaCheck('{"$schema": "http://json-schema.org/draft-07/schema#", "a": 1}', '{}', {});
    assert.deepEqual(r.dataSchema, { uri: 'http://json-schema.org/draft-07/schema#', draft: '07' });
    assert.equal(T.runSchemaCheck('{"$schema": "https://example.com/my-schema.json"}', '{}', {}).dataSchema.draft, null);
  });

  test('the time limit stops a long check', () => {
    const big = JSON.stringify(Array.from({ length: 200000 }, (_, i) => ({ id: i, name: 'n' + i })));
    const r = T.runSchemaCheck(big, '{"items": {"properties": {"name": {"pattern": "^n"}}}}', { limitMs: 1, deadline: Date.now() - 1 });
    assert.deepEqual(r, { status: 'timeout' });
    assert.deepEqual(v([1, 2, 3], { items: { type: 'number' } }, { deadline: Date.now() - 1 }), { valid: true, truncated: false, draft: '2020-12', named: null, note: null, errors: [] });
    assert.deepEqual(v(Array.from({ length: 5000 }, () => 1), { items: { type: 'number' } }, { deadline: Date.now() - 1 }), { timedOut: true });
  });
});

describe('createWorkerHandler: schema checks', () => {
  function harness() {
    const sent = [];
    const handle = T.createWorkerHandler(msg => sent.push(msg));
    return { handle, last: type => [...sent].reverse().find(m => m.type === type) };
  }
  test('validates, keeps both texts by version, and asks for text it does not have', () => {
    const h = harness();
    h.handle({ type: 'validate', id: 'q1', dv: 1, data: '{"a": "x"}', sv: 1, schema: '{"properties": {"a": {"type": "number"}}}', opts: {} });
    assert.equal(h.last('validate').result.errors[0].message, 'Expected a number, got a string');
    h.handle({ type: 'validate', id: 'q2', dv: 1, sv: 2, schema: '{"properties": {"a": {"type": "string"}}}', opts: {} });
    assert.equal(h.last('validate').result.valid, true);
    h.handle({ type: 'validate', id: 'q3', dv: 2, sv: 2, opts: {} });
    assert.deepEqual(h.last('need-text'), { type: 'need-text', id: 'q3' });
    h.handle({ type: 'generateSchema', id: 'q4', text: '{"a": [1, 2]}' });
    assert.deepEqual(h.last('generateSchema').schema.properties.a, { type: 'array', items: { type: 'integer' } });
  });
});

// ---------- generating schemas ----------

function random(seed) {
  let s = seed >>> 0 || 1;
  const next = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
  return { next, int: n => Math.floor(next() * n), pick: l => l[Math.floor(next() * l.length)], chance: p => next() < p };
}
const KEYS = ['id', 'name', 'a b', '', 'kéy', '__proto__', 'constructor', '10', 'status', 'list', 'nested', 'x/y', '$schema', '$ref'];
const SCALARS = [0, 1, -1, 1.5, 1e21, 2e-7, '', 'text', 'paid', 'open', '😀', true, false, null];
function value(r, depth) {
  const x = r.next();
  if (depth > 4 || x < 0.35) return r.pick(SCALARS);
  if (x < 0.55) return Array.from({ length: r.int(6) }, () => value(r, depth + 1));
  if (x < 0.75) return Array.from({ length: r.int(8) }, () => { const o = {}; if (r.chance(0.8)) o.id = r.int(5); if (r.chance(0.6)) o.status = r.pick(['paid', 'open', 'void']); if (r.chance(0.5)) o.v = value(r, depth + 2); return o; });
  const o = {};
  for (let i = r.int(5); i > 0; i--) Object.defineProperty(o, r.pick(KEYS), { value: value(r, depth + 1), enumerable: true, writable: true, configurable: true });
  return o;
}

describe('generateSchema', () => {
  test('required and optional keys, types, nested $defs for repeated shapes, sensible enums', () => {
    const data = {
      orders: [
        { id: 1, status: 'paid', total: 9.5, ship: { city: 'K' } }, { id: 2, status: 'open', total: 3, ship: { city: 'L' }, note: null },
        { id: 3, status: 'paid', total: 1, ship: { city: 'M' } }, { id: 4, status: 'open', total: 2, ship: { city: 'N' } }
      ],
      billing: { city: 'X' },
      names: ['Amina', 'Bilal', 'Chen']
    };
    const s = T.generateSchema(data);
    assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema');
    const order = s.properties.orders.items;
    assert.deepEqual(order.required, ['id', 'status', 'total', 'ship']);
    assert.deepEqual(order.properties.id, { type: 'integer' });
    assert.deepEqual(order.properties.total, { type: 'number' });
    assert.deepEqual(order.properties.status, { type: 'string', enum: ['paid', 'open'] });
    assert.deepEqual(order.properties.note, { type: 'null' });
    assert.deepEqual(order.properties.ship, { $ref: '#/$defs/Ship' });
    assert.deepEqual(s.properties.billing, { $ref: '#/$defs/Ship' });
    assert.deepEqual(s.$defs.Ship, { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] });
    assert.deepEqual(s.properties.names, { type: 'array', items: { type: 'string' } }, 'three different names are not an enum');
    assert.equal(T.validateSchema(data, s).valid, true);
  });

  test('mixed values and empty arrays', () => {
    assert.deepEqual(T.generateSchema([1, 'a', null]), { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', items: { type: ['integer', 'string', 'null'] } });
    assert.deepEqual(T.generateSchema({ e: [] }).properties.e, { type: 'array' });
    const mixed = T.generateSchema([{ a: 1 }, 'x']);
    assert.ok(mixed.items.anyOf, JSON.stringify(mixed));
  });

  test('the TypeScript output is unchanged by the extra notes', () => {
    assert.equal(T.toTypeScript({ a: [1, 2.5], b: 'x' }).text, 'export interface Root {\n  a: number[];\n  b: string;\n}\n');
  });

  test('fuzz: every schema made from 500 random documents accepts its document', () => {
    const r = random(77);
    for (let i = 0; i < 500; i++) {
      const doc = value(r, 0);
      const schema = T.generateSchema(doc);
      const res = T.validateSchema(doc, JSON.parse(JSON.stringify(schema)));
      assert.equal(res.valid, true, `doc ${JSON.stringify(doc)}\nschema ${JSON.stringify(schema)}\nerrors ${JSON.stringify(res.errors)}`);
    }
  });
});
