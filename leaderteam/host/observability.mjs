// Team model identities and usage come from actual receipts, separately from configured roles.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { TeamStore, readJsonl, resolveTeamStoreLogicalId } from '../core/store.mjs';
import { decodeSessionModeSegment } from '../core/session-mode.mjs';
import { isInside } from '../core/paths.mjs';
import { resolveCanonicalRouteFromHostSelection } from './runtime.mjs';

export const MAX_CACHED_SESSIONS = 32;
const cache = new Map();
const fields = ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','totalTokens'];
const measured = usage => usage && fields.some(k => Number.isFinite(usage[k]) && usage[k] > 0);
const nativeResponse = row => row.data?.usage
  || (row.type === 'assistant/message' && (row.data?.message?.source?.model || row.data?.source?.model))
  || (row.type === 'compaction/summary' && row.data?.model);
const nativeRowKey = row => row.data?.message?.id
  ?? (row.data?.compactionId ? `compaction:${row.data.compactionId}` : null)
  ?? `${row.type}:${row.seq ?? row.time}`;
const sum = rows => Object.fromEntries(fields.map(k => [k, rows.reduce((n,r) => n + (r.usage?.[k] ?? (k === 'totalTokens' && r.usage ? ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].reduce((n,f)=>n+(r.usage[f]??0),0) : 0)),0)]));

function encodeDshSegment(raw) {
  const s = String(raw ?? '');
  if (s.length === 0) return '~';
  if (s === '.') return '~002E';
  if (s === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = String.fromCharCode(code);
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

function extractNativeRowRoute(row, fallbackRoute = null, cfg = null) {
  const isCompaction = row.type === 'compaction/summary';
  const rawModel = isCompaction
    ? (row.data?.model ?? row.data?.message?.source?.model ?? null)
    : (row.data?.message?.source?.model ?? row.data?.source?.model ?? null);
  const rawProv = isCompaction
    ? (row.data?.provider ?? row.data?.message?.source?.provider ?? null)
    : (row.data?.message?.source?.provider ?? row.data?.source?.provider ?? null);
  if (typeof rawModel === 'string' && rawModel.trim()) {
    return cfg ? resolveCanonicalRouteFromHostSelection(cfg, rawProv, rawModel, rawModel) : rawModel.trim();
  }
  return fallbackRoute;
}

function decodeZstdSessionLog(buf) {
  if (!buf || buf.length === 0) return Buffer.alloc(0);
  try {
    return zlib.zstdDecompressSync(buf);
  } catch {}
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  const parts = [];
  let n = 0;
  while (n < starts.length) {
    let found = false;
    for (let end = n + 1; end <= starts.length; end++) {
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(starts[n], starts[end] ?? buf.length)));
        n = end;
        found = true;
        break;
      } catch {}
    }
    if (!found) {
      if (parts.length > 0) break;
      throw new Error('cannot decode native session log');
    }
  }
  return Buffer.concat(parts);
}

