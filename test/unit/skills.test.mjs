import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { discoverSkills, loadSkill, extractSkillMetadata } from '../../leaderteam/core/skills.mjs';
import { sha256Hex } from '../../leaderteam/core/canonical.mjs';
import { resolvePath } from '../../leaderteam/core/paths.mjs';

test('extractSkillMetadata: parses single-line, multiline, quotes, headings, and fallbacks', () => {
  // Standard single line
  const meta1 = extractSkillMetadata(`---
name: sample-skill
description: A simple description
---
# Body
Instructions`);
  assert.equal(meta1.name, 'sample-skill');
  assert.equal(meta1.description, 'A simple description');

  // Quoted values
  const meta2 = extractSkillMetadata(`---
name: "quoted-name"
description: 'single-quoted: with colons'
---`);
  assert.equal(meta2.name, 'quoted-name');
  assert.equal(meta2.description, 'single-quoted: with colons');

  // Folded multiline (>)
  const metaFolded = extractSkillMetadata(`---
name: folded-skill
description: >
  First line
  second line
  third line
---`);
  assert.equal(metaFolded.name, 'folded-skill');
  assert.equal(metaFolded.description, 'First line second line third line');

  // Literal multiline (|)
  const metaLiteral = extractSkillMetadata(`---
name: literal-skill
description: |
  Line 1
  Line 2
---`);
  assert.equal(metaLiteral.name, 'literal-skill');
  assert.equal(metaLiteral.description, 'Line 1\nLine 2');

  // Indented continuation
  const metaIndented = extractSkillMetadata(`---
name: indented-skill
description: First part
  continued part
  final part
---`);
  assert.equal(metaIndented.name, 'indented-skill');
  assert.equal(metaIndented.description, 'First part continued part final part');

  // Fallback to top Markdown heading
  const metaHeading = extractSkillMetadata(`# Top Heading Skill
Some instructions here`, 'fallback-dir');
  assert.equal(metaHeading.name, 'Top Heading Skill');
  assert.equal(metaHeading.description, '');

  // Fallback to directory name
  const metaDir = extractSkillMetadata(`No heading and no frontmatter`, 'my-fallback-dir');
  assert.equal(metaDir.name, 'my-fallback-dir');
  assert.equal(metaDir.description, '');

  // UTF-8 BOM
  const metaBom = extractSkillMetadata(`\uFEFF---
name: bom-skill
description: with bom
---`);
  assert.equal(metaBom.name, 'bom-skill');
  assert.equal(metaBom.description, 'with bom');
});

test('discoverSkills: bodies are NOT returned in discovery', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skill-nobodies-'));
  const skillDir = path.join(ws, '.agents', 'skills', 'preview-gen');
  fs.mkdirSync(skillDir, { recursive: true });

  const skillBody = `---
name: preview-generator
description: Generates preview thumbnails
---

# Instructions for preview-generator
This is a very long secret body text that should not enter model context during discovery.
Line 1
Line 2
Line 3
`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillBody, 'utf8');

  const catalog = discoverSkills({ workspace: ws });

  assert.equal(catalog.length, 1);
  const item = catalog[0];
  assert.equal(item.id, 'preview-generator');
  assert.equal(item.name, 'preview-generator');
  assert.equal(item.description, 'Generates preview thumbnails');
  assert.equal(item.path, resolvePath(path.join(skillDir, 'SKILL.md')));
  assert.equal(item.root, resolvePath(path.join(ws, '.agents', 'skills')));

  // Verify body/text are strictly not exposed
  assert.equal(item.text, undefined);
  assert.equal(item.body, undefined);
  assert.ok(!('text' in item), 'text property must not exist in discovered item');
  assert.ok(!('body' in item), 'body property must not exist in discovered item');

  // Check JSON representation does not have text/body
  const json = JSON.parse(JSON.stringify(item));
  assert.deepEqual(Object.keys(json).sort(), ['description', 'id', 'name', 'path', 'root']);
});

