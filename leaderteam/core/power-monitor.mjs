// Pure battery-aware graceful shutdown state machine for LeaderTeam.
// Zero OS / Node fs / child_process imports — pure JS ESM ready for future Rust port.

export const DEFAULT_POWER_MONITOR_CONFIG = Object.freeze({
  enabled: true,
  pollIntervalMs: 720000,
  minPollIntervalMs: 600000,
  maxPollIntervalMs: 900000,
  lowBatteryPct: 20,
  resetBatteryPct: 25,
});

export function normalizePowerMonitorConfig(cfg = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const minPollIntervalMs = Number.isFinite(c.minPollIntervalMs) && c.minPollIntervalMs >= 1000
    ? Math.trunc(c.minPollIntervalMs)
    : DEFAULT_POWER_MONITOR_CONFIG.minPollIntervalMs;
  const maxPollIntervalMs = Number.isFinite(c.maxPollIntervalMs) && c.maxPollIntervalMs >= minPollIntervalMs
    ? Math.trunc(c.maxPollIntervalMs)
    : Math.max(minPollIntervalMs, DEFAULT_POWER_MONITOR_CONFIG.maxPollIntervalMs);
  const rawPoll = Number.isFinite(c.pollIntervalMs)
    ? Math.trunc(c.pollIntervalMs)
    : DEFAULT_POWER_MONITOR_CONFIG.pollIntervalMs;
  const pollIntervalMs = Math.max(minPollIntervalMs, Math.min(maxPollIntervalMs, rawPoll));
  const lowBatteryPct = typeof c.lowBatteryPct === 'number' && Number.isFinite(c.lowBatteryPct)
    ? Math.max(1, Math.min(95, c.lowBatteryPct))
    : DEFAULT_POWER_MONITOR_CONFIG.lowBatteryPct;
  const resetBatteryPct = typeof c.resetBatteryPct === 'number' && Number.isFinite(c.resetBatteryPct)
    ? Math.max(lowBatteryPct + 1, Math.min(100, c.resetBatteryPct))
    : Math.max(lowBatteryPct + 1, DEFAULT_POWER_MONITOR_CONFIG.resetBatteryPct);
  return {
    enabled: c.enabled !== false,
    pollIntervalMs,
    minPollIntervalMs,
    maxPollIntervalMs,
    lowBatteryPct,
    resetBatteryPct,
  };
}

export function createPowerMonitorState() {
  return {
    v: 1,
    latched: false,
    pendingNotice: false,
    autoResumeAllowed: false,
    triggerCount: 0,
    lastTriggeredAtMs: null,
    lastAckedAtMs: null,
    lastAckMeta: null,
    lastRearmedAtMs: null,
    lastSampleStatus: 'unknown',
    lastOnBattery: null,
    lastBatteryPct: null,
    lastSampledAtMs: null,
  };
}

function buildGracefulShutdownNotice(batteryPct, lowBatteryPct, triggeredAtMs) {
  const instructions = Object.freeze({
    stopNewNonEssentialDispatches: true,
    allowInFlightSafeCheckpoint: true,
    persistProgressAndResumeEntry: true,
    killProcesses: false,
    autoResumeAllowed: false,
  });
  const summary = `低电量保护性收尾提醒：当前电池供电剩余 ${batteryPct}%（阈值 ${lowBatteryPct}%）`;
  const text = [
    `[LeaderTeam 低电量优雅收尾保护] 检测到设备当前处于电池供电且剩余电量为 ${batteryPct}%（<= ${lowBatteryPct}%）。请立即进入保护性收尾流程：`,
    '1. 停止新派发非必要的执行子代理（暂停新的 team_dispatch 扩派）；',
    '2. 让已在运行中的子代理平稳完成当前安全写入或检查点，严禁强杀进程或直接中断正在写盘的子代理；',
    '3. 将当前已完成进度、待续节点与明确恢复入口写入项目参考记录（team_note / 当前计划检查点），平稳暂停等待用户后续指令；',
    '4. 即使后续接通电源或电量回升，系统也绝不自动恢复已暂停项目，必须由用户显式下达继续指令。',
  ].join('\n');
  return {
    kind: 'low-battery-graceful-shutdown',
    batteryPct,
    lowBatteryPct,
    triggeredAtMs,
    triggeredAt: new Date(triggeredAtMs).toISOString(),
    summary,
    text,
    instructions,
  };
}

