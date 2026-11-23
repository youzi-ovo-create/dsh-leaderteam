import { assert, allow, approve, PLAN, DELIVERY, dispatch, latestPlanId, callsOf, lastToolResult, memberRecords, read } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ALPHA_BODY_MARKER = 'ALPHA_SKILL_BODY_UNIQUE_MARKER_998877';
const BETA_BODY_MARKER = 'BETA_SKILL_BODY_UNIQUE_MARKER_445566';
const LINKED_ALPHA_MARKER = 'UNLOADED_ALPHA_LINKED_FILE_CONTENT_112233';
const LINKED_BETA_MARKER = 'UNLOADED_BETA_LINKED_FILE_CONTENT_778899';

export default {
  files: {
    'spec.md': 'spec\n',
    '.agents/skills/alpha-op/SKILL.md': `---
name: Alpha Operation
description: Skill for alpha operations
---
# Alpha Skill Instructions
${ALPHA_BODY_MARKER}
See reference at doc.md for extra details.
`,
    '.agents/skills/alpha-op/doc.md': `${LINKED_ALPHA_MARKER}\n`,
    '.leaderteam/skills/beta-op/SKILL.md': `---
name: Beta Operation
description: Skill for beta operations
---
# Beta Skill Instructions
${BETA_BODY_MARKER}
See reference at doc.md for extra details.
`,
    '.leaderteam/skills/beta-op/doc.md': `${LINKED_BETA_MARKER}\n`,
  },
  runs: [{ task: 'first run' }, { task: 'second run: continue', resume: true }],
  beforeRun(t, { index }) {
    if (index === 1) fs.writeFileSync(path.join(t.ws, '.agents/skills/alpha-op/SKILL.md'), '# Replaced after dispatch\nCHANGED_SKILL_BODY_MUST_NOT_REPLACE_SNAPSHOT\n');
  },
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') {
      t.state.l = (t.state.l ?? 0) + 1;
      if (t.runs.length === 0) {
        if (t.state.l === 1) return { tool: 'team_skills', args: { action: 'list' } };
        if (t.state.l === 2) {
          const listRes = lastToolResult(c);
          assert.match(listRes, /"id":\s*"alpha-operation"/);
          assert.match(listRes, /"id":\s*"beta-operation"/);
          assert.ok(!listRes.includes(ALPHA_BODY_MARKER), 'leader list must not contain alpha body');
          assert.ok(!listRes.includes(BETA_BODY_MARKER), 'leader list must not contain beta body');
          assert.ok(!listRes.includes(LINKED_ALPHA_MARKER), 'leader list must not contain linked file');
          assert.ok(!listRes.includes(LINKED_BETA_MARKER), 'leader list must not contain linked file');
          return PLAN;
        }
        if (t.state.l === 3) {
          return dispatch({
            plan_id: latestPlanId(c),
            tools: ['read', 'write'],
            skills: ['alpha-operation'],
            write_scope: ['src/**'],
            refs: ['spec.md'],
          });
        }
        if (t.state.l === 4) return { content: 'WAITING' };
        return { content: 'RUN1_DONE' };
      }
      // Run 2: resume member
      t.state.l2 = (t.state.l2 ?? 0) + 1;
      if (t.state.l2 === 1) {
        const child = memberRecords(t).find(r => r.type === 'member').childId;
        return { tool: 'send_message', args: { agent_id: child, message: 'Verify skill retention across restart.' } };
      }
      if (t.state.l2 === 2) return { content: 'WAITING2' };
      if (t.state.l2 === 3) return DELIVERY;
      return { content: 'DELIVERY: approved' };
    }
    if (c.kind === 'member') {
      t.state.m = (t.state.m ?? 0) + 1;
      const idx = t.state.m;
      if (idx === 1) {
        // First member request: only selected alpha marker present in context
        assert.ok(c.text.includes(ALPHA_BODY_MARKER), 'member context must contain selected alpha skill body');
        assert.ok(!c.text.includes(BETA_BODY_MARKER), 'member context must not contain unselected beta skill body');
        assert.ok(!c.text.includes(LINKED_ALPHA_MARKER), 'member context must not contain linked reference doc');
        assert.ok(!c.text.includes(LINKED_BETA_MARKER), 'member context must not contain unselected linked doc');
        return { tool: 'read', args: { file_path: 'spec.md' } };
      }
      if (idx === 2) {
        // Write the alpha marker to file
        return { tool: 'write', args: { file_path: 'src/marker.txt', content: `${ALPHA_BODY_MARKER}\n` } };
      }
      if (idx === 3) {
        // Read granted skill via team_skills
        return { tool: 'team_skills', args: { action: 'read', id: 'alpha-operation' } };
      }
      if (idx === 4) {
        const skillRes = lastToolResult(c);
        assert.ok(skillRes.includes(ALPHA_BODY_MARKER), 'read skill returned alpha body');
        assert.match(skillRes, /"source":\s*"dispatch snapshot"/);
        return { content: 'STATUS: done\nCHANGED: src/marker.txt\nEVIDENCE: marker written\nNOTES: none' };
      }
      if (idx === 5) {
        // Run 2: verify restart retains selected skill snapshot
        assert.ok(c.text.includes(ALPHA_BODY_MARKER), 'resumed member context retains selected alpha skill body');
        assert.ok(!c.text.includes('CHANGED_SKILL_BODY_MUST_NOT_REPLACE_SNAPSHOT'), 'restart must use the saved instructions, not silently load the changed file');
        assert.ok(!c.text.includes(BETA_BODY_MARKER), 'resumed member context still has no beta skill body');
        assert.ok(!c.text.includes(LINKED_ALPHA_MARKER), 'resumed member context still has no linked doc');
        // Attempt to read ungranted skill
        return { tool: 'team_skills', args: { action: 'read', id: 'beta-operation' } };
      }
      if (idx === 6) {
        assert.match(lastToolResult(c), /skill was not granted to this member/);
        return { content: 'STATUS: done\nCHANGED: none\nEVIDENCE: verified skill snapshot retained\nNOTES: none' };
      }
    }
  },
  assert(t) {
    assert.equal(t.runs.length, 2, 'must run 2 steps');
    assert.equal(t.runs[0].code, 0, 'run 1 exit code');
    assert.equal(t.runs[1].code, 0, 'run 2 exit code');
    assert.equal(read(t, 'src/marker.txt'), `${ALPHA_BODY_MARKER}\n`);
    const leaderCalls = callsOf(t, 'leader');
    for (const lc of leaderCalls) {
      assert.ok(!lc.text.includes(ALPHA_BODY_MARKER), 'leader context must never receive alpha skill body');
      assert.ok(!lc.text.includes(BETA_BODY_MARKER), 'leader context must never receive beta skill body');
    }
    const recs = memberRecords(t).filter(r => r.type === 'member');
    assert.equal(recs.length, 1);
    assert.equal(recs[0].skills.length, 1);
    assert.equal(recs[0].skills[0].id, 'alpha-operation');
    assert.ok(recs[0].skills[0].text.includes(ALPHA_BODY_MARKER));
    assert.ok(!recs[0].skills[0].text.includes(LINKED_ALPHA_MARKER));
  },
};