test('discoverSkills and loadSkill: symlink/junction escapes rejected', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skill-ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skill-outside-'));

  // 1. Candidate root outside authorized boundary
  assert.throws(() => {
    discoverSkills({ workspace: ws, skillRoots: [outside] });
  }, { code: 'ROOT_OUT_OF_BOUNDS' });

  // 2. Junction pointing outside authorized roots is not traversed
  const wsSkills = path.join(ws, '.agents', 'skills');
  fs.mkdirSync(wsSkills, { recursive: true });

  const outsideSkillDir = path.join(outside, 'escaped-skill');
  fs.mkdirSync(outsideSkillDir, { recursive: true });
  fs.writeFileSync(path.join(outsideSkillDir, 'SKILL.md'), '---\nname: escaped\ndescription: should not be found\n---\nBody', 'utf8');

  // Create junction inside ws pointing to outside
  const junctionPath = path.join(wsSkills, 'linked-outside');
  fs.symlinkSync(outside, junctionPath, 'junction');

  // Discover in ws - escaped skill must not be traversed
  const catalog = discoverSkills({ workspace: ws });
  assert.equal(catalog.length, 0, 'Junction escaping authorized roots must not be traversed');

  // 3. If outside is explicitly in globalRefRoots, it is allowed
  const refCatalog = discoverSkills({
    workspace: ws,
    globalRefRoots: [outside],
    skillRoots: [outside],
  });
  assert.equal(refCatalog.length, 1);
  assert.equal(refCatalog[0].name, 'escaped');
});

test('discoverSkills: missing roots ignored, duplicate roots handled, duplicate names disambiguated', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skill-dups-'));

  // Missing roots: default directories do not exist yet -> returns empty array
  const emptyCatalog = discoverSkills({ workspace: ws });
  assert.deepEqual(emptyCatalog, []);

  // Create two separate skill roots with skills having identical names
  const rootA = path.join(ws, '.agents', 'skills');
  const rootB = path.join(ws, '.leaderteam', 'skills');
  fs.mkdirSync(path.join(rootA, 'skill-one'), { recursive: true });
  fs.mkdirSync(path.join(rootB, 'skill-two'), { recursive: true });

  fs.writeFileSync(
    path.join(rootA, 'skill-one', 'SKILL.md'),
    '---\nname: shared-skill\ndescription: Version from agents\n---\n# Shared A body',
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootB, 'skill-two', 'SKILL.md'),
    '---\nname: shared-skill\ndescription: Version from leaderteam\n---\n# Shared B body',
    'utf8'
  );

  // Supply duplicate roots in skillRoots argument
  const catalog = discoverSkills({
    workspace: ws,
    skillRoots: [
      path.join(ws, '.agents', 'skills'),
      path.join(ws, '.agents', 'skills'), // Duplicate root
      path.join(ws, '.leaderteam', 'skills'),
    ],
  });

  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].name, 'shared-skill');
  assert.equal(catalog[1].name, 'shared-skill');

  // Duplicate names disambiguated deterministically by id
  assert.equal(catalog[0].id, 'shared-skill');
  assert.equal(catalog[1].id, 'shared-skill-2');

  // Both can be loaded independently using their disambiguated IDs
  const loadedA = loadSkill(catalog, 'shared-skill', { workspace: ws });
  const loadedB = loadSkill(catalog, 'shared-skill-2', { workspace: ws });
  assert.ok(loadedA.text.includes('Shared A body'));
  assert.ok(loadedB.text.includes('Shared B body'));
});

test('loadSkill: missing and duplicate catalogs handled cleanly', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skill-cat-errors-'));
  const root = path.join(ws, '.agents', 'skills', 'test-item');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: item\ndescription: test\n---\nBody', 'utf8');

  const catalog = discoverSkills({ workspace: ws });
  assert.equal(catalog.length, 1);

  // Missing catalog (null / undefined / non-array)
  assert.throws(() => loadSkill(null, 'item', { workspace: ws }), { code: 'INVALID_CATALOG' });
  assert.throws(() => loadSkill(undefined, 'item', { workspace: ws }), { code: 'INVALID_CATALOG' });
  assert.throws(() => loadSkill('string-cat', 'item', { workspace: ws }), { code: 'INVALID_CATALOG' });

  // Missing skill in catalog
  assert.throws(() => loadSkill([], 'item', { workspace: ws }), { code: 'SKILL_NOT_FOUND' });
  assert.throws(() => loadSkill(catalog, 'non-existent-id', { workspace: ws }), { code: 'SKILL_NOT_FOUND' });

  // Duplicate catalog entries with identical id
  const duplicatedCatalog = [catalog[0], catalog[0]];
  assert.throws(() => loadSkill(duplicatedCatalog, 'item', { workspace: ws }), { code: 'DUPLICATE_SKILL_ID' });
});