function ensureMutableTarget(state) {
  if (!state || typeof state !== 'object') return createPowerMonitorState();
  if (Object.isFrozen(state)) return { ...createPowerMonitorState(), ...state, autoResumeAllowed: false };
  return state;
}

/**
 * Pure state transition for a single battery sample.
 * Mutates `state` in place (unless frozen/missing) AND returns `{ action, state, latched, pendingNotice, autoResumeAllowed, ... }`.
 */
export function evaluatePowerSample(state, sample, cfg = DEFAULT_POWER_MONITOR_CONFIG, nowMs = Date.now()) {
  const target = ensureMutableTarget(state);
  target.autoResumeAllowed = false;
  const c = normalizePowerMonitorConfig(cfg);
  const ts = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();

  if (!c.enabled) {
    return {
      action: 'none',
      disabled: true,
      latched: Boolean(target.latched),
      pendingNotice: Boolean(target.pendingNotice),
      autoResumeAllowed: false,
      killProcesses: false,
      notice: null,
      reason: 'power monitor disabled',
      state: target,
    };
  }

  const status = sample && (sample.status === 'ok' || sample.status === 'unsupported' || sample.status === 'unknown')
    ? sample.status
    : 'unknown';

  if (status !== 'ok') {
    target.lastSampleStatus = status;
    target.lastSampledAtMs = ts;
    return {
      action: 'none',
      disabled: false,
      latched: Boolean(target.latched),
      pendingNotice: Boolean(target.pendingNotice),
      autoResumeAllowed: false,
      killProcesses: false,
      notice: null,
      reason: status === 'unsupported'
        ? 'battery hardware unsupported (silent no-op)'
        : 'battery status unknown (silent no-op)',
      state: target,
    };
  }

  const onBattery = typeof sample.onBattery === 'boolean' ? sample.onBattery : null;
  const rawPct = typeof sample.batteryPct === 'number' && Number.isFinite(sample.batteryPct) ? sample.batteryPct : null;
  const batteryPct = rawPct !== null ? Math.max(0, Math.min(100, rawPct)) : null;

  target.lastSampleStatus = 'ok';
  target.lastOnBattery = onBattery;
  target.lastBatteryPct = batteryPct;
  target.lastSampledAtMs = ts;

  // Reset condition: AC connected (onBattery === false) OR batteryPct >= resetBatteryPct (e.g. 25%).
  // CRITICAL INVARIANT: rearmed ONLY resets the detector latch and MUST keep autoResumeAllowed: false!
  if (onBattery === false || (batteryPct !== null && batteryPct >= c.resetBatteryPct)) {
    if (target.latched) {
      target.latched = false;
      target.pendingNotice = false;
      target.lastRearmedAtMs = ts;
      target.autoResumeAllowed = false;
      return {
        action: 'rearmed',
        disabled: false,
        latched: false,
        pendingNotice: false,
        autoResumeAllowed: false,
        killProcesses: false,
        notice: null,
        reason: onBattery === false
          ? 'AC power connected; low-battery latch rearmed (autoResumeAllowed=false)'
          : `battery recovered to ${batteryPct}% >= ${c.resetBatteryPct}%; low-battery latch rearmed (autoResumeAllowed=false)`,
        state: target,
      };
    }
    return {
      action: 'none',
      disabled: false,
      latched: false,
      pendingNotice: false,
      autoResumeAllowed: false,
      killProcesses: false,
      notice: null,
      reason: 'power healthy',
      state: target,
    };
  }

  // Trigger condition: onBattery === true && numeric batteryPct <= lowBatteryPct (20%).
  if (!target.latched && onBattery === true && batteryPct !== null && batteryPct <= c.lowBatteryPct) {
    target.latched = true;
    target.pendingNotice = true;
    target.triggerCount = (Number.isInteger(target.triggerCount) ? target.triggerCount : 0) + 1;
    target.lastTriggeredAtMs = ts;
    target.autoResumeAllowed = false;
    const notice = buildGracefulShutdownNotice(batteryPct, c.lowBatteryPct, ts);
    return {
      action: 'notify_graceful_shutdown',
      disabled: false,
      latched: true,
      pendingNotice: true,
      autoResumeAllowed: false,
      killProcesses: false,
      notice,
      summary: notice.summary,
      text: notice.text,
      instructions: notice.instructions,
      reason: `battery at ${batteryPct}% (<= ${c.lowBatteryPct}%) on battery power`,
      state: target,
    };
  }

  // Already latched and still < resetBatteryPct on battery:
  if (target.latched) {
    if (target.pendingNotice) {
      const effectivePct = batteryPct ?? target.lastBatteryPct ?? c.lowBatteryPct;
      const notice = buildGracefulShutdownNotice(effectivePct, c.lowBatteryPct, target.lastTriggeredAtMs ?? ts);
      return {
        action: 'retry_pending_notice',
        disabled: false,
        latched: true,
        pendingNotice: true,
        autoResumeAllowed: false,
        killProcesses: false,
        notice,
        summary: notice.summary,
        text: notice.text,
        instructions: notice.instructions,
        reason: 'graceful shutdown notice still pending delivery acknowledgment',
        state: target,
      };
    }
    return {
      action: 'none',
      disabled: false,
      latched: true,
      pendingNotice: false,
      autoResumeAllowed: false,
      killProcesses: false,
      notice: null,
      reason: 'low-battery shutdown already acknowledged; suppressing duplicate notice',
      state: target,
    };
  }

  return {
    action: 'none',
    disabled: false,
    latched: false,
    pendingNotice: false,
    autoResumeAllowed: false,
    killProcesses: false,
    notice: null,
    reason: 'power within operating band',
    state: target,
  };
}

