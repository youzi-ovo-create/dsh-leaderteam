import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashJson, frozenJsonCopy } from '../../leaderteam/core/canonical.mjs';
test('canonicalJson sorts keys recursively and is whitespace-free', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'é' } }), '{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}');
});
test('hash is key-order independent', () => { assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 })); });
test('rejects non-JSON values', () => {
  for (const v of [undefined, () => 1, NaN, Infinity, 1n, new Date(0), { a: undefined }]) assert.throws(() => canonicalJson(v), { code: 'NOT_JSON' });
});
test('frozenJsonCopy is deep-frozen and detached', () => {
  const src = { a: { b: [1] } }; const c = frozenJsonCopy(src);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.a) && Object.isFrozen(c.a.b));
  src.a.b.push(2); assert.deepEqual(c.a.b, [1]);
});