test('loadSkill: bounded loading and exact sha256 verification', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skill-bounded-'));
  const skillDir = path.join(ws, '.agents', 'skills', 'calculator');
  fs.mkdirSync(skillDir, { recursive: true });

  const content = `---\nname: calculator\ndescription: Safe calculations\n---\n# Calculator\nPerform safe math operations. 1 + 1 = 2.`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');

  const catalog = discoverSkills({ workspace: ws });
  assert.equal(catalog.length, 1);

  // Exact load
  const loaded = loadSkill(catalog, 'calculator', { workspace: ws });
  assert.equal(loaded.id, 'calculator');
  assert.equal(loaded.name, 'calculator');
  assert.equal(loaded.text, content);
  assert.equal(loaded.sha256, sha256Hex(content));

  // Bounded byte size: smaller limit fails before returning
  const byteLen = Buffer.byteLength(content, 'utf8');
  assert.throws(() => {
    loadSkill(catalog, 'calculator', { workspace: ws, maxBytes: byteLen - 10 });
  }, { code: 'SKILL_TOO_LARGE' });

  // Sufficient limit succeeds
  const loadedWithLimit = loadSkill(catalog, 'calculator', { workspace: ws, maxBytes: byteLen + 10 });
  assert.equal(loadedWithLimit.sha256, sha256Hex(content));
});

test('loadSkill: path changed after discovery rejected', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skill-tamper-'));
  const skillDir = path.join(ws, '.agents', 'skills', 'valid-skill');
  fs.mkdirSync(skillDir, { recursive: true });

  const content = '---\nname: valid-skill\ndescription: Valid\n---\nValid instructions';
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');

  const catalog = discoverSkills({ workspace: ws });
  assert.equal(catalog.length, 1);

  // 1. Modifying path to another file
  const tamperedFile = path.join(ws, 'tampered.txt');
  fs.writeFileSync(tamperedFile, 'evil', 'utf8');
  catalog[0].path = tamperedFile;

  assert.throws(() => {
    loadSkill(catalog, 'valid-skill', { workspace: ws });
  }, { code: 'SKILL_PATH_TAMPERED' });

  // 2. Modifying path to non-existent SKILL.md
  catalog[0].path = path.join(skillDir, 'nonexistent', 'SKILL.md');
  assert.throws(() => {
    loadSkill(catalog, 'valid-skill', { workspace: ws });
  }, { code: 'SKILL_PATH_TAMPERED' });
});

test('discoverSkills: ignores hidden/.git/vendor/node_modules and enforces maxSkills bound', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skill-bounds-'));
  const skillsRoot = path.join(ws, '.agents', 'skills');

  // Ignored directories
  fs.mkdirSync(path.join(skillsRoot, '.hidden-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, '.hidden-skill', 'SKILL.md'), '---\nname: hidden\n---', 'utf8');

  fs.mkdirSync(path.join(skillsRoot, '.git'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, '.git', 'SKILL.md'), '---\nname: git\n---', 'utf8');

  fs.mkdirSync(path.join(skillsRoot, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, 'node_modules', 'dep', 'SKILL.md'), '---\nname: node-mod\n---', 'utf8');

  fs.mkdirSync(path.join(skillsRoot, 'vendor', 'thirdparty'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, 'vendor', 'thirdparty', 'SKILL.md'), '---\nname: vendor-skill\n---', 'utf8');

  // Valid skills
  for (let i = 1; i <= 5; i++) {
    const dir = path.join(skillsRoot, `skill-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: skill-${i}\ndescription: desc ${i}\n---`, 'utf8');
  }

  // maxSkills = 3
  const catalog3 = discoverSkills({ workspace: ws, maxSkills: 3 });
  assert.equal(catalog3.length, 3);

  // Default discovery covers all 5 valid skills, ignoring hidden/vendor/node_modules
  const catalogAll = discoverSkills({ workspace: ws, maxSkills: 100 });
  assert.equal(catalogAll.length, 5);
  const names = catalogAll.map(s => s.name).sort();
  assert.deepEqual(names, ['skill-1', 'skill-2', 'skill-3', 'skill-4', 'skill-5']);
});
