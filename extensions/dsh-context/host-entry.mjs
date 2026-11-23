import { createRequire, registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh');
const host = createRequire(pathToFileURL(join(root, 'package.json')));
const peers = new Set(['@deepseek-ai/dsh-session', '@deepseek-ai/schemastery']);
const scope = new URL('./', import.meta.url).href;
registerHooks({resolve(specifier, context, next) {
  if (peers.has(specifier) && context.parentURL?.startsWith(scope)) return {url:pathToFileURL(host.resolve(specifier)).href,shortCircuit:true};
  return next(specifier,context);
}});
const plugin = await import('./index.js');
export const name=plugin.name;
export const inject=plugin.inject;
export const Config=plugin.Config;
export const apply=plugin.apply;
