// Request classification and assertion helpers for scripted scenarios.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
export function classify(payload) {
  const text = JSON.stringify(payload.messages ?? []);
  const sys = (payload.messages ?? []).filter(m => m.role === 'system' || m.role === 'developer').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const user = lastUserText(payload);
  // A bounded schema retry appends diagnostic feedback as a separate user message.
  // Classify the original structured governance request, not that format-only feedback.
  const structured = (payload.messages ?? []).filter(m => m.role === 'user').map(m => safeJson(typeof m.content === 'string' ? m.content : (m.content ?? []).map(b => b.text ?? '').join(''))).findLast(v => v && typeof v === 'object') ?? safeJson(user);
  const base = { model: payload.model, effort: payload.reasoning_effort, maxCompletionTokens: payload.max_completion_tokens ?? payload.max_tokens ?? null, tools: (payload.tools ?? []).map(t => t.function?.name).sort(), payload, text };
  if (sys.includes('independent Circuit Breaker Investigator')) return { ...base, kind: 'investigator', who: 'investigator', request: structured };
  if (sys.includes('You are an independent asynchronous supervisor')) {
    const idx = user.indexOf('{');
    const supReq = idx >= 0 ? safeJson(user.slice(idx)) : structured;
    return { ...base, kind: 'supervision', who: 'supervisor', request: supReq };
  }
  if (sys.includes('You are the Independent Arbiter participating in Stage 2')) return { ...base, kind: 'caucus-arbiter', who: 'arbiter', request: structured };
  if (sys.includes('You are a Dual Reviewer participating in Stage 2')) return { ...base, kind: 'caucus-reviewer', who: 'reviewer', request: structured };
  if (sys.includes('You are the Independent Arbiter opening a Stage 3 Formal 2-Party Conference')) return { ...base, kind: 'conference-opening', who: 'arbiter', request: structured };
  if (sys.includes('You are the Independent Arbiter in a Stage 3 Formal 2-Party Conference')) return { ...base, kind: 'conference-deliberation', who: 'arbiter', request: structured };
  if (sys.includes('You are the Independent Arbiter verifying whether a binding corrective directive')) return { ...base, kind: 'directive-verification', who: 'arbiter', request: structured };
  if (sys.includes('Review an incremental engineering plan')) return { ...base, kind: 'planning', who: 'planning', request: structured };
  if (sys.includes('independent serial-plan advocate')) return { ...base, kind: 'serial-review', who: 'serialReviewer', request: structured };
  if (sys.includes('You are the final safety gate')) return { ...base, kind: 'gate', who: 'gate', request: structured };
  if (sys.includes('independent arbiter')) return { ...base, kind: 'arbiter', who: 'arbiter', request: structured };
  if (sys.includes('consensus panel') && sys.includes('independent reviewers')) { return { ...base, kind: 'discuss', who: structured?.you_are ?? '?', request: structured }; }
  if (text.includes('# LeaderTeam: you are the team leader')) return { ...base, kind: 'leader', who: 'leader' };
  const d = text.match(/# LeaderTeam: Direct Execution Model \(\\"([a-z0-9-]+)\\"\)/);
  if (d) return { ...base, kind: 'direct_exec', who: d[1] };
  const m = text.match(/# LeaderTeam: you are team member \\"([a-z0-9-]+)\\"/);
  if (m) return { ...base, kind: 'member', who: m[1] };
  return { ...base, kind: 'other', who: 'other' };
}
function lastUserText(payload) {
  const msgs = payload.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { const c = msgs[i].content; return typeof c === 'string' ? c : (c ?? []).map(b => b.text ?? '').join(''); }
  return '';
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
/** Text of the most recent tool result in the request (the result the model just received). */
export function lastToolResult(c) {
  const msgs = c.payload.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'tool') { const x = msgs[i].content; return typeof x === 'string' ? x : (x ?? []).map(b => b.text ?? '').join(''); }
  return '';
}
/** Id of the latest approved kind="plan" agreement visible in the leader's tool results. */
export function latestPlanId(c) {
  const msgs = c?.payload?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'tool') continue;
    const text = typeof msgs[i].content === 'string' ? msgs[i].content : (msgs[i].content ?? []).map(b => b.text ?? '').join('');
    try {
      const v = JSON.parse(text);
      if (typeof v?.id === 'string' && v.id.startsWith('agr-') && v.kind === 'plan' && v.outcome?.decision === 'approve') return v.id;
    } catch {}
  }
  return undefined;
}
export const callsOf = (t, kind, who) => t.calls.filter(c => c.kind === kind && (who === undefined || c.who === who));
export const toolResults = run => run.events.filter(e => e.type === 'tool_result');
export function teamDir(t) {
  const teams = path.join(t.store, 'teams');
  const ids = fs.existsSync(teams) ? fs.readdirSync(teams) : [];
  assert.equal(ids.length, 1, `expected exactly one team, found ${ids.length}`);
  return path.join(teams, ids[0]);
}
export function jsonl(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
export const gateReceipts = t => jsonl(path.join(teamDir(t), 'gate.jsonl'));
export const agreementEvents = t => jsonl(path.join(teamDir(t), 'agreements.jsonl'));
export const governanceEvents = t => jsonl(path.join(teamDir(t), 'governance.jsonl'));
export const memberRecords = t => jsonl(path.join(teamDir(t), 'members.jsonl'));
export const exists = (t, rel) => fs.existsSync(path.join(t.ws, rel));
export const read = (t, rel) => fs.readFileSync(path.join(t.ws, rel), 'utf8');
export const allow = { json: { decision: 'allow', risk: 'low', reason: 'ordinary workspace edit' } };
export const approve = { json: { stance: 'approve', summary: 'fine', reasons: ['meets the goal'], required_changes: [] } };
export const PLAN = { tool: 'team_discuss', args: { kind: 'plan', topic: 'plan', proposal: 'Member impl writes src/a.txt.' } };
export const DELIVERY = { tool: 'team_discuss', args: { kind: 'delivery', topic: 'delivery', proposal: 'src/a.txt written.' } };
export const dispatch = (o = {}) => ({ tool: 'team_dispatch', args: { name: 'impl', task: 'Write src/a.txt containing A.', acceptance: ['src/a.txt contains A'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'code', tools: (o.profile === 'readonly' ? ['read','read_image','glob','grep','todo_write'] : o.profile === 'shell' ? ['read','read_image','glob','grep','todo_write','write','edit', process.platform === 'win32' ? 'pwsh' : 'bash','job_list','job_output','job_kill'] : ['read','read_image','glob','grep','todo_write','write','edit']), write_scope: ['src/**'], refs: ['spec.md'], ...o } });
export { assert };
