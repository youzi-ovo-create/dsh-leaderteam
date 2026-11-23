import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_TOOLS, memberToolGrant, effectiveToolNames, filterToolView, toolCatalog } from '../../leaderteam/core/tool-policy.mjs';
import { defaultConfig, configWith } from './helpers.mjs';

test('task tools are explicit subsets of the profile pool plus additionalTools', () => {
  const cfg = configWith({ toolPolicy: { additionalTools: ['extra_indexer'] } });
  const grant = memberToolGrant(cfg, 'code', ['read', 'write', 'extra_indexer', 'read']);
  assert.deepEqual(grant.allowedTools, ['read', 'write', 'extra_indexer', ...CAPABILITY_TOOLS]);
  assert.deepEqual(grant.loadedTools, [...grant.allowedTools]);
  assert.throws(() => memberToolGrant(defaultConfig(), 'code', ['pwsh']), /tools outside code deployment policy: pwsh/);
  assert.throws(() => memberToolGrant(cfg, 'code', ['pwsh']), /pwsh/, 'additionalTools do not add unrelated tools');
  assert.throws(() => memberToolGrant(defaultConfig(), 'leader', ['read']), /unknown member profile/);
  for (const requested of [undefined, [], 'read', [42], [' ']]) {
    assert.throws(() => memberToolGrant(cfg, 'code', requested), /explicitly list/);
  }
});

test('defer_tools must be a subset of tools and only defers loaded tools', () => {
  const cfg = defaultConfig();
  const grant = memberToolGrant(cfg, 'shell', ['pwsh', 'bash', 'job_kill'], ['job_kill']);
  assert.ok(grant.allowedTools.includes('job_kill'), 'deferred tools stay allowed');
  assert.ok(!grant.loadedTools.includes('job_kill'));
  for (const t of ['pwsh', 'bash', ...CAPABILITY_TOOLS]) assert.ok(grant.loadedTools.includes(t), t);
  assert.throws(() => memberToolGrant(cfg, 'shell', ['pwsh'], ['bash']), /defer_tools must be a subset of tools/);
  assert.throws(() => memberToolGrant(cfg, 'shell', ['pwsh'], 'pwsh'), /defer_tools must be a subset of tools/);
  assert.throws(() => memberToolGrant(cfg, 'code', ['read', 'team_tools'], ['team_tools']), /control tools cannot be deferred/);
});

test('effective tools never widen allowedTools; unselected and preset tools are filtered out', () => {
  const actor = { allowedTools: ['read', ...CAPABILITY_TOOLS], loadedTools: ['read', 'write', 'pwsh', ...CAPABILITY_TOOLS, 'self_registered'] };
  const names = effectiveToolNames(actor);
  assert.deepEqual([...names].sort(), ['read', ...CAPABILITY_TOOLS].sort());
  const view = { visible: new Map([['read', { name: 'read' }], ['write', { name: 'write' }], ['pwsh', { name: 'pwsh' }]]), knownNames: new Set(['read', 'write', 'pwsh']) };
  const filtered = filterToolView(view, actor);
  assert.deepEqual([...filtered.visible.keys()], ['read']);
  assert.deepEqual([...filtered.knownNames], ['read']);
  assert.equal(filterToolView(view, undefined), view, 'no actor leaves the view untouched');
});

test('ordinary sessions expose host tools without LT capability tools', () => {
  const tools = ['read', 'write', ...CAPABILITY_TOOLS];
  const view = { visible: new Map(tools.map(name => [name, { name }])), knownNames: new Set(tools) };
  const ordinary = filterToolView(view, null);
  assert.deepEqual([...ordinary.visible.keys()], ['read', 'write']);
  assert.deepEqual([...ordinary.knownNames], ['read', 'write']);
  assert.deepEqual([...view.visible.keys()], tools);
});

test('catalog exposes bounded metadata and truthful availability, never parameters, execute or schemas', () => {
  const cfg = configWith({ toolPolicy: { additionalTools: ['extra_indexer'] } });
  const defs = [
    { name: 'read', description: 'Read files', parameters: { type: 'object' }, execute: () => {}, schema: { hidden: true } },
    { name: 'secret_tool', description: 'Not in any pool' },
  ];
  const catalog = toolCatalog(cfg, 'code', defs);
  assert.deepEqual(catalog.map(e => e.name), [...new Set([...cfg.profiles.code.tools, 'extra_indexer'])].sort());
  for (const entry of catalog) {
    assert.deepEqual(Object.keys(entry).sort(), ['available', 'description', 'name']);
    assert.equal(typeof entry.description, 'string');
  }
  const read = catalog.find(e => e.name === 'read');
  assert.equal(read.description, 'Read files');
  assert.equal(read.available, true);
  assert.deepEqual(catalog.find(e => e.name === 'write'), { name: 'write', available: false, description: '' });
  assert.deepEqual(catalog.find(e => e.name === 'extra_indexer'), { name: 'extra_indexer', available: false, description: '' });
});
