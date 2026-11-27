// Filter the host's actual registry view, including the scope's own registrations.
// The official resolve() snapshots this view for both model projection and dispatch.
import * as hostTools from '@deepseek-ai/dsh-tools';
import { filterToolView } from '../core/tool-policy.mjs';
import { evaluateToolsServiceResolveContract } from '../core/host-compat.mjs';

const PATCH = Symbol.for('leaderteam.toolSurface.v1');
const ToolsService = hostTools.ToolsService;

export function installToolSurface(actorFor) {
  const proto = ToolsService?.prototype;
  if (!proto) throw new Error('leaderteam: official ToolsService unavailable');
  if (proto[PATCH]) {
    proto[PATCH].actorFor = actorFor;
    proto[PATCH].filterToolView = filterToolView;
    return;
  }
  for (const name of ['view', 'resolve', 'definitions', 'get', 'executable']) {
    if (typeof proto[name] !== 'function') throw new Error(`leaderteam: tools.${name} unavailable; tool visibility cannot be guaranteed`);
  }
  const resolveSource = Function.prototype.toString.call(proto.resolve);
  if (!evaluateToolsServiceResolveContract(resolveSource).compatible) {
    throw new Error('leaderteam: tool admission implementation changed; refusing unverified tool projection');
  }
  const state = { originalView: proto.view, actorFor, filterToolView };
  Object.defineProperty(proto, PATCH, { value: state });
  proto.view = function leaderteamToolView(scope) {
    const view = state.originalView.call(this, scope);
    if (!scope?.session) return view;
    const filterFn = typeof state.filterToolView === 'function' ? state.filterToolView : filterToolView;
    return filterFn(view, state.actorFor(scope));
  };
}

// Discovery metadata comes from the unfiltered registry, never from a model-facing view.
export function registeredDefinitions(service, scope) {
  const state = ToolsService?.prototype[PATCH];
  if (!state) throw new Error('leaderteam: tool projection is not installed');
  return [...state.originalView.call(service, scope).visible.values()];
}
