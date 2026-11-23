// Team model identities and usage come from actual receipts, separately from configured roles.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { TeamStore, readJsonl } from '../core/store.mjs';
const cache = new Map();
const fields = ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','totalTokens'];
const measured = usage => usage && fields.some(k => Number.isFinite(usage[k]) && usage[k] > 0);
const nativeResponse = row => row.data?.usage || (row.type === 'assistant/message' && row.data?.message?.source?.model);
const sum = rows => Object.fromEntries(fields.map(k => [k, rows.reduce((n,r) => n + (r.usage?.[k] ?? (k === 'totalTokens' && r.usage ? ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].reduce((n,f)=>n+(r.usage[f]??0),0) : 0)),0)]));

export function summarizeTeamUsage(sessions, governance) {
  const receipts = [];
  for (const s of sessions) {
    const seen = new Set(); let route = null;
    for (const row of s.rows) {
      route = row.data?.header?.config?.model ?? (row.type === 'model/selection' ? row.data?.model : null) ?? route;
      if (!nativeResponse(row) || row.surfaceOp === 'seed') continue;
      const key = row.data.message?.id ?? `${row.type}:${row.seq ?? row.time}`;
      if (seen.has(key)) continue; seen.add(key);
      receipts.push({ group:s.group, session:s.id, member:s.name, route:row.data?.message?.source?.model ?? route ?? 'unknown', usage:row.data.usage });
    }
  }
  receipts.push(...governance.map(r => ({...r, group:'governance'})));
  const groups = Object.fromEntries(['leader','governance','execution'].map(group => {
    const rows = receipts.filter(r=>r.group===group);
    const awaitingUsage = sessions.filter(s=>s.group===group&&s.rows.some(r=>r.type==='request/header')&&!rows.some(r=>r.session===s.id)).length;
    return [group,{ tokens:sum(rows),receiptCount:rows.length,missingUsage:rows.filter(r=>!measured(r.usage)).length,awaitingUsage }];
  }));
  return { groups,total:sum(receipts),members:sessions.filter(s=>s.group==='execution').map(s=>({id:s.id,name:s.name,available:s.available,tokens:sum(receipts.filter(r=>r.group==='execution'&&r.session===s.id)),actualModels:[...new Set(receipts.filter(r=>r.group==='execution'&&r.session===s.id).map(r=>r.route))]})),
    byModel:Object.fromEntries([...new Set(receipts.map(r=>r.route))].map(route=>[route,sum(receipts.filter(r=>r.route===route))])),
    complete:sessions.every(s=>s.available!==false)&&!receipts.some(r=>!measured(r.usage))&&!Object.values(groups).some(g=>g.awaitingUsage),
    notes:['包含缓存；每条消息和治理回执只计一次，不重复计 stream/chunk。','未返回的用量和外部修复 Agent 消耗未计入；费用不可用时不显示为零。'], cost:null };
}

function durableRows(home,id) {
  if (!home) return null;
  const root=path.join(home,'sessions'); let dirs;
  try { dirs=fs.readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()); } catch { return null; }
  for (const dir of dirs) {
    const file=path.join(root,dir.name,id,'session.v4.jsonl.zstd'); let stat;
    try { stat=fs.statSync(file); } catch { continue; }
    const signature=`${stat.mtimeMs}:${stat.size}`;
    if (cache.get(file)?.signature===signature) return cache.get(file).rows;
    const buf=fs.readFileSync(file),starts=[];
    for(let i=0;i+3<buf.length;i++)if(buf[i]===0x28&&buf[i+1]===0xb5&&buf[i+2]===0x2f&&buf[i+3]===0xfd)starts.push(i);
    const parts=[];let n=0;
    while(n<starts.length){let found=false;for(let end=n+1;end<=starts.length;end++){try{parts.push(zlib.zstdDecompressSync(buf.subarray(starts[n],starts[end]??buf.length)));n=end;found=true;break;}catch{}}if(!found)throw new Error('cannot decode native session log');}
    const rows=Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    cache.set(file,{signature,rows});return rows;
  }
  return null;
}

export function teamObservability(ctx,rt,teamId) {
  const store=new TeamStore(rt.storageRoot,teamId);
  const governance=readJsonl(path.join(store.dir,'usage.jsonl')).records;
  let snapshot;
  try { snapshot=JSON.parse(fs.readFileSync(path.join(store.dir,'governance.json'),'utf8')); } catch {}
  const cfg=snapshot?.config??rt.config;
  let home=process.env.DSH_HOME;
  try { home??=ctx?.get?.('profileContext')?.home; } catch {}
  home??=path.dirname(rt.storageRoot);
  const members=[...store.members().values()];
  const sessions=[{id:teamId,name:'leader',group:'leader'},...members.map(m=>({id:m.childId,name:m.name,group:'execution'}))].map(s=>{
    let rows=rt.actors.get(s.id)?.agent?.session?.snapshotEvents?.();
    if (!rows?.some(nativeResponse)) rows=durableRows(home,s.id);
    return {...s,rows:rows??[],available:rows!==null&&rows!==undefined};
  });
  return { teamId,governanceSha256:snapshot?.sourceSha256??null,
    roles:Object.entries(cfg.roles).map(([role,value])=>{
      const actual=governance.filter(r=>r.role===role);
      const leaderRows=sessions[0].rows.filter(nativeResponse);
      const requestRoutes=role==='leader'?[...new Set(sessions[0].rows.filter(r=>r.type==='request/header').map(r=>r.data?.header?.config?.model).filter(Boolean))]:[];
      return {role,configured:value,actualRoutes:role==='leader'?[...new Set(leaderRows.map(r=>r.data?.message?.source?.model).filter(Boolean))]:[...new Set(actual.map(r=>r.route))],
        requestRoutes,requested:requestRoutes.length>0,
        calls:role==='leader'?leaderRows.length:actual.length,called:role==='leader'?leaderRows.length>0:actual.length>0,
        degraded:actual.some(r=>r.degraded),missingUsage:role==='leader'?leaderRows.filter(r=>!measured(r.data.usage)).length:actual.filter(r=>!measured(r.usage)).length,tokens:role==='leader'?sum(leaderRows.map(r=>({usage:r.data.usage}))):sum(actual)};
    }), members:members.map(m=>({id:m.childId,name:m.name,configuredModel:m.model,effort:m.effort,status:m.status})),usage:summarizeTeamUsage(sessions,governance) };
}

export function recentTeamObservability(ctx,rt,limit=8) {
  const root=path.join(rt.storageRoot,'teams');let dirs;
  try { dirs=fs.readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>({id:d.name,time:fs.statSync(path.join(root,d.name)).mtimeMs})).sort((a,b)=>b.time-a.time); } catch { return []; }
  return dirs.slice(0,limit).map(d=>{try{return teamObservability(ctx,rt,d.id);}catch(e){return{teamId:d.id,error:e.message};}});
}