export function summarizeTeamUsage(sessions, governance, cfg = null) {
  const receipts = [];
  for (const s of sessions) {
    const seen = new Map();
    let route = null;
    for (const row of s.rows) {
      route = row.data?.header?.config?.model ?? (row.type === 'model/selection' ? row.data?.model : null) ?? route;
      if (!nativeResponse(row) || row.surfaceOp === 'seed') continue;
      const key = nativeRowKey(row);
      const resolvedRoute = extractNativeRowRoute(row, route, cfg) ?? 'unknown';
      if (seen.has(key)) {
        const prevIdx = seen.get(key);
        const prev = receipts[prevIdx];
        if (prev && !measured(prev.usage) && (measured(row.data?.usage) || (!prev.usage && row.data?.usage))) {
          receipts[prevIdx] = {
            ...prev,
            route: resolvedRoute !== 'unknown' ? resolvedRoute : prev.route,
            usage: row.data.usage,
          };
        }
        continue;
      }
      seen.set(key, receipts.length);
      receipts.push({ group: s.group, session: s.id, member: s.name, route: resolvedRoute, usage: row.data?.usage });
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

function setBoundedSessionCache(file, entry) {
  if (cache.has(file)) cache.delete(file);
  while (cache.size >= MAX_CACHED_SESSIONS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(file, entry);
}

export function _observabilityCacheSizeForTest() {
  return cache.size;
}

function durableRows(home,id,fallbackSeg=null) {
  if (!home || !id) return null;
  const root=path.join(home,'sessions');
  const isSafeRaw=/^[A-Za-z0-9._-]+$/.test(id)&&id!=='.'&&id!=='..'&&!id.includes('..');
  const isSafeFallback=typeof fallbackSeg==='string'&&/^[A-Za-z0-9._~-]+$/.test(fallbackSeg)&&fallbackSeg!=='.'&&fallbackSeg!=='..'&&!fallbackSeg.includes('..');
  const segs=[...new Set([
    ...(isSafeRaw?[id]:[]),
    encodeDshSegment(id),
    ...(isSafeFallback?[fallbackSeg]:[]),
  ])];
  const candidates=[];
  for (const seg of segs) candidates.push(path.join(root,seg,'session.v4.jsonl.zstd'));
  try {
    const dirs=fs.readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory());
    for (const dir of dirs) {
      for (const seg of segs) candidates.push(path.join(root,dir.name,seg,'session.v4.jsonl.zstd'));
    }
  } catch {
    if (candidates.length === 0) return null;
  }
  const absRoot=path.resolve(root);
  for (const file of candidates) {
    if (!isInside(path.resolve(file),absRoot)) continue;
    let stat;
    try { stat=fs.statSync(file); } catch { continue; }
    const signature=`${stat.mtimeMs}:${stat.size}`;
    const existing=cache.get(file);
    if (existing?.signature===signature) {
      cache.delete(file);
      cache.set(file, existing);
      return existing.rows;
    }
    const buf=fs.readFileSync(file);
    const rows=decodeZstdSessionLog(buf).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    setBoundedSessionCache(file,{signature,rows});
    return rows;
  }
  return null;
}

function dedupedNativeRows(rows) {
  const out = [];
  const seen = new Map();
  for (const r of rows) {
    if (!nativeResponse(r) || r.surfaceOp === 'seed') continue;
    const k = nativeRowKey(r);
    if (seen.has(k)) {
      const prevIdx = seen.get(k);
      const prev = out[prevIdx];
      if (prev && !measured(prev.data?.usage) && (measured(r.data?.usage) || (!prev.data?.usage && r.data?.usage))) {
        out[prevIdx] = r;
      }
      continue;
    }
    seen.set(k, out.length);
    out.push(r);
  }
  return out;
}

export function teamObservability(ctx,rt,teamId) {
  const store=new TeamStore(rt.storageRoot,teamId);
  let teamMeta;
  try { teamMeta=JSON.parse(fs.readFileSync(path.join(store.dir,'team.json'),'utf8')); } catch {}
  const metaSessionId=typeof teamMeta?.sessionId==='string'&&teamMeta.sessionId.trim()?teamMeta.sessionId.trim():null;
  const decodedMetaTeamId=(!metaSessionId&&typeof teamMeta?.teamId==='string'&&teamMeta.teamId.trim()&&!/~h[0-9a-f]{32}$/.test(teamMeta.teamId.trim()))
    ?decodeSessionModeSegment(teamMeta.teamId.trim())
    :null;
  const gateTeamId=metaSessionId
    ?null
    :(readJsonl(store.gateFile).records.find(r=>typeof r?.teamId==='string'&&r.teamId.trim())?.teamId?.trim()??null);
  const resolvedTeamId=rt.actors.has(teamId)
    ?teamId
    :(metaSessionId??gateTeamId??decodedMetaTeamId??(teamId!==store.teamId?teamId:decodeSessionModeSegment(store.teamId)));
  const governance=readJsonl(path.join(store.dir,'usage.jsonl')).records;
  let snapshot;
  try { snapshot=JSON.parse(fs.readFileSync(path.join(store.dir,'governance.json'),'utf8')); } catch {}
  const cfg=snapshot?.config??rt.config;
  let home=process.env.DSH_HOME;
  try { home??=ctx?.get?.('profileContext')?.home; } catch {}
  home??=path.dirname(rt.storageRoot);
  const members=[...store.members().values()];
  const sessions=[
    {id:resolvedTeamId,name:'leader',group:'leader',actorRole:'leader',configuredModel:null,fallbackSeg:store.teamId},
    ...members.map(m=>({id:m.childId,name:m.name,group:'execution',actorRole:m.actorRole??'member',configuredModel:m.model??null,fallbackSeg:null})),
  ].map(s=>{
    let rows=rt.actors.get(s.id)?.agent?.session?.snapshotEvents?.();
    if (!rows?.some(nativeResponse)) rows=durableRows(home,s.id,s.fallbackSeg);
    return {...s,rows:rows??[],available:rows!==null&&rows!==undefined};
  });
  const extractSessionFallbackRoute = sess => {
    let fallback = sess.configuredModel ?? null;
    for (const r of sess.rows) {
      fallback = r.data?.header?.config?.model ?? (r.type === 'model/selection' ? r.data?.model : null) ?? fallback;
    }
    return fallback;
  };
  const leaderFallbackRoute = extractSessionFallbackRoute(sessions[0]);
  const leaderRows=dedupedNativeRows(sessions[0].rows);
  const directSessions=sessions.filter(s=>s.actorRole==='direct_exec');
  const directNativeEntries=directSessions.flatMap(ds=>{
    const fb=extractSessionFallbackRoute(ds);
    return dedupedNativeRows(ds.rows).map(r=>({row:r,route:extractNativeRowRoute(r,fb,cfg)}));
  });
  return { teamId:resolvedTeamId,governanceSha256:snapshot?.sourceSha256??null,
    roles:Object.entries(cfg?.roles??{}).map(([role,value])=>{
      const actual=governance.filter(r=>r.role===role);
      if (role==='leader') {
        const requestRoutes=[...new Set(sessions[0].rows.filter(r=>r.type==='request/header').map(r=>r.data?.header?.config?.model).filter(Boolean))];
        return {role,configured:value,
          actualRoutes:[...new Set(leaderRows.map(r=>extractNativeRowRoute(r,leaderFallbackRoute,cfg)).filter(Boolean))],
          requestRoutes,requested:requestRoutes.length>0,
          calls:leaderRows.length,called:leaderRows.length>0,
          degraded:actual.some(r=>r.degraded),
          missingUsage:leaderRows.filter(r=>!measured(r.data?.usage)).length,
          tokens:sum(leaderRows.map(r=>({usage:r.data?.usage})))};
      }
      if (role==='directExec') {
        const requestRoutes=[...new Set(directSessions.flatMap(ds=>ds.rows.filter(r=>r.type==='request/header').map(r=>r.data?.header?.config?.model).filter(Boolean)))];
        const combinedRoutes=[...new Set([
          ...directNativeEntries.map(e=>e.route).filter(Boolean),
          ...actual.map(r=>r.route).filter(Boolean),
        ])];
        const totalCalls=directNativeEntries.length+actual.length;
        const missingCount=directNativeEntries.filter(e=>!measured(e.row.data?.usage)).length+actual.filter(r=>!measured(r.usage)).length;
        const combinedUsage=[...directNativeEntries.map(e=>({usage:e.row.data?.usage})),...actual];
        return {role,configured:value,
          actualRoutes:combinedRoutes,
          requestRoutes,requested:requestRoutes.length>0,
          calls:totalCalls,called:totalCalls>0,
          degraded:actual.some(r=>r.degraded),
          missingUsage:missingCount,
          tokens:sum(combinedUsage)};
      }
      return {role,configured:value,
        actualRoutes:[...new Set(actual.map(r=>r.route))],
        requestRoutes:[],requested:false,
        calls:actual.length,called:actual.length>0,
        degraded:actual.some(r=>r.degraded),
        missingUsage:actual.filter(r=>!measured(r.usage)).length,
        tokens:sum(actual)};
    }), members:members.map(m=>({id:m.childId,name:m.name,configuredModel:m.model,effort:m.effort,status:m.status})),usage:summarizeTeamUsage(sessions,governance,cfg) };
}

export function recentTeamObservability(ctx,rt,limit=8) {
  const root=path.join(rt.storageRoot,'teams');let dirs;
  try {
    dirs=fs.readdirSync(root,{withFileTypes:true})
      .filter(d=>{
        if (!d.isDirectory()) return false;
        const dirPath=path.join(root,d.name);
        return fs.existsSync(path.join(dirPath,'members.jsonl')) || fs.existsSync(path.join(dirPath,'team.json'));
      })
      .map(d=>({
        id:resolveTeamStoreLogicalId(rt.storageRoot,d.name),
        time:fs.statSync(path.join(root,d.name)).mtimeMs,
      }))
      .sort((a,b)=>b.time-a.time);
  } catch { return []; }
  return dirs.slice(0,limit).map(d=>{try{return teamObservability(ctx,rt,d.id);}catch(e){return{teamId:d.id,error:e.message};}});
}
