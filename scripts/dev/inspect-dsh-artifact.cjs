// Read packaged code metadata only. No user configuration or credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
try {
  const asar = path.join(path.dirname(process.execPath), 'resources/app.asar');
  const moduleRoot = path.join(asar, 'dsh');
  const desktop = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'));
  const tools = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'node_modules/@deepseek-ai/dsh-tools/package.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(moduleRoot, 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js'));
  process.stdout.write(JSON.stringify({ packageName: desktop.name, desktopVersion: desktop.version,
    toolsVersion: tools.version, pipelineSHA256: crypto.createHash('sha256').update(bytes).digest('hex') }));
} catch {
  process.stderr.write('Cannot inspect the official Desktop artifact.');
  process.exitCode = 1;
}
