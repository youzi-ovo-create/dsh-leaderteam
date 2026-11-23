// Verify the installer's actual single-file patch through the official DSH CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDshRuntime } from '../../scripts/dsh-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = resolveDshRuntime();
const app = runtime.app;
const exe = runtime.exe;
const moduleRoot = runtime.moduleRoot;
const fixture = fs.mkdtempSync(path.join(root, 'test-work/provider-merge-'));
const home = path.join(fixture, 'home');
const profile = path.join(home, 'profiles', runtime.profile ?? 'desktop');
fs.mkdirSync(profile, { recursive: true });
const patch = path.join(profile, 'cordis.patch.yml');
const original = `# Original comments and expressions stay intact.
- id: llm-pi-ai
  config:
    customSetting: retained
    customExpression: !!js 'process.env.UNUSED_FIXTURE'
    providers:
      fixture_original:
        api: openai-completions
        apiKey: FAKE_SECRET_MUST_NOT_BE_PRINTED
        baseURL: http://127.0.0.1:39999/v1
        models:
          - id: fixture-only
- id: agent-default-model
  config: {model: fixture_original/fixture-only, reasoningEffort: low}
`;
fs.writeFileSync(patch, original);
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
function ps(script, args = []) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, script),
    '-DshHome', home, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, `PowerShell step failed (${result.status})`);
  return (result.stdout ?? '') + (result.stderr ?? '');
}
const installArgs = ['-DshApp', app, '-BackupDir', path.join(fixture, 'config-backup')];
const dryRun = ps('scripts/install-desktop.ps1', ['-DryRun', ...installArgs]);
check(!dryRun.includes('FAKE_SECRET') && !dryRun.includes('39999'), 'DryRun keeps existing values private');
check(fs.readFileSync(patch, 'utf8') === original, 'DryRun leaves the patch unchanged');
ps('scripts/install-desktop.ps1', installArgs);
const installed = fs.readFileSync(patch, 'utf8');
check(installed.startsWith(original.trimEnd()), 'original patch text stays intact');
ps('scripts/install-desktop.ps1', installArgs);
check(fs.readFileSync(patch, 'utf8') === installed, 'second install is byte-identical');

function dumpAndInspect(label) {
  const dump = spawnSync(exe, [...runtime.cliArgs, 'web', '--patch', patch, '--dump-config'], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(dump.status, 0, `official CLI dump failed (${dump.status})`);
  const dumpFile = path.join(fixture, `${label}.yml`);
  fs.writeFileSync(dumpFile, (dump.stdout ?? '').split(/\r?\n/).filter(line => !line.startsWith('[harness-node]')).join('\n'));
  const parse = spawnSync(exe, ['-e', `
    const fs=require('node:fs'), path=require('node:path');
    const yaml=require(path.join(process.argv[1],'node_modules/js-yaml'));
    const schema=yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:s=>({expression:s})}));
    const rows=yaml.load(fs.readFileSync(process.argv[2],'utf8'),{schema});
    const config=rows.find(row=>row.id==='llm-pi-ai').config;
    const defaults=rows.find(row=>row.id==='agent-default-model').config;
    process.stdout.write(JSON.stringify({providers:Object.keys(config.providers??{}),
      magpieModelCount:config.providers?.magpie?.models?.length??0,
      originalModel:config.providers?.fixture_original?.models?.[0]?.id,
      originalURL:config.providers?.fixture_original?.baseURL,
      customSetting:config.customSetting,customExpression:config.customExpression,
      defaults}));`, moduleRoot, dumpFile], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(parse.status, 0, 'local dump parsing succeeds');
  return JSON.parse(parse.stdout);
}
const loaded = dumpAndInspect('installed');
check(loaded.providers.includes('fixture_original') && loaded.providers.includes('magpie'), 'both providers actually load');
check(loaded.magpieModelCount === Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'config/leaderteam.config.json'), 'utf8')).models).length, 'all configured Magpie models load');
check(loaded.originalModel === 'fixture-only' && loaded.originalURL === 'http://127.0.0.1:39999/v1', 'original provider values survive');
check(loaded.customSetting === 'retained', 'other LLM configuration survives');
check(loaded.customExpression?.expression === 'process.env.UNUSED_FIXTURE', 'expression tag survives without evaluation');
check(loaded.defaults?.model === 'fixture_original/fixture-only' && loaded.defaults?.reasoningEffort === 'low', 'default model survives');
ps('scripts/uninstall-desktop.ps1');
check(fs.readFileSync(patch, 'utf8').trim() === original.trim(), 'uninstall restores original text');
const uninstalled = dumpAndInspect('uninstalled');
check(uninstalled.providers.includes('fixture_original') && !uninstalled.providers.includes('magpie'), 'uninstall restores actual original provider configuration');

