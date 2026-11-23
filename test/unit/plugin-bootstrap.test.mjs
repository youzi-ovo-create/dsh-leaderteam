import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

for (const entry of ['entry-core.mjs', 'entry-lead.mjs', 'entry-native-executor.mjs']) {
  test(`${entry}: unavailable host fails activation after a successful plugin import`, () => {
    const url = new URL(`../../leaderteam/${entry}`, import.meta.url).href;
    const script = `const plugin=await import(${JSON.stringify(url)});
      let rejected=false;try{plugin.apply({},{});}catch(error){rejected=/host imports unavailable/.test(error.message);}
      if(!rejected)process.exit(2);console.log('activation-rejected');`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true });
    assert.match(result, /activation-rejected/);
  });
}
