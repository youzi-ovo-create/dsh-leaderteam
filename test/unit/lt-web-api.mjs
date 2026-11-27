import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireWeb = createRequire(new URL('../../packages/lt-web/package.json', import.meta.url));
const { buildSync } = requireWeb('esbuild');
const entry = new URL('../../packages/lt-web/src/lib/api.ts', import.meta.url);
const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(entry)],
  bundle: true,
  write: false,
  format: 'esm',
});

export default await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