const clean = '# Official clean profile\n[]\n';
fs.writeFileSync(patch, clean);
ps('scripts/install-desktop.ps1', installArgs);
check(dumpAndInspect('clean-installed').magpieModelCount === Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'config/leaderteam.config.json'), 'utf8')).models).length, 'official clean profile installs correctly');
ps('scripts/install-desktop.ps1', installArgs);
ps('scripts/uninstall-desktop.ps1');
check(fs.readFileSync(patch, 'utf8').trim() === clean.trim(), 'clean empty sequence restores correctly');
fs.writeFileSync(patch, '[]\n');
ps('scripts/install-desktop.ps1', installArgs);
check(dumpAndInspect('bare-empty-installed').magpieModelCount === Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'config/leaderteam.config.json'), 'utf8')).models).length, 'bare empty sequence installs correctly');
ps('scripts/uninstall-desktop.ps1');
check(fs.readFileSync(patch, 'utf8').trim() === '[]', 'bare empty sequence restores correctly');

// Official Desktop's UI settings writer appends entries to the YAML array before trailing comments
// (# <<< leaderteam) and may add providers to the managed llm-pi-ai row. Re-install and uninstall
// must rescue those user entries outside the managed block instead of wiping them.
fs.writeFileSync(patch, clean);
ps('scripts/install-desktop.ps1', installArgs);
const beforeUiEdit = fs.readFileSync(patch, 'utf8');
const uiAppended = beforeUiEdit
  .replace(
    '    providers:\n      magpie:',
    '    providers:\n      desktop_ui_added:\n        api: openai-completions\n        baseURL: http://127.0.0.1:38888/v1\n        models:\n          - id: ui-model\n      magpie:',
  )
  .replace(
    '\n# <<< leaderteam',
    '\n- id: ui-settings-account\n  name: "@deepseek-ai/dsh-client-ui-settings-account"\n  config:\n    version: 1\n    step: done\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: magpie\n    model: antigravity/gemini-4-argon\n    reasoningEffort: medium\n\n# <<< leaderteam',
  );
fs.writeFileSync(patch, uiAppended);
ps('scripts/install-desktop.ps1', installArgs);
const afterRescueInstall = fs.readFileSync(patch, 'utf8');
const loadedRescue = dumpAndInspect('ui-rescued-installed');
check(loadedRescue.providers.includes('desktop_ui_added') && loadedRescue.providers.includes('magpie'), 'UI-added provider and magpie both survive re-install');
check(loadedRescue.defaults?.model === 'antigravity/gemini-4-argon' && afterRescueInstall.includes('ui-settings-account'), 'UI settings appended before end marker survive re-install');
ps('scripts/install-desktop.ps1', installArgs);
check(fs.readFileSync(patch, 'utf8') === afterRescueInstall, 'post-rescue second install is byte-identical');
ps('scripts/uninstall-desktop.ps1', ['-DshApp', app]);
const afterRescueUninstall = dumpAndInspect('ui-rescued-uninstalled');
check(afterRescueUninstall.providers.includes('desktop_ui_added') && !afterRescueUninstall.providers.includes('magpie') && afterRescueUninstall.defaults?.model === 'antigravity/gemini-4-argon', 'uninstall preserves rescued UI settings and providers while removing magpie');

fs.writeFileSync(patch, '- id: llm-pi-ai\n  config: {providers: {fixture_original: FAKE_PARSE_SECRET, bad: [}\n');
const malformed = fs.readFileSync(patch, 'utf8');
const rejected = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(root, 'scripts/install-desktop.ps1'), '-DryRun', '-DshHome', home, ...installArgs], {
  cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000,
});
check(rejected.status !== 0, 'invalid configuration is rejected');
check(!((rejected.stdout ?? '') + (rejected.stderr ?? '')).includes('FAKE_PARSE_SECRET'), 'parser failure does not echo input values');
check(fs.readFileSync(patch, 'utf8') === malformed, 'parser failure changes no configuration');

const report = { passed: true, checks, providers: loaded.providers, preservesOriginal: true,
  magpieModelCount: loaded.magpieModelCount, preservesDefault: true, preservesExpression: true,
  cleanProfile: true, fixture };
fs.mkdirSync(path.join(root, 'reports/desktop-preview'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports/desktop-preview/provider-merge.json'), JSON.stringify(report, null, 2));
console.log(`PASS desktop-provider-merge (${checks} checks; official CLI, installed patch, no model calls)`);
