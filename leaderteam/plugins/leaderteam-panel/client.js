/**
 * LeaderTeam In-DSH Visual Console (`leaderteam-panel`)
 * Mounts inside DSH Web/Desktop left navigation (`sidebar.panellist` + `main`) and right sidebar (`sidebarRightTabs`)
 * for live DSH upstream model discovery, role/pool configuration, detachable plugin switches,
 * project/task timers, and fixed-external plan archive retrospectives & cleanup.
 */
(function initLeaderTeamPanelClient() {
  const PANEL_ID = 'leaderteam-panel';
  const PANEL_ORDER = 25;
  const ROUTES = {
    STATE: 'api/leaderteam-panel/state',
    DISCOVER: 'api/leaderteam-panel/discover',
    APPLY: 'api/leaderteam-panel/apply',
    ARCHIVE: 'api/leaderteam-panel/archive',
    RETROSPECT: 'api/leaderteam-panel/retrospect',
    CLEAN: 'api/leaderteam-panel/clean',
  };
  const ROLE_META = [
    { key: 'leader', label: '领队 (leader)' },
    { key: 'gate', label: '安全门 (gate)' },
    { key: 'discussA', label: '评审 A (discussA)' },
    { key: 'discussB', label: '评审 B (discussB)' },
    { key: 'arbiter', label: '独立裁断 (arbiter)' },
  ];
  const PLUGIN_META = [
    { key: 'scheduler', label: '弹性并发调度 (leaderteam-scheduler)', desc: '设备负载感知、渐进扩缩容与对话实时限速' },
    { key: 'consensus', label: '有责对称评审与裁断 (leaderteam-consensus)', desc: '双盲有责评审（理由+建议）与独立裁断' },
    { key: 'timerArchive', label: '工程计时与外部计划归档 (leaderteam-timer-archive)', desc: '项目/任务计时、防停滞择优执行、固定外部路径归档与复审' },
    { key: 'panel', label: 'DSH 内置控制台 (leaderteam-panel)', desc: 'DSH 内部模型/角色/归档可视化面板' },
  ];

  function formatMs(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '0s';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + 's';
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return min + 'm ' + remSec + 's';
    const hr = Math.floor(min / 60);
    return hr + 'h ' + (min % 60) + 'm';
  }

  async function postApi(route, body) {
    const res = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json || json.ok !== true) {
      const msg = (json && json.error && json.error.message) ? json.error.message : 'Request failed';
      throw new Error(msg);
    }
    return json.value;
  }

  function createLeaderTeamPanelClient(requireFn) {
    const React = requireFn('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    function PanelIcon(props) {
      const size = (props && typeof props.size === 'number') ? props.size : 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
        h('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
        h('rect', { x: 8.5, y: 14, width: 7, height: 7, rx: 1.5 }),
        h('path', { d: 'M6.5 10v2.5h11V10' }),
        h('path', { d: 'M12 12.5V14' })
      );
    }

    function TabTitle() {
      return h('span', { style: { fontWeight: 600, fontSize: '12px' } }, 'LeaderTeam');
    }

    function ConsoleView(props) {
      const compact = props && props.host === 'sidebar';
      const [tab, setTab] = useState('models');
      const [teamId, setTeamId] = useState('');
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(false);
      const [notice, setNotice] = useState(null);
      const [error, setError] = useState(null);
      const [saveTarget, setSaveTarget] = useState('local');

      // Draft edits for roles & pool
      const [draftRoles, setDraftRoles] = useState({});
      const [draftPool, setDraftPool] = useState([]);
      const [newModelRoute, setNewModelRoute] = useState('');
      const [newModelProvider, setNewModelProvider] = useState('magpie');
      const [newModelEfforts, setNewModelEfforts] = useState('low,medium,high');

      // Archive filters & detail
      const [catFilter, setCatFilter] = useState('');
      const [stateFilter, setStateFilter] = useState('');
      const [archivePlans, setArchivePlans] = useState([]);
      const [selectedPlan, setSelectedPlan] = useState(null);
      const [retroNotes, setRetroNotes] = useState('');
      const [cleanPreview, setCleanPreview] = useState(null);
      const [cleanDays, setCleanDays] = useState('');

      const hydrateFromState = useCallback((snap) => {
        setData(snap);
        if (snap && snap.configSnapshot) {
          const rMap = {};
          ROLE_META.forEach(({ key }) => {
            const cur = snap.configSnapshot.roles && snap.configSnapshot.roles[key];
            if (cur) rMap[key] = { route: cur.route, effort: cur.effort };
          });
          setDraftRoles(rMap);
          setDraftPool(Array.isArray(snap.configSnapshot.executionPool) ? snap.configSnapshot.executionPool.slice() : []);
        }
        if (snap && snap.archive && Array.isArray(snap.archive.recentPlans)) {
          setArchivePlans(snap.archive.recentPlans);
        }
      }, []);

      const loadState = useCallback(async (opts) => {
        setLoading(true);
        setError(null);
        try {
          const snap = await postApi(ROUTES.STATE, opts || {});
          hydrateFromState(snap);
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      }, [hydrateFromState]);

      useEffect(() => {
        void loadState({});
      }, [loadState]);

      const onDiscoverUpstream = async (probeEndpoints) => {
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const res = await postApi(ROUTES.DISCOVER, { probeEndpoints: Boolean(probeEndpoints) });
          hydrateFromState(res.state);
          const count = (res.catalog && Array.isArray(res.catalog.models)) ? res.catalog.models.length : 0;
          setNotice('已同步 DSH 上游模型目录，共发现 ' + count + ' 个上游模型。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onSaveModelsAndRoles = async () => {
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const setRoles = ROLE_META.map(({ key }) => ({
            role: key,
            route: draftRoles[key] && draftRoles[key].route,
            effort: draftRoles[key] && draftRoles[key].effort,
          })).filter(x => x.route && x.effort);
          const res = await postApi(ROUTES.APPLY, {
            target: saveTarget,
            changes: {
              setRoles,
              poolSet: draftPool,
            },
          });
          hydrateFromState(res.state);
          setNotice('已保存：成员池下一次派发生效；治理角色与策略在新建团队／新会话生效。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onAddCustomModel = async () => {
        const route = newModelRoute.trim();
        if (!route) return;
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const efforts = newModelEfforts.split(',').map(s => s.trim()).filter(Boolean);
          const effList = efforts.length ? efforts : ['none'];
          const res = await postApi(ROUTES.APPLY, {
            target: saveTarget,
            changes: {
              upsertModels: [{
                route,
                provider: newModelProvider.trim() || 'magpie',
                efforts: effList,
                defaultEffort: effList[0],
                enableInPool: true,
              }],
            },
          });
          hydrateFromState(res.state);
          setNewModelRoute('');
          setNotice('已登记模型 ' + route + ' 并加入成员执行池。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onTogglePlugin = async (pluginKey, nextVal) => {
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
          const res = await postApi(ROUTES.APPLY, {
            target: saveTarget,
            changes: { setPlugins: { [pluginKey]: nextVal } },
          });
          hydrateFromState(res.state);
          setNotice('插件 ' + pluginKey + ' 已切换为 ' + (nextVal ? '启用' : '拆卸停用') + '。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onFilterArchive = async (nextCat, nextState) => {
        setCatFilter(nextCat);
        setStateFilter(nextState);
        try {
          const res = await postApi(ROUTES.ARCHIVE, {
            category: nextCat || undefined,
            lifecycleState: nextState || undefined,
            limit: 50,
          });
          setArchivePlans(res.plans || []);
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        }
      };

      const onSelectPlan = async (planId) => {
        try {
          const res = await postApi(ROUTES.ARCHIVE, { planId });
          setSelectedPlan(res.plan);
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        }
      };

      const onRunRetrospect = async (planId) => {
        setLoading(true);
        setError(null);
        try {
          const res = await postApi(ROUTES.RETROSPECT, { planId, notes: retroNotes });
          setSelectedPlan(res.plan);
          setNotice('已生成执行后复审记录 (' + res.retrospective.retroId + ')。');
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const onCleanArchive = async (confirmExecute) => {
        setLoading(true);
        setError(null);
        try {
          const daysNum = cleanDays.trim() !== '' ? Number(cleanDays) : undefined;
          const hasFilter = Boolean(catFilter || (typeof daysNum === 'number' && !Number.isNaN(daysNum)));
          const res = await postApi(ROUTES.CLEAN, {
            category: catFilter || undefined,
            olderThanDays: (typeof daysNum === 'number' && !Number.isNaN(daysNum)) ? daysNum : undefined,
            all: !hasFilter,
            dryRun: !confirmExecute,
            confirm: Boolean(confirmExecute),
          });
          setCleanPreview(res);
          if (confirmExecute) {
            setArchivePlans(res.recentPlans || []);
            setSelectedPlan(null);
            setNotice('已清理外部归档计划 ' + res.removedCount + ' 条。');
          }
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const models = (data && Array.isArray(data.unifiedModels)) ? data.unifiedModels : [];
      const cardStyle = {
        border: '1px solid rgba(128,128,128,0.25)',
        borderRadius: '8px',
        padding: compact ? '10px' : '14px',
        marginBottom: '12px',
        background: 'rgba(128,128,128,0.04)',
      };
      const btnStyle = (primary) => ({
        padding: '5px 10px',
        borderRadius: '6px',
        border: '1px solid rgba(128,128,128,0.35)',
        background: primary ? '#2563eb' : 'transparent',
        color: primary ? '#ffffff' : 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        marginRight: '6px',
      });
      const inputStyle = {
        padding: '4px 8px',
        borderRadius: '5px',
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
      };

      return h(
        'div',
        {
          style: {
            padding: compact ? '10px' : '18px 22px',
            height: '100%',
            overflowY: 'auto',
            fontSize: '13px',
            lineHeight: 1.5,
            boxSizing: 'border-box',
          },
        },
        // Header
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
          h('div', null,
            h('div', { style: { fontSize: compact ? '15px' : '18px', fontWeight: 700 } }, 'LeaderTeam 控制台'),
            h('div', { style: { fontSize: '11px', opacity: 0.7 } }, '上游动态模型 · 可拆卸插件 · 工程计时 · 外部计划归档与复审')
          ),
          h('div', null,
            h('button', { style: btnStyle(false), onClick: () => loadState({ forceDiscover: true }), disabled: loading }, loading ? '刷新中…' : '刷新状态'),
            h('button', { style: btnStyle(true), onClick: () => onDiscoverUpstream(true), disabled: loading }, '探测上游模型 (/v1/models)')
          )
        ),
        error ? h('div', { style: { padding: '8px 10px', borderRadius: '6px', background: 'rgba(220,38,38,0.15)', color: '#ef4444', marginBottom: '10px', fontSize: '12px' } }, '错误：' + error) : null,
        notice ? h('div', { style: { padding: '8px 10px', borderRadius: '6px', background: 'rgba(22,163,74,0.15)', color: '#22c55e', marginBottom: '10px', fontSize: '12px' } }, notice) : null,
        // Navigation Tabs
        h(
          'div',
          { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px', borderBottom: '1px solid rgba(128,128,128,0.2)', paddingBottom: '8px' } },
          [
            ['models', '模型与角色 (' + models.length + ')'],
            ['usage', '实际模型与用量'],
            ['plugins', '可拆卸插件'],
            ['timers', '工程计时器'],
            ['archive', '历史计划归档 (' + archivePlans.length + ')'],
          ].map(([id, label]) =>
            h('button', { key: id, style: btnStyle(tab === id), onClick: () => setTab(id) }, label)
          )
        ),

        // TAB 1: Models & Roles
        tab === 'models' ? h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' } },
              h('strong', null, '治理角色与领队模型（支持任意 DSH 上游 Provider 与非推理模型）'),
              h('label', { style: { fontSize: '12px' } },
                '写入目标：',
                h('select', { value: saveTarget, onChange: e => setSaveTarget(e.target.value), style: { ...inputStyle, marginLeft: '4px' } },
                  h('option', { value: 'local' }, '本机覆盖 (leaderteam.local.json)'),
                  h('option', { value: 'base' }, '基础配置 (leaderteam.config.json)')
                )
              )
            ),
            ROLE_META.map(({ key, label }) => {
              const cur = draftRoles[key] || { route: '', effort: '' };
              const selectedSpec = models.find(m => m.route === cur.route);
              const efforts = (selectedSpec && Array.isArray(selectedSpec.efforts) && selectedSpec.efforts.length)
                ? selectedSpec.efforts
                : [cur.effort || 'none'];
              return h(
                'div',
                { key, style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' } },
                h('span', { style: { minWidth: '140px', fontSize: '12px', fontWeight: 600 } }, label),
                h(
                  'select',
                  {
                    style: { ...inputStyle, flex: 1, minWidth: '180px' },
                    value: cur.route,
                    onChange: e => {
                      const nextRoute = e.target.value;
                      const sp = models.find(m => m.route === nextRoute);
                      const nextEff = sp ? (sp.defaultEffort || sp.efforts[0] || 'none') : 'none';
                      setDraftRoles(prev => ({ ...prev, [key]: { route: nextRoute, effort: nextEff } }));
                    },
                  },
                  models.map(m => h('option', { key: m.route, value: m.route }, m.route + ' [' + m.provider + ' · ' + m.family + ']'))
                ),
                h(
                  'select',
                  {
                    style: { ...inputStyle, width: '95px' },
                    value: cur.effort,
                    onChange: e => setDraftRoles(prev => ({ ...prev, [key]: { ...cur, effort: e.target.value } })),
                  },
                  efforts.map(ef => h('option', { key: ef, value: ef }, ef))
                )
              );
            }),
            h('div', { style: { marginTop: '10px' } },
              h('button', { style: btnStyle(true), onClick: onSaveModelsAndRoles, disabled: loading }, '保存角色与成员池')
            )
          ),
          h('div', { style: cardStyle },
            h('strong', null, '子代理执行模型池（勾选允许领队调度的上游模型）'),
            h('div', { style: { marginTop: '8px', maxHeight: '240px', overflowY: 'auto' } },
              models.map(m => {
                const checked = draftPool.includes(m.route);
                return h(
                  'label',
                  { key: m.route, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '12px', cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked,
                    onChange: e => {
                      const on = e.target.checked;
                      setDraftPool(prev => on ? (prev.includes(m.route) ? prev : prev.concat([m.route])) : prev.filter(x => x !== m.route));
                    },
                  }),
                  h('span', { style: { fontWeight: 600 } }, m.route),
                  h('span', { style: { opacity: 0.7 } }, '(' + m.provider + ' · 档位: ' + (m.efforts || []).join('/') + ' · ' + m.source + ')')
                );
              })
            )
          ),
          h('div', { style: cardStyle },
            h('strong', null, '手动登记新上游模型'),
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } },
              h('input', { style: { ...inputStyle, width: '110px' }, placeholder: 'provider (如 deepseek)', value: newModelProvider, onChange: e => setNewModelProvider(e.target.value) }),
              h('input', { style: { ...inputStyle, flex: 1, minWidth: '160px' }, placeholder: '路由 <prefix>/<model> (如 deepseek/deepseek-chat)', value: newModelRoute, onChange: e => setNewModelRoute(e.target.value) }),
              h('input', { style: { ...inputStyle, width: '140px' }, placeholder: '档位 (如 none 或 low,high)', value: newModelEfforts, onChange: e => setNewModelEfforts(e.target.value) }),
              h('button', { style: btnStyle(false), onClick: onAddCustomModel, disabled: loading }, '添加模型')
            )
          )
        ) : null,

        tab === 'usage' ? h('div',null,
          h('div',{style:cardStyle},
            h('strong',null,'团队实际调用与分项用量'),
            h('p',null,'治理快照是配置；实际模型取自调用回执。未调用的角色会明确标记。总计包含缓存，不重复计算流式事件；缺失记录不算作零费用。'),
            h('select',{style:inputStyle,value:teamId,onChange:e=>setTeamId(e.target.value)},
              h('option',{value:''},'最近团队'),
              (data.teams||[]).map(x=>h('option',{key:x.teamId,value:x.teamId},x.teamId)))
          ),
          (data.teams||[]).filter(x=>x.teamId === (teamId || data.teams?.[0]?.teamId)).map(team=>h('div',{key:team.teamId},
            team.error ? h('div',{style:cardStyle},'读取失败：'+team.error) : h('div',null,
              h('div',{style:cardStyle},
                h('div',null,'团队：'+team.teamId),
                h('div',{style:{fontSize:'11px',wordBreak:'break-all'}},'冻结治理 SHA256：'+(team.governanceSha256||'历史团队无快照')),
                h('table',{style:{width:'100%',fontSize:'12px'}},
                  h('thead',null,h('tr',null,['角色','配置模型／档位','实际调用','token'].map(x=>h('th',{key:x},x)))),
                  h('tbody',null,(team.roles||[]).map(r=>h('tr',{key:r.role},
                    h('td',null,r.role),h('td',null,r.configured.route+' / '+r.configured.effort),
                    h('td',null,r.called ? r.actualRoutes.join('、')+(r.degraded?'（降级）':'')+' · '+r.calls+'次' : r.requested ? '已发起请求，等待用量回执：'+r.requestRoutes.join('、') : '未调用'),
                    h('td',null,r.called ? r.tokens.totalTokens.toLocaleString()+(r.missingUsage?'（'+r.missingUsage+'次计量缺失）':'') : r.requested ? '待回执' : '—')))))
              ),
              h('div',{style:cardStyle},
                h('strong',null,'用量汇总'+(team.usage.complete?'':'（部分计量待回执或记录缺失）')),
                ['leader','governance','execution'].map((g,i)=>h('div',{key:g},
                  ['主代理','LeaderTeam 治理团队','执行子代理'][i]+'：'+team.usage.groups[g].tokens.totalTokens.toLocaleString()+' token'+(team.usage.groups[g].awaitingUsage?'（尚无用量回执）':'')+(team.usage.groups[g].missingUsage?'（'+team.usage.groups[g].missingUsage+'次计量缺失）':''))),
                h('div',{style:{fontWeight:700,marginTop:'8px'}},(team.usage.complete?'总计：':'已报合计：')+team.usage.total.totalTokens.toLocaleString()+' token'),
                h('div',null,'普通输入 '+team.usage.total.inputTokens.toLocaleString()+' · 缓存读取 '+team.usage.total.cacheReadTokens.toLocaleString()+' · 缓存写入 '+team.usage.total.cacheWriteTokens.toLocaleString()+' · 输出 '+team.usage.total.outputTokens.toLocaleString()),
                h('div',null,'实际费用：未提供'),
                (team.usage.members||[]).map(m=>h('div',{key:m.id,style:{marginTop:'6px'}},m.name+' · '+(m.actualModels.join('、')||'尚无调用回执')+' · '+m.tokens.totalTokens.toLocaleString()+' token'+(m.available?'':'（记录缺失）')))
              )
            )
          ))) : null,

        // TAB 2: Detachable Plugins
        tab === 'plugins' ? h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('strong', null, '可拆卸插件架构（治理开关在新团队生效；Cordis 插件可独立拆卸）'),
            h('div', { style: { fontSize: '12px', opacity: 0.75, marginTop: '4px', marginBottom: '10px' } },
              '核心安全门 (leaderteam-core) 始终保护工具执行；其余功能插件均可独立拆卸而不会拖垮普通会话或剩余功能。'
            ),
            PLUGIN_META.map(pm => {
              const active = Boolean(data && data.activePlugins && data.activePlugins[pm.key]);
              const cfgVal = !(data && data.configSnapshot && data.configSnapshot.plugins && data.configSnapshot.plugins[pm.key] === false);
              return h(
                'div',
                { key: pm.key, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid rgba(128,128,128,0.15)', gap: '8px' } },
                h('div', null,
                  h('div', { style: { fontWeight: 600, fontSize: '13px' } }, pm.label + (active ? ' [运行中]' : ' [已拆卸]')),
                  h('div', { style: { fontSize: '11px', opacity: 0.75 } }, pm.desc)
                ),
                h('button', { style: btnStyle(cfgVal), onClick: () => onTogglePlugin(pm.key, !cfgVal), disabled: loading }, cfgVal ? '已启用（点击拆卸）' : '已停用（点击启用）')
              );
            })
          )
        ) : null,

        // TAB 3: Engineering Timers
        tab === 'timers' ? h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('strong', null, '项目与任务工程计时器（评审团决策强制参考指标）'),
            (data && Array.isArray(data.timers) && data.timers.length > 0)
              ? data.timers.map(tm => h(
                'div',
                { key: tm.teamId, style: { padding: '8px 0', borderTop: '1px solid rgba(128,128,128,0.15)', marginTop: '8px', fontSize: '12px' } },
                h('div', { style: { fontWeight: 600 } },
                  '会话 ' + tm.teamId + ' · 时间压力: ' + tm.time_pressure.toUpperCase() + (tm.stagnation_fallback_eligible ? ' [已触发防停滞择优条件]' : '')
                ),
                h('div', { style: { opacity: 0.8 } }, '工作区: ' + (tm.workspace || '(未绑定)')),
                h('div', null,
                  '项目总跨度: ' + formatMs(tm.project_wall_ms) +
                  ' | 累计活跃: ' + formatMs(tm.project_active_ms) +
                  ' | 当前任务 (#' + tm.task_seq + '): ' + formatMs(tm.task_wall_ms) +
                  ' | 规划停滞: ' + formatMs(tm.planning_stagnation_ms) +
                  ' | 未通过规划轮次: ' + tm.unapproved_plan_attempts
                )
              ))
              : h('div', { style: { marginTop: '8px', opacity: 0.7, fontSize: '12px' } }, '暂无活跃团队计时记录。启动一次 LeaderTeam 会话后将自动持久化记录。')
          )
        ) : null,

        // TAB 4: Plan Archive, Retrospectives & Cleanup
        tab === 'archive' ? h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('div', { style: { fontWeight: 600 } }, '固定外部计划归档目录（严禁写入项目工作区内）'),
            h('div', { style: { fontSize: '11px', fontFamily: 'monospace', marginTop: '4px', wordBreak: 'break-all' } },
              (data && data.archive && data.archive.root) ? data.archive.root : '(归档未启用)'
            ),
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' } },
              h('select', { style: inputStyle, value: catFilter, onChange: e => onFilterArchive(e.target.value, stateFilter) },
                h('option', { value: '' }, '全部分类'),
                ((data && data.archive && data.archive.categories) || []).map(c => h('option', { key: c, value: c }, c))
              ),
              h('select', { style: inputStyle, value: stateFilter, onChange: e => onFilterArchive(catFilter, e.target.value) },
                h('option', { value: '' }, '全部状态'),
                ((data && data.archive && data.archive.lifecycleStates) || []).map(s => h('option', { key: s, value: s }, s))
              ),
              h('input', { style: { ...inputStyle, width: '110px' }, placeholder: '清理早于 N 天', value: cleanDays, onChange: e => setCleanDays(e.target.value) }),
              h('button', { style: btnStyle(false), onClick: () => onCleanArchive(false), disabled: loading }, '预览清理'),
              h('button', { style: btnStyle(false), onClick: () => onCleanArchive(true), disabled: loading }, '确认清理外部归档')
            ),
            cleanPreview ? h('div', { style: { marginTop: '8px', fontSize: '12px', opacity: 0.85 } },
              (cleanPreview.dryRun ? '[预览] 将匹配清理 ' + cleanPreview.matchedCount + ' 条计划。' : '已清理 ' + cleanPreview.removedCount + ' 条计划。')
            ) : null
          ),
          h('div', { style: cardStyle },
            h('strong', null, '归档计划列表（点击查看评审建议或生成执行后复审）'),
            archivePlans.length === 0
              ? h('div', { style: { marginTop: '8px', opacity: 0.7, fontSize: '12px' } }, '当前筛选条件下无归档计划。')
              : archivePlans.map(p => h(
                'div',
                {
                  key: p.planId,
                  onClick: () => onSelectPlan(p.planId),
                  style: { padding: '8px', borderTop: '1px solid rgba(128,128,128,0.15)', cursor: 'pointer', fontSize: '12px' },
                },
                h('div', { style: { fontWeight: 600 } }, '[' + p.category + '] ' + p.topic + ' (' + p.lifecycleState + ')'),
                h('div', { style: { opacity: 0.75, fontSize: '11px' } },
                  'ID: ' + p.planId + ' · 项目: ' + (p.projectLabel || p.projectKey) + ' · 复审数: ' + (p.retrospectiveCount || 0)
                )
              ))
          ),
          selectedPlan ? h('div', { style: cardStyle },
            h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, '计划详情与执行后复审：' + selectedPlan.topic),
            h('div', { style: { fontSize: '11px', opacity: 0.8, marginBottom: '6px' } },
              '分类: ' + selectedPlan.category + ' | 状态: ' + selectedPlan.lifecycleState + ' | 协议ID: ' + selectedPlan.agreementId
            ),
            selectedPlan.outcome ? h('div', { style: { marginBottom: '8px', fontSize: '12px' } },
              h('div', null, '评审结论: ' + selectedPlan.outcome.decision + ' (by ' + selectedPlan.outcome.by + ')'),
              (selectedPlan.outcome.reasons && selectedPlan.outcome.reasons.length > 0)
                ? h('div', null, '理由: ' + selectedPlan.outcome.reasons.join('；'))
                : null,
              (selectedPlan.outcome.suggestions && selectedPlan.outcome.suggestions.length > 0)
                ? h('div', null, '建议方案: ' + selectedPlan.outcome.suggestions.join('；'))
                : null
            ) : null,
            h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '180px', overflowY: 'auto', padding: '8px', background: 'rgba(128,128,128,0.08)', borderRadius: '6px', fontSize: '11px' } }, selectedPlan.proposal),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('input', { style: { ...inputStyle, flex: 1, minWidth: '180px' }, placeholder: '可选：补充复审备注（如某环节返工原因）', value: retroNotes, onChange: e => setRetroNotes(e.target.value) }),
              h('button', { style: btnStyle(true), onClick: () => onRunRetrospect(selectedPlan.planId), disabled: loading }, '生成执行后复审')
            ),
            (Array.isArray(selectedPlan.retrospectives) && selectedPlan.retrospectives.length > 0)
              ? selectedPlan.retrospectives.map(r => h(
                'div',
                { key: r.retroId, style: { marginTop: '8px', padding: '8px', borderRadius: '6px', background: 'rgba(37,99,235,0.08)', fontSize: '12px' } },
                h('div', { style: { fontWeight: 600 } }, '复审 ' + r.retroId + ' · 总结: ' + r.verdict),
                (r.findings || []).map((f, idx) => h('div', { key: idx }, '• [' + f.stage + '/' + f.severity + '] ' + f.detail))
              ))
              : null
          ) : null
        ) : null
      );
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots) return;
      ctx.effect(() => {
        const disposers = [];
        const own = d => { if (typeof d === 'function') disposers.push(d); };
        try {
          own(ctx.slots.inject('main', () => ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            props => h(ConsoleView, props)
          )));
          own(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => 'LeaderTeam' },
            props => h(PanelIcon, { size: props && typeof props.size === 'number' ? props.size : 18 })
          )));
        } catch {}
        return () => { for (const d of disposers) { try { d(); } catch {} } };
      }, 'leaderteam-panel: main page');

      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs'], injected => {
          const disposers = [];
          const own = d => { if (typeof d === 'function') disposers.push(d); };
          try {
            const tabs = injected.sidebarRightTabs;
            if (!tabs || typeof tabs.register !== 'function') return;
            own(tabs.register({
              id: PANEL_ID,
              kind: PANEL_ID,
              title: () => 'LeaderTeam',
              guide: [{
                id: PANEL_ID,
                order: PANEL_ORDER,
                title: () => 'LeaderTeam 控制台',
                description: () => '管理上游动态模型、可拆卸插件、工程计时与外部计划归档',
                icon: PanelIcon,
              }],
            }));
            own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
              { name: 'sidebar.right.pane.tab', key: PANEL_ID },
              props => h(ConsoleView, Object.assign({}, props, { host: 'sidebar' }))
            )));
            own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: PANEL_ID },
              TabTitle
            )));
          } catch {
            for (const d of disposers) { try { d(); } catch {} }
            return undefined;
          }
          return () => { for (const d of disposers) { try { d(); } catch {} } };
        });
      }
    }

    return {
      name: PANEL_ID,
      inject: ['slots'],
      apply,
      ConsoleView,
    };
  }

  const descriptor = { id: PANEL_ID, factory: createLeaderTeamPanelClient };
  if (typeof globalThis !== 'undefined') {
    globalThis.__LEADERTEAM_PANEL_CLIENT__ = descriptor;
  }
  if (typeof window !== 'undefined' && window && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({ id: 'dsh-leaderteam', factory: createLeaderTeamPanelClient });
    window.__ModuleLoader__.load({ id: 'dsh-leaderteam/client', factory: createLeaderTeamPanelClient });
    window.__ModuleLoader__.load(descriptor);
  }
})();
