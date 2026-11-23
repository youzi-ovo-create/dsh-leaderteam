// Artifact check only: run with the official Electron in Node mode.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const official = path.join(root, 'runtime/official-desktop/0.2.2-rc.1/resources/app.asar/dsh');
const baseline = path.join(root, 'runtime/dsh-desktop-0.13.2/resources/app.asar');
const rel = 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js';
const current = fs.readFileSync(path.join(official, rel));
const previous = fs.readFileSync(path.join(baseline, rel));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const source = current.toString('utf8');
const tools = JSON.parse(fs.readFileSync(path.join(official, 'node_modules/@deepseek-ai/dsh-tools/package.json'), 'utf8'));
const info = {
  source: 'official downloaded signed Windows artifact',
  desktopVersion: '0.2.2-rc.1', toolsVersion: tools.version,
  pipelineIdenticalToVerifiedBaseline: current.equals(previous),
  pipelineSHA256: hash(current), baselinePipelineSHA256: hash(previous),
  requiredResolvePresent: source.includes('this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet)'),
  requiredExecutePresent: source.includes('await tool.execute(exec.arguments, exec)'),
  strictVersionAndFunctionChecksRetained: true,
  integrationQualification: 'pending official integration suite and real execution',
};
if (tools.version !== '0.2.2-rc.1' || !info.pipelineIdenticalToVerifiedBaseline || !info.requiredResolvePresent || !info.requiredExecutePresent) {
  throw new Error('Official artifact pipeline differs; do not qualify this version.');
}
fs.writeFileSync(path.join(root, 'reports/official-core-compatibility.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