/** Mark the pending graceful-shutdown notice as durably delivered/acknowledged while keeping `latched = true`. */
export function acknowledgePowerShutdownNotice(state, ackMeta = null) {
  const target = ensureMutableTarget(state);
  const ts = typeof ackMeta?.ackedAtMs === 'number' && Number.isFinite(ackMeta.ackedAtMs)
    ? ackMeta.ackedAtMs
    : (typeof ackMeta?.nowMs === 'number' && Number.isFinite(ackMeta.nowMs) ? ackMeta.nowMs : Date.now());
  target.pendingNotice = false;
  target.autoResumeAllowed = false;
  target.lastAckedAtMs = ts;
  if (ackMeta && typeof ackMeta === 'object') {
    const copy = { ...ackMeta };
    delete copy.nowMs;
    target.lastAckMeta = copy;
  } else {
    target.lastAckMeta = null;
  }
  return target;
}

/** Convert power monitor state to a clean JSON-serializable plain object. */
export function serializePowerState(state) {
  const s = state && typeof state === 'object' ? state : createPowerMonitorState();
  return {
    v: 1,
    latched: Boolean(s.latched),
    pendingNotice: Boolean(s.pendingNotice),
    autoResumeAllowed: false,
    triggerCount: Number.isInteger(s.triggerCount) && s.triggerCount >= 0 ? s.triggerCount : 0,
    lastTriggeredAtMs: typeof s.lastTriggeredAtMs === 'number' && Number.isFinite(s.lastTriggeredAtMs) ? s.lastTriggeredAtMs : null,
    lastAckedAtMs: typeof s.lastAckedAtMs === 'number' && Number.isFinite(s.lastAckedAtMs) ? s.lastAckedAtMs : null,
    lastAckMeta: s.lastAckMeta && typeof s.lastAckMeta === 'object' && !Array.isArray(s.lastAckMeta) ? { ...s.lastAckMeta } : null,
    lastRearmedAtMs: typeof s.lastRearmedAtMs === 'number' && Number.isFinite(s.lastRearmedAtMs) ? s.lastRearmedAtMs : null,
    lastSampleStatus: s.lastSampleStatus === 'ok' || s.lastSampleStatus === 'unsupported' || s.lastSampleStatus === 'unknown'
      ? s.lastSampleStatus
      : 'unknown',
    lastOnBattery: typeof s.lastOnBattery === 'boolean' ? s.lastOnBattery : null,
    lastBatteryPct: typeof s.lastBatteryPct === 'number' && Number.isFinite(s.lastBatteryPct)
      ? Math.max(0, Math.min(100, s.lastBatteryPct))
      : null,
    lastSampledAtMs: typeof s.lastSampledAtMs === 'number' && Number.isFinite(s.lastSampledAtMs) ? s.lastSampledAtMs : null,
  };
}

/** Hydrate persisted power monitor state from a plain object or JSON string. Never throws; enforces autoResumeAllowed=false. */
export function hydratePowerState(raw) {
  if (raw === null || raw === undefined) return createPowerMonitorState();
  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.replace(/^\uFEFF/, '').trim();
    if (!trimmed) return createPowerMonitorState();
    try {
      parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    } catch {
      return createPowerMonitorState();
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return createPowerMonitorState();
  }
  return serializePowerState(parsed);
}
