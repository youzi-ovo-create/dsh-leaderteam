// Bind this plugin's peer imports to the exact packages loaded by its host.
// The official runtime does not resolve bare peers for external file plugins.
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KEY = Symbol.for('leaderteam.hostImports.v1');
const PEERS = new Set(['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tools/pipeline',
  '@deepseek-ai/dsh-tools/package.json', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tool-executor-native']);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginURL = pathToFileURL(pluginRoot + path.sep).href.toLowerCase();

export function bindHostImports() {
  const app = path.dirname(process.execPath);
  const [, entry, runtimeDir] = process.argv;
  const desktopHost = entry && runtimeDir && path.isAbsolute(runtimeDir)
    && path.relative(path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), entry) === '';
  const candidates = desktopHost ? [runtimeDir] : [
    path.join(app, 'resources/app/dsh'),
    path.join(app, 'resources/app.asar/dsh'),
    path.join(app, 'resources/app.asar'),
  ];
  const moduleRoot = candidates.find(root => fs.existsSync(path.join(root, 'node_modules/@deepseek-ai/dsh-tools/package.json')));
  if (!moduleRoot) throw new Error('LeaderTeam cannot locate the executing Desktop host packages.');
  const existing = globalThis[KEY];
  if (existing) {
    if (existing.moduleRoot !== moduleRoot || existing.pluginRoot !== pluginRoot) throw new Error('Conflicting LeaderTeam host binding.');
    return existing;
  }
  const anchor = pathToFileURL(path.join(moduleRoot, 'package.json')).href;
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (PEERS.has(specifier) && context.parentURL?.toLowerCase().startsWith(pluginURL)) {
      return nextResolve(specifier, { ...context, parentURL: anchor });
    }
    return nextResolve(specifier, context);
  } });
  const binding = Object.freeze({ moduleRoot, pluginRoot, hook });
  globalThis[KEY] = binding;
  return binding;
}
