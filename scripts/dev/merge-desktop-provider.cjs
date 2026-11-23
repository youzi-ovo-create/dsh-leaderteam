// Runs only inside the installed Desktop Electron in Node mode. Configuration
// stays in local pipes; never put existing YAML or parser errors on stderr.
const fs = require('node:fs');
const path = require('node:path');

class JsExpr { constructor(source) { this.source = source; } }
const plain = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function fail(code) { const error = new Error(); error.code = code; throw error; }
const LT_INSERT_IDS = new Set([
  'tool-executor-native',
  'leaderteam-core',
  'leaderteam-scheduler',
  'leaderteam-timer-archive',
  'leaderteam-consensus',
  'leaderteam-panel',
  'preset-leaderteam',
  'preset-lt-member-readonly',
  'preset-lt-member-code',
  'preset-lt-member-shell',
]);
const EMPTY_ARRAY_COMMENT_RE = /^# leaderteam-original-empty-array: ([A-Za-z0-9+/=]+)\r?$/m;

try {
  const yaml = require(path.join(path.resolve(process.argv[2]), 'node_modules', 'js-yaml'));
  const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', instanceOf: JsExpr,
    construct: source => new JsExpr(source), represent: value => value.source,
  }));
  const dumpOpts = { schema, noRefs: true, lineWidth: -1, noCompatMode: true };
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const mode = input.mode === 'uninstall' ? 'uninstall' : 'install';
  const existing = input.existing;
  const managed = input.managed ?? null;
  const template = input.template ?? '';
  if (typeof existing !== 'string' || (managed !== null && typeof managed !== 'string')) fail('INVALID_INPUT');
  if (mode === 'install' && typeof template !== 'string') fail('INVALID_INPUT');

  const decodedExisting = existing.replace(EMPTY_ARRAY_COMMENT_RE, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
  const entries = yaml.load(decodedExisting, { schema }) ?? [];
  if (!Array.isArray(entries)) fail('INVALID_PATCH');
  let original = {};
  for (const row of entries) {
    if (!plain(row)) fail('INVALID_PATCH');
    if (row.id === 'llm-pi-ai' && owns(row, 'config')) original = row.config;
  }
  if (!plain(original) || (owns(original, 'providers') && !plain(original.providers))) fail('UNSUPPORTED_CONFIG');
  const providers = original.providers ?? {};
  if (owns(providers, 'magpie')) fail('MAGPIE_ALREADY_EXISTS');

  const rescuedEntries = [];
  let rescuedLlmConfig = null;
  if (typeof managed === 'string' && managed.trim() !== '') {
    const managedEntries = yaml.load(managed, { schema }) ?? [];
    if (!Array.isArray(managedEntries)) fail('INVALID_PATCH');
    for (const row of managedEntries) {
      if (!plain(row)) fail('INVALID_PATCH');
      if (row.id === 'tool-executor-native' && row.disabled === true && Object.keys(row).every(k => k === 'id' || k === 'disabled')) {
        continue;
      }
      if (Array.isArray(row.insert) && Object.keys(row).length === 1) {
        const kept = row.insert.filter(item => !(plain(item) && LT_INSERT_IDS.has(item.id)));
        if (kept.length > 0) rescuedEntries.push({ insert: kept });
        continue;
      }
      if (row.id === 'llm-pi-ai' && owns(row, 'config') && plain(row.config)) {
        if (owns(row.config, 'providers') && !plain(row.config.providers)) fail('UNSUPPORTED_CONFIG');
        const cfgWithoutMagpie = { ...row.config };
        if (plain(cfgWithoutMagpie.providers)) {
          const provCopy = { ...cfgWithoutMagpie.providers };
          delete provCopy.magpie;
          if (Object.keys(provCopy).length > 0) cfgWithoutMagpie.providers = provCopy;
          else delete cfgWithoutMagpie.providers;
        }
        if (yaml.dump(cfgWithoutMagpie, dumpOpts) !== yaml.dump(original, dumpOpts)) {
          const mergedProviders = { ...(original.providers ?? {}), ...(cfgWithoutMagpie.providers ?? {}) };
          const mergedCfg = { ...original, ...cfgWithoutMagpie };
          if (Object.keys(mergedProviders).length > 0) mergedCfg.providers = mergedProviders;
          else delete mergedCfg.providers;
          if (Object.keys(mergedCfg).length > 0) {
            rescuedLlmConfig = mergedCfg;
            original = mergedCfg;
          }
        }
        continue;
      }
      rescuedEntries.push(row);
    }
  }

  const toRescue = [
    ...(rescuedLlmConfig ? [{ id: 'llm-pi-ai', config: rescuedLlmConfig }] : []),
    ...rescuedEntries,
  ];
  let prefix;
  if (toRescue.length > 0) {
    const strippedHeader = existing
      .replace(/^[ \t]*# leaderteam-original-empty-array: [A-Za-z0-9+/=]+[ \t]*\r?\n?/m, '')
      .replace(/^[ \t]*\[\][^\r\n]*\r?\n?/m, '')
      .trimEnd();
    const dumped = yaml.dump(toRescue, dumpOpts).trimEnd();
    prefix = strippedHeader ? `${strippedHeader}\n${dumped}` : dumped;
  } else if (mode === 'uninstall') {
    prefix = decodedExisting;
  } else if (EMPTY_ARRAY_COMMENT_RE.test(existing)) {
    prefix = existing;
  } else if (entries.length === 0 && Array.isArray(yaml.load(decodedExisting, { schema }))) {
    let replaced = false;
    prefix = decodedExisting.replace(/^[ \t]*\[\][^\r\n]*$/m, line => {
      replaced = true;
      return '# leaderteam-original-empty-array: ' + Buffer.from(line, 'utf8').toString('base64');
    });
    if (!replaced) fail('UNSUPPORTED_EMPTY_ARRAY');
  } else {
    prefix = decodedExisting;
  }

  if (mode === 'uninstall') {
    process.stdout.write(JSON.stringify({ prefix, rescuedCount: toRescue.length }));
    process.exit(0);
  }

  const rows = yaml.load(template, { schema });
  if (!Array.isArray(rows)) fail('INVALID_TEMPLATE');
  const provider = rows.find(row => row.id === 'llm-pi-ai')?.config?.providers?.magpie;
  if (!plain(provider)) fail('INVALID_TEMPLATE');
  const effectiveProviders = original.providers ?? {};
  const block = yaml.dump([{ id: 'llm-pi-ai', config: {
    ...original, providers: { ...effectiveProviders, magpie: provider },
  } }], dumpOpts);
  process.stdout.write(JSON.stringify({ block, prefix, originalProviderCount: Object.keys(effectiveProviders).length, rescuedCount: toRescue.length }));
} catch (error) {
  const codes = ['INVALID_INPUT', 'INVALID_PATCH', 'UNSUPPORTED_CONFIG', 'MAGPIE_ALREADY_EXISTS', 'INVALID_TEMPLATE', 'UNSUPPORTED_EMPTY_ARRAY'];
  process.stderr.write(codes.includes(error.code) ? error.code : 'CONFIG_PARSE_FAILED');
  process.exitCode = 1;
}
