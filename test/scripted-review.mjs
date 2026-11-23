// Migrate old valid scripted reviewer replies to the revision-accounting protocol.
// Deliberately malformed or bare-refusal replies retain their original defects.
import { hashJson } from '../leaderteam/core/canonical.mjs';
export function scriptedReview(reply,request={}, {hardRequirements=false}={}) {
  if (typeof request==='string') { try { request=JSON.parse(request); } catch { request={}; } }
  const wasString=typeof reply==='string';let v;
  try { v=wasString?JSON.parse(reply):structuredClone(reply); } catch { return reply; }
  if (!v || !['approve','revise','reject'].includes(v.stance) || !Array.isArray(v.required_changes)) return reply;
  const previous=request.previous_change_items??[];
  if (!v.change_items) v.change_items=v.required_changes.map(problem=>({id:hashJson(problem).slice(0,16),problem,evidence:v.reasons?.join('; ')||'fixture evidence',suggestion:v.suggestions?.join('; ')||'fixture suggestion',hard_blocker:false,category:'ordinary'}));
  if (hardRequirements) v.change_items=v.change_items.map(i=>({...i,hard_blocker:true,category:'user_requirement'}));
  if (previous.length && !v.resolutions) v.resolutions=previous.map(p=>({id:p.id,status:v.required_changes.includes(p.problem)?'unresolved':'resolved',evidence:'scripted revision evidence for '+p.problem}));
  return wasString?JSON.stringify(v):v;
}
