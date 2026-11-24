/**
 * `settings.section` entry: the M0 settings skeleton (contract patch §2.5).
 *
 * Four groups — commander (binding card + model), workspaces (allowlist +
 * summaries + policy), dispatch & Jev, appearance. Every color comes from a
 * DSH theme alias token; saves go through the Host routes and report the
 * contract error code inline.
 */
import * as React from 'react'
import type { ReactNode } from 'react'
import type { BindingRequest, ConfigView, SessionOptionView, UiConfig, WorkspaceView, WriteResult } from './types'
import {
  describeBindingFailure, formatRelativeActivity, formatSessionCreatedAt, isUnnamedSession, sessionDisplayTitle,
  shortSessionId,
} from './session-display'
import type { CommanderStore, CommanderView } from './store'
import { defaultJevConfig } from './state'
import { STYLES } from './styles'

/** Face the plugin injects into the settings section entry. */
export interface SettingsInjected {
  store: CommanderStore
  t: (key: string) => string
  /** R1：打开某一任（含 retired）指挥官的 DSH 会话；宿主不提供时只展示不可点。 */
  openSession?: (sessionId: string) => void
}

/** Props received by the slot entry: only the inject face. */
export type CommanderSettingsProps = SettingsInjected

/** Local draft of one workspace row (mirrors `WorkspaceView` but fully editable). */
interface WorkspaceDraft {
  id: string
  name: string
  path: string
  allowed: boolean
  summary: string
  policy: 'inherit' | 'auto'
}

interface CommanderForm {
  provider: string
  model: string
  reasoningEffort: string
  agentPreset: string
  workspaceId: string
}

interface JevForm {
  endpoint: string
  model: string
  apiKeyEnv: string
  workspaceThreshold: number
  sessionThreshold: number
  timeoutMs: number
  autoDispatch: boolean
}

interface UiForm {
  theme: 'follow' | 'light' | 'dark'
  entryEnabled: boolean
  nativeShell: boolean
}

/** R1：轮换草稿（generation/generationStartedAt 由 Host 管理，不在这里编辑）。 */
interface RotationForm {
  enabled: boolean
  periodDays: number
  includeUserTail: boolean
}

interface GroupResult {
  kind: 'ok' | 'error'
  text: string
}

/** Local result of one `POST /commander/jev/test` probe (key never displayed). */
interface JevTestState {
  kind: 'ok' | 'error'
  latencyMs?: number
  model?: string
  code?: string
  message?: string
}

const EMPTY_COMMANDER: CommanderForm = { provider: '', model: '', reasoningEffort: '', agentPreset: '', workspaceId: '' }

/** Render the commander settings page skeleton. */
export function CommanderSettingsSection({ store, t, openSession }: CommanderSettingsProps): ReactNode {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const defaults = React.useMemo(() => defaultJevConfig(), [])

  const [commanderForm, setCommanderForm] = React.useState<CommanderForm>(EMPTY_COMMANDER)
  const [jevForm, setJevForm] = React.useState<JevForm>({
    endpoint: defaults.endpoint,
    model: defaults.model,
    apiKeyEnv: defaults.apiKeyEnv,
    workspaceThreshold: defaults.workspaceThreshold,
    sessionThreshold: defaults.sessionThreshold,
    timeoutMs: defaults.timeoutMs,
    autoDispatch: defaults.autoDispatch,
  })
  const [uiForm, setUiForm] = React.useState<UiForm>({ theme: 'follow', entryEnabled: true, nativeShell: true })
  const [rotationForm, setRotationForm] = React.useState<RotationForm>({ enabled: false, periodDays: 1, includeUserTail: true })
  const [workspaces, setWorkspaces] = React.useState<WorkspaceDraft[]>([])
  const [savingGroup, setSavingGroup] = React.useState('')
  const [results, setResults] = React.useState<Record<string, GroupResult>>({})
  const [testingJev, setTestingJev] = React.useState(false)
  const [testResult, setTestResult] = React.useState<JevTestState | null>(null)
  const [selectOpen, setSelectOpen] = React.useState(false)
  const [selectPhase, setSelectPhase] = React.useState<'idle' | 'loading' | 'ready' | 'error' | 'missing'>('idle')
  const [selectRows, setSelectRows] = React.useState<SessionOptionView[]>([])
  const [selectedSessionId, setSelectedSessionId] = React.useState('')
  const [selectError, setSelectError] = React.useState('')
  const [selectTruncated, setSelectTruncated] = React.useState(false)

  const configApplied = React.useRef(false)
  const bindingApplied = React.useRef<string | undefined>(undefined)
  const workspacesDirty = React.useRef(false)

  // Read the current config once (M0 may not expose GET /commander/config; the
  // store reports configLoaded either way and the form keeps its defaults).
  React.useEffect(() => {
    void store.loadConfig()
  }, [store])

  React.useEffect(() => {
    if (!state.configLoaded || configApplied.current) return
    configApplied.current = true
    const config = state.config
    setJevForm(current => ({
      endpoint: config?.jev?.endpoint ?? current.endpoint,
      model: config?.jev?.model ?? current.model,
      apiKeyEnv: config?.jev?.apiKeyEnv ?? current.apiKeyEnv,
      workspaceThreshold: typeof config?.jev?.workspaceThreshold === 'number' ? config.jev.workspaceThreshold : current.workspaceThreshold,
      sessionThreshold: typeof config?.jev?.sessionThreshold === 'number' ? config.jev.sessionThreshold : current.sessionThreshold,
      timeoutMs: typeof config?.jev?.timeoutMs === 'number' ? config.jev.timeoutMs : current.timeoutMs,
      autoDispatch: config?.jev?.autoDispatch === true,
    }))
    setUiForm(current => ({
      theme: mergeTheme(config?.ui, current.theme),
      entryEnabled: config?.ui?.entryEnabled !== false,
      nativeShell: config?.ui?.nativeShell !== false,
    }))
    setRotationForm({
      enabled: config?.commander?.rotation?.enabled === true,
      periodDays: clampRotationDays(config?.commander?.rotation?.periodDays),
      includeUserTail: config?.commander?.rotation?.includeUserTail !== false,
    })
    setCommanderForm(current => ({
      provider: config?.commander?.model?.provider ?? current.provider,
      model: config?.commander?.model?.model ?? current.model,
      reasoningEffort: config?.commander?.model?.reasoningEffort ?? current.reasoningEffort,
      agentPreset: config?.commander?.agentPreset ?? current.agentPreset,
      workspaceId: current.workspaceId,
    }))
  }, [state.configLoaded, state.config])

  React.useEffect(() => {
    const sessionId = state.binding?.sessionId
    if (sessionId === undefined || sessionId === '' || bindingApplied.current === sessionId) return
    bindingApplied.current = sessionId
    const model = state.binding?.model
    setCommanderForm(current => ({
      ...current,
      provider: model?.provider ?? current.provider,
      model: model?.model ?? current.model,
      reasoningEffort: model?.reasoningEffort ?? current.reasoningEffort,
      agentPreset: state.binding?.agentPreset ?? current.agentPreset,
      workspaceId: state.binding?.workspaceId ?? current.workspaceId,
    }))
  }, [state.binding?.sessionId, state.binding?.model, state.binding?.agentPreset, state.binding?.workspaceId])

  React.useEffect(() => {
    if (workspacesDirty.current) return
    setWorkspaces(state.workspaces.map(toDraft))
  }, [state.workspaces])

  const status = state.commanderStatus
  // R1：旧 store fake / 旧快照可能没有这两项，渲染时按空处理（不崩设置页）。
  const rotation = state.rotation ?? null
  const formerCommanders = state.formerCommanders ?? []

  const runSave = async <T,>(group: string, action: () => Promise<WriteResult<T>>): Promise<void> => {
    setSavingGroup(group)
    try {
      const result = await action()
      setResults(current => ({
        ...current,
        [group]: result.ok
          ? { kind: 'ok', text: t('settings.save.ok') }
          : { kind: 'error', text: `${t('settings.save.failed')}：${result.failure.code} · ${result.failure.message}` },
      }))
    } finally {
      setSavingGroup('')
    }
  }

  const saveCommanderModel = (): void => {
    if (commanderForm.provider.trim() === '' || commanderForm.model.trim() === '') {
      setResults(current => ({ ...current, commander: { kind: 'error', text: 'Provider 与模型不能为空' } }))
      return
    }
    void runSave('commander', () => store.saveConfig({
      commander: {
        model: {
          provider: commanderForm.provider.trim(),
          model: commanderForm.model.trim(),
          ...(commanderForm.reasoningEffort.trim() === '' ? {} : { reasoningEffort: commanderForm.reasoningEffort.trim() }),
        },
        ...(commanderForm.agentPreset.trim() === '' ? {} : { agentPreset: commanderForm.agentPreset.trim() }),
      },
    }))
  }

  /** Load `GET /commander/sessions?workspaceId=` for the binding picker. */
  const loadBindingSessions = (workspaceId: string): void => {
    if (workspaceId === '') {
      setSelectPhase('idle')
      setSelectRows([])
      setSelectedSessionId('')
      return
    }
    setSelectPhase('loading')
    setSelectRows([])
    setSelectError('')
    setSelectTruncated(false)
    setSelectedSessionId('')
    void store.listSessions(workspaceId).then(result => {
      if (result.ok) {
        setSelectRows(result.data.sessions)
        setSelectTruncated(result.data.truncated === true)
        setSelectPhase('ready')
        return
      }
      if (result.failure.code === 'not_found' || result.failure.code === 'route_missing') {
        setSelectPhase('missing')
        return
      }
      setSelectPhase('error')
      setSelectError(result.failure.message)
    })
  }

  const toggleSelectPicker = (): void => {
    const next = !selectOpen
    setSelectOpen(next)
    if (next) loadBindingSessions(commanderForm.workspaceId)
    else { setSelectedSessionId(''); setSelectPhase('idle') }
  }

  /** Send one binding request and report a readable, code-preserving failure. */
  const submitBinding = (request: BindingRequest, resultKey: 'binding' | 'selectBinding'): void => {
    const group = resultKey === 'binding' ? 'binding' : 'bindingSelect'
    setSavingGroup(group)
    void store.bind(request).then(result => {
      setSavingGroup('')
      setResults(current => ({
        ...current,
        [resultKey]: result.ok
          ? { kind: 'ok', text: t('settings.save.ok') }
          : { kind: 'error', text: describeBindingFailure(result.failure, t) },
      }))
      if (!result.ok) return
      if (resultKey === 'selectBinding') {
        setSelectOpen(false)
        setSelectRows([])
        setSelectedSessionId('')
        setSelectPhase('idle')
        setSelectTruncated(false)
      }
    })
  }

  const bindSelectedSession = (): void => {
    const workspaceId = commanderForm.workspaceId
    if (workspaceId === '' || selectedSessionId === '') return
    submitBinding({ mode: 'select', workspaceId, sessionId: selectedSessionId }, 'selectBinding')
  }

  const bindNewSession = (): void => {
    if (commanderForm.workspaceId === '') {
      setResults(current => ({ ...current, binding: { kind: 'error', text: t('settings.needWorkspace') } }))
      return
    }
    submitBinding({
      mode: 'new',
      workspaceId: commanderForm.workspaceId,
      ...(commanderForm.agentPreset.trim() === '' ? {} : { agentPreset: commanderForm.agentPreset.trim() }),
    }, 'binding')
  }

  const saveWorkspaces = (): void => {
    workspacesDirty.current = false
    void runSave('workspaces', () => store.saveWorkspaces(workspaces.map(row => ({
      id: row.id,
      allowed: row.allowed,
      summary: row.summary,
      policy: row.policy,
    }))))
  }

  const saveJev = (): void => {
    void runSave('jev', () => store.saveConfig({
      jev: {
        endpoint: jevForm.endpoint.trim(),
        model: jevForm.model.trim(),
        apiKeyEnv: jevForm.apiKeyEnv.trim(),
        workspaceThreshold: jevForm.workspaceThreshold,
        sessionThreshold: jevForm.sessionThreshold,
        timeoutMs: Math.round(jevForm.timeoutMs),
        autoDispatch: jevForm.autoDispatch,
      },
    }))
  }

  const testJevConnection = (): void => {
    setTestingJev(true)
    setTestResult(null)
    void store.testJev({
      endpoint: jevForm.endpoint.trim(),
      model: jevForm.model.trim(),
      apiKeyEnv: jevForm.apiKeyEnv.trim(),
      timeoutMs: Math.round(jevForm.timeoutMs),
    }).then(result => {
      setTestingJev(false)
      if (result.ok) {
        const data = result.data
        if (data.ok === false) {
          setTestResult({
            kind: 'error',
            ...(typeof data.latencyMs === 'number' ? { latencyMs: data.latencyMs } : {}),
            ...(data.error?.code === undefined ? {} : { code: data.error.code }),
            ...(data.error?.message === undefined ? {} : { message: data.error.message }),
            ...(data.message === undefined ? {} : { message: data.message }),
          })
          return
        }
        setTestResult({
          kind: 'ok',
          ...(typeof data.latencyMs === 'number' ? { latencyMs: data.latencyMs } : {}),
          ...(data.model === undefined ? {} : { model: data.model }),
        })
        return
      }
      setTestResult({
        kind: 'error',
        code: result.failure.code,
        message: result.failure.message,
      })
    })
  }

  const saveRotation = (): void => {
    void runSave('rotation', () => store.saveConfig({
      commander: {
        rotation: {
          enabled: rotationForm.enabled,
          periodDays: rotationForm.periodDays,
          includeUserTail: rotationForm.includeUserTail,
        },
      },
    }))
  }

  const rotateNow = (): void => {
    setSavingGroup('rotation')
    void store.rotateCommander(true)
      .then((result) => {
        setResults(current => ({
          ...current,
          rotation: result.ok
            ? { kind: 'ok', text: t('settings.rotation.rotated') }
            : { kind: 'error', text: `${t('settings.save.failed')}：${result.failure.code} · ${result.failure.message}` },
        }))
      })
      .finally(() => { setSavingGroup('') })
  }

  const saveUi = (): void => {
    void runSave('ui', () => store.saveConfig({
      ui: { theme: uiForm.theme, entryEnabled: uiForm.entryEnabled, nativeShell: uiForm.nativeShell },
    }))
  }

  const updateWorkspace = (id: string, patch: Partial<WorkspaceDraft>): void => {
    workspacesDirty.current = true
    setWorkspaces(current => current.map(row => (row.id === id ? { ...row, ...patch } : row)))
  }

  return (
    <div className="dshc-settings dshc-root">
      <style>{STYLES}</style>
      <div className="dshc-settings-intro">{t('settings.intro')}</div>

      {/* ---------------------------------------------------- commander */}
      <Card title={t('settings.group.commander')}>
        <div className="dshc-card-desc">{t('settings.binding.title')}</div>
        <div className="dshc-kv">
          <span>{t('settings.binding.status')}</span>
          <span className="dshc-kv-value" data-muted={status !== 'bound' ? 'true' : undefined}>{t(`status.${status}`)}</span>
          <span>{t('settings.binding.workspace')}</span>
          <span className="dshc-kv-value" data-muted={bindingWorkspace(state) === '' ? 'true' : undefined}>
            {bindingWorkspace(state) === '' ? t('settings.binding.none') : bindingWorkspace(state)}
          </span>
          <span>{t('settings.binding.session')}</span>
          <span className="dshc-kv-value" data-muted={state.binding?.sessionId === undefined ? 'true' : undefined}>
            {state.binding?.sessionId === undefined || state.binding.sessionId === '' ? t('settings.binding.none') : state.binding.sessionId}
          </span>
          <span>{t('settings.binding.model')}</span>
          <span className="dshc-kv-value" data-muted={state.binding?.model?.model === undefined ? 'true' : undefined}>
            {bindingModel(state)}
          </span>
        </div>
        <div className="dshc-grid">
          <label className="dshc-field" data-span="2">
            <span>{t('settings.binding.workspaceSelect')}</span>
            <select
              className="dshc-field-select"
              value={commanderForm.workspaceId}
              onChange={event => {
                setCommanderForm(current => ({ ...current, workspaceId: event.target.value }))
                if (selectOpen) loadBindingSessions(event.target.value)
              }}
            >
              <option value="">{t('settings.binding.workspaceSelect')}</option>
              {state.workspaces.map(row => <option key={row.id} value={row.id}>{row.name ?? row.id}</option>)}
            </select>
          </label>
        </div>
        {state.workspaces.length === 0 ? <div className="dshc-card-desc">{t('settings.binding.unavailable')}</div> : null}
        <div className="dshc-row-actions">
          <button
            type="button"
            className="dshc-button"
            data-variant="secondary"
            disabled={savingGroup !== ''}
            title={t('settings.binding.select')}
            aria-expanded={selectOpen}
            onClick={toggleSelectPicker}
          >
            {t('settings.binding.select')}
          </button>
          <button
            type="button"
            className="dshc-button"
            data-variant="primary"
            disabled={savingGroup !== ''}
            onClick={bindNewSession}
          >
            {savingGroup === 'binding' ? t('settings.save.saving') : t('settings.binding.new')}
          </button>
        </div>
        <ResultLine result={results.binding} />

        {selectOpen ? (
          <div className="dshc-binding-picker">
            <div className="dshc-card-desc">{t('settings.binding.selectTitle')}</div>
            {commanderForm.workspaceId === '' ? (
              <div className="dshc-session-state">{t('settings.binding.selectNeedWorkspace')}</div>
            ) : null}
            {selectPhase === 'loading' ? <div className="dshc-session-state">{t('settings.binding.selectLoading')}</div> : null}
            {selectPhase === 'missing' ? (
              <div className="dshc-session-state" data-tone="warn">{t('settings.binding.selectUnavailable')}</div>
            ) : null}
            {selectPhase === 'error' ? (
              <div className="dshc-session-state" data-tone="error">
                {`${t('settings.binding.selectError')}：${selectError}`}
                <button type="button" className="dshc-msg-toggle" onClick={() => { loadBindingSessions(commanderForm.workspaceId) }}>
                  {t('settings.binding.selectRetry')}
                </button>
              </div>
            ) : null}
            {selectPhase === 'ready' && selectRows.length === 0 ? (
              <div className="dshc-session-state">{t('settings.binding.selectEmpty')}</div>
            ) : null}
            {selectPhase === 'ready' && selectRows.length > 0 ? (
              <div className="dshc-session-list" role="listbox" aria-label={t('settings.binding.selectTitle')}>
                {selectRows.map(row => {
                  const isBound = state.binding?.sessionId === row.sessionId
                  return (
                    <button
                      key={row.sessionId}
                      type="button"
                      className="dshc-session-row"
                      role="option"
                      aria-selected={selectedSessionId === row.sessionId}
                      data-selected={selectedSessionId === row.sessionId ? 'true' : 'false'}
                      data-bound={isBound ? 'true' : 'false'}
                      disabled={savingGroup !== ''}
                      onClick={() => { setSelectedSessionId(row.sessionId) }}
                    >
                      <span
                        className="dshc-session-title"
                        data-unnamed={isUnnamedSession(row.title) ? 'true' : 'false'}
                        title={isUnnamedSession(row.title) ? row.sessionId : row.title}
                      >
                        <span className="dshc-session-name">{sessionDisplayTitle(row.title, t)}</span>
                        <span className="dshc-session-shortid">{shortSessionId(row.sessionId)}</span>
                      </span>
                      <span className="dshc-session-meta">
                        {(() => {
                          const activity = formatRelativeActivity(row.lastActiveAt, Date.now(), t)
                          return activity === '' ? t('settings.binding.unknownTime') : activity
                        })()}
                        {row.contextPct === undefined ? '' : ` · ${t('dispatch.custom.session.context')} ${String(row.contextPct)}%`}
                        {formatSessionCreatedAt(row.createdAt) === ''
                          ? ''
                          : ` · ${t('settings.binding.createdAt')} ${formatSessionCreatedAt(row.createdAt)}`}
                        {isBound ? ` · ${t('settings.binding.selectBound')}` : ''}
                      </span>
                    </button>
                  )
                })}
                {selectTruncated ? (
                  <span className="dshc-session-state" data-tone="muted">{t('sessions.truncatedLimit20')}</span>
                ) : null}
              </div>
            ) : null}
            <div className="dshc-row-actions">
              <button type="button" className="dshc-button" data-variant="ghost" disabled={savingGroup === 'bindingSelect'} onClick={() => { setSelectOpen(false); setSelectedSessionId('') }}>
                {t('settings.binding.selectCancel')}
              </button>
              <button
                type="button"
                className="dshc-button"
                data-variant="primary"
                disabled={savingGroup !== '' || selectPhase !== 'ready' || selectedSessionId === ''}
                onClick={bindSelectedSession}
              >
                {savingGroup === 'bindingSelect' ? t('settings.binding.selectSaving') : t('settings.binding.selectConfirm')}
              </button>
            </div>
          </div>
        ) : null}
        <ResultLine result={results.selectBinding} />

        <div className="dshc-divider" />
        <div className="dshc-grid">
          <label className="dshc-field">
            <span>{t('settings.model.provider')}</span>
            <input
              className="dshc-field-input"
              value={commanderForm.provider}
              placeholder="tokfans"
              onChange={event => { setCommanderForm(current => ({ ...current, provider: event.target.value })) }}
            />
          </label>
          <label className="dshc-field">
            <span>{t('settings.model.model')}</span>
            <input
              className="dshc-field-input"
              value={commanderForm.model}
              placeholder="deepseek-flash"
              onChange={event => { setCommanderForm(current => ({ ...current, model: event.target.value })) }}
            />
          </label>
          <label className="dshc-field">
            <span>{t('settings.model.effort')}</span>
            <input
              className="dshc-field-input"
              value={commanderForm.reasoningEffort}
              placeholder="high"
              onChange={event => { setCommanderForm(current => ({ ...current, reasoningEffort: event.target.value })) }}
            />
          </label>
          <label className="dshc-field">
            <span>{t('settings.model.preset')}</span>
            <input
              className="dshc-field-input"
              value={commanderForm.agentPreset}
              placeholder="standard"
              onChange={event => { setCommanderForm(current => ({ ...current, agentPreset: event.target.value })) }}
            />
          </label>
        </div>
        <div className="dshc-row-actions">
          <button
            type="button"
            className="dshc-button"
            data-variant="secondary"
            disabled={savingGroup !== ''}
            onClick={saveCommanderModel}
          >
            {savingGroup === 'commander' ? t('settings.save.saving') : t('settings.save.button')}
          </button>
        </div>
        <ResultLine result={results.commander} />
      </Card>

      {/* ---------------------------------------------------- rotation (R1) */}
      <Card title={t('settings.group.rotation')}>
        <div className="dshc-card-desc">{t('settings.rotation.desc')}</div>
        <div className="dshc-switch-row">
          <input
            type="checkbox"
            className="dshc-check"
            checked={rotationForm.enabled}
            aria-label={t('settings.rotation.enabled')}
            onChange={event => { setRotationForm(current => ({ ...current, enabled: event.target.checked })) }}
          />
          <span>{t('settings.rotation.enabled')}</span>
        </div>
        <div className="dshc-grid">
          <label className="dshc-field">
            <span>{t('settings.rotation.period')}</span>
            <select
              className="dshc-field-select"
              value={String(rotationForm.periodDays)}
              disabled={!rotationForm.enabled}
              onChange={event => { setRotationForm(current => ({ ...current, periodDays: clampRotationDays(Number(event.target.value)) })) }}
            >
              {[1, 2, 3, 4, 5, 6, 7].map(day => (
                <option key={day} value={String(day)}>{`${day} ${t('settings.rotation.daysUnit')}`}</option>
              ))}
            </select>
          </label>
          <div className="dshc-field">
            <span>{t('settings.rotation.userTail')}</span>
            <div className="dshc-switch-row">
              <input
                type="checkbox"
                className="dshc-check"
                checked={rotationForm.includeUserTail}
                aria-label={t('settings.rotation.userTail')}
                disabled={!rotationForm.enabled}
                onChange={event => { setRotationForm(current => ({ ...current, includeUserTail: event.target.checked })) }}
              />
              <span className="dshc-field-hint">{t('settings.rotation.userTailHint')}</span>
            </div>
          </div>
        </div>
        {rotation === null ? null : (
          <div className="dshc-kv">
            <span>{t('settings.rotation.current')}</span>
            <span className="dshc-kv-value">{t('settings.rotation.generation').replace('{n}', String(rotation.generation))}</span>
            <span>{t('settings.rotation.nextDue')}</span>
            <span className="dshc-kv-value" data-muted={rotation.due ? undefined : 'true'}>
              {rotation.enabled
                ? (rotation.due
                    ? `${formatRotationDue(rotation.dueAt)} · ${t('settings.rotation.pending')}`
                    : formatRotationDue(rotation.dueAt))
                : t('settings.rotation.off')}
            </span>
            {rotation.lastError === undefined ? null : (
              <>
                <span>{t('settings.rotation.lastError')}</span>
                <span className="dshc-kv-value" data-muted="true">{`${rotation.lastError.code} · ${rotation.lastError.message}`}</span>
              </>
            )}
          </div>
        )}
        {formerCommanders.length === 0 ? null : (
          <div className="dshc-kv">
            <span>{t('settings.rotation.former')}</span>
            <span className="dshc-kv-value">
              {formerCommanders.map(item => (
                <button
                  key={item.sessionId}
                  type="button"
                  className="dshc-msg-toggle"
                  disabled={openSession === undefined}
                  onClick={() => { openSession?.(item.sessionId) }}
                >
                  {t('settings.rotation.formerItem')
                    .replace('{n}', String(item.generation))
                    .replace('{id}', shortSessionId(item.sessionId))}
                </button>
              ))}
            </span>
          </div>
        )}
        <div className="dshc-row-actions">
          <button
            type="button"
            className="dshc-button"
            data-variant="secondary"
            disabled={savingGroup !== ''}
            onClick={saveRotation}
          >
            {savingGroup === 'rotation' ? t('settings.save.saving') : t('settings.save.button')}
          </button>
          <button
            type="button"
            className="dshc-button"
            disabled={savingGroup !== '' || !rotationForm.enabled}
            onClick={rotateNow}
          >
            {t('settings.rotation.rotateNow')}
          </button>
        </div>
        <ResultLine result={results.rotation} />
      </Card>

      {/* --------------------------------------------------- workspaces */}
      <Card title={t('settings.group.workspace')}>
        {workspaces.length === 0 ? <div className="dshc-card-desc">{t('settings.workspace.empty')}</div> : null}
        {workspaces.map(row => (
          <div className="dshc-ws-row" key={row.id}>
            <input
              type="checkbox"
              className="dshc-check"
              checked={row.allowed}
              aria-label={`${t('settings.workspace.allowed')} ${row.name}`}
              onChange={event => { updateWorkspace(row.id, { allowed: event.target.checked }) }}
            />
            <div className="dshc-ws-body">
              <div className="dshc-ws-head">
                <span className="dshc-ws-name">{row.name}</span>
                {row.path !== '' ? <span className="dshc-ws-path">{row.path}</span> : null}
              </div>
              <label className="dshc-field">
                <span>{t('settings.workspace.summary')}</span>
                <textarea
                  className="dshc-field-textarea"
                  value={row.summary}
                  placeholder={t('settings.workspace.summaryPlaceholder')}
                  maxLength={500}
                  onChange={event => { updateWorkspace(row.id, { summary: event.target.value }) }}
                />
              </label>
              <label className="dshc-field">
                <span>{t('settings.workspace.policy')}</span>
                <select
                  className="dshc-field-select"
                  value={row.policy}
                  onChange={event => { updateWorkspace(row.id, { policy: event.target.value === 'auto' ? 'auto' : 'inherit' }) }}
                >
                  <option value="inherit">{t('settings.workspace.inherit')}</option>
                  <option value="auto">{t('settings.workspace.auto')}</option>
                </select>
              </label>
            </div>
          </div>
        ))}
        <div className="dshc-row-actions">
          <button
            type="button"
            className="dshc-button"
            data-variant="secondary"
            disabled={savingGroup !== '' || workspaces.length === 0}
            onClick={saveWorkspaces}
          >
            {savingGroup === 'workspaces' ? t('settings.save.saving') : t('settings.workspace.save')}
          </button>
        </div>
        <ResultLine result={results.workspaces} />
      </Card>

      {/* ---------------------------------------------------------- jev */}
      <Card title={t('settings.group.jev')}>
        <div className="dshc-note">{t('settings.jev.note')}</div>
        <div className="dshc-switch-row">
          <button
            type="button"
            className="dshc-switch"
            role="switch"
            aria-checked={jevForm.autoDispatch}
            title={t('jev.autoDispatch.note')}
            onClick={() => { setJevForm(current => ({ ...current, autoDispatch: !current.autoDispatch })) }}
          >
            <span className="dshc-switch-knob" />
          </button>
          <span>{t('jev.autoDispatch')}</span>
          <span className="dshc-dispatch-meta">{jevForm.autoDispatch ? t('jev.autoDispatch.auto') : t('jev.autoDispatch.confirm')}</span>
          <span className="dshc-field-hint">{t('jev.autoDispatch.note')}</span>
        </div>
        <div className="dshc-grid">
          <label className="dshc-field" data-span="2">
            <span>{t('settings.jev.endpoint')}</span>
            <input
              className="dshc-field-input"
              value={jevForm.endpoint}
              placeholder="https://api.typesafe.ai/v1/systemone"
              onChange={event => { setJevForm(current => ({ ...current, endpoint: event.target.value })) }}
            />
          </label>
          <label className="dshc-field">
            <span>{t('settings.jev.model')}</span>
            <input
              className="dshc-field-input"
              value={jevForm.model}
              placeholder="jev-latest"
              onChange={event => { setJevForm(current => ({ ...current, model: event.target.value })) }}
            />
          </label>
          <label className="dshc-field">
            <span>{t('settings.jev.apiKeyEnv')}</span>
            <input
              className="dshc-field-input"
              value={jevForm.apiKeyEnv}
              placeholder="JEV_API_KEY"
              onChange={event => { setJevForm(current => ({ ...current, apiKeyEnv: event.target.value })) }}
            />
          </label>
          <label className="dshc-field">
            <span>{t('settings.jev.workspaceThreshold')}</span>
            <div className="dshc-field-range-row">
              <input
                type="range"
                className="dshc-field-range"
                min={0.5}
                max={0.99}
                step={0.01}
                value={jevForm.workspaceThreshold}
                onChange={event => { setJevForm(current => ({ ...current, workspaceThreshold: Number(event.target.value) })) }}
              />
              <span className="dshc-field-range-value">{jevForm.workspaceThreshold.toFixed(2)}</span>
            </div>
            <span className="dshc-field-hint">{t('jev.workspaceThresholdHint')}</span>
          </label>
          <label className="dshc-field">
            <span>{t('settings.jev.sessionThreshold')}</span>
            <div className="dshc-field-range-row">
              <input
                type="range"
                className="dshc-field-range"
                min={0.5}
                max={0.99}
                step={0.01}
                value={jevForm.sessionThreshold}
                onChange={event => { setJevForm(current => ({ ...current, sessionThreshold: Number(event.target.value) })) }}
              />
              <span className="dshc-field-range-value">{jevForm.sessionThreshold.toFixed(2)}</span>
            </div>
            <span className="dshc-field-hint">{t('jev.sessionThresholdHint')}</span>
          </label>
          <label className="dshc-field">
            <span>{t('settings.jev.timeout')}</span>
            <input
              type="number"
              className="dshc-field-input"
              min={500}
              max={30000}
              step={100}
              value={jevForm.timeoutMs}
              onChange={event => { setJevForm(current => ({ ...current, timeoutMs: Number(event.target.value) })) }}
            />
          </label>
        </div>
        {testResult === null ? null : <TestResultLine result={testResult} t={t} />}
        <div className="dshc-row-actions">
          <button
            type="button"
            className="dshc-button"
            data-variant="secondary"
            disabled={savingGroup !== '' || testingJev}
            onClick={testJevConnection}
          >
            {testingJev ? t('jev.testing') : t('jev.test')}
          </button>
          <button
            type="button"
            className="dshc-button"
            data-variant="secondary"
            disabled={savingGroup !== ''}
            onClick={saveJev}
          >
            {savingGroup === 'jev' ? t('settings.save.saving') : t('settings.jev.save')}
          </button>
        </div>
        <ResultLine result={results.jev} />
      </Card>

      {/* --------------------------------------------------- appearance */}
      <Card title={t('settings.group.appearance')}>
        {state.configLoaded && state.config === null ? <div className="dshc-card-desc">{t('settings.configUnavailable')}</div> : null}
        <div className="dshc-grid">
          <label className="dshc-field">
            <span>{t('settings.appearance.theme')}</span>
            <select
              className="dshc-field-select"
              value={uiForm.theme}
              onChange={event => { setUiForm(current => ({ ...current, theme: event.target.value === 'light' ? 'light' : event.target.value === 'dark' ? 'dark' : 'follow' })) }}
            >
              <option value="follow">{t('settings.appearance.theme.follow')}</option>
              <option value="light">{t('settings.appearance.theme.light')}</option>
              <option value="dark">{t('settings.appearance.theme.dark')}</option>
            </select>
          </label>
          <div className="dshc-field">
            <span>{t('settings.appearance.entry')}</span>
            <div className="dshc-switch-row">
              <input
                type="checkbox"
                className="dshc-check"
                checked={uiForm.entryEnabled}
                aria-label={t('settings.appearance.entry')}
                onChange={event => { setUiForm(current => ({ ...current, entryEnabled: event.target.checked })) }}
              />
              <span>{t('settings.appearance.entryEnabled')}</span>
            </div>
            <div className="dshc-card-desc">{t('settings.appearance.entryHint')}</div>
          </div>
          <div className="dshc-field">
            <span>{t('settings.appearance.nativeShell')}</span>
            <div className="dshc-switch-row">
              <input
                type="checkbox"
                className="dshc-check"
                checked={uiForm.nativeShell}
                aria-label={t('settings.appearance.nativeShell')}
                onChange={event => { setUiForm(current => ({ ...current, nativeShell: event.target.checked })) }}
              />
              <span>{t('settings.appearance.nativeShellEnabled')}</span>
            </div>
            <div className="dshc-card-desc">{t('settings.appearance.nativeShellHint')}</div>
          </div>
        </div>
        <div className="dshc-card-desc">{t('settings.appearance.positionHint')}</div>
        <div className="dshc-row-actions">
          <button
            type="button"
            className="dshc-button"
            data-variant="secondary"
            disabled={savingGroup !== ''}
            onClick={saveUi}
          >
            {savingGroup === 'ui' ? t('settings.save.saving') : t('settings.appearance.save')}
          </button>
          <button
            type="button"
            className="dshc-button"
            data-variant="ghost"
            onClick={() => { void store.saveEntryPos(null) }}
          >
            {t('settings.appearance.resetPosition')}
          </button>
        </div>
        <ResultLine result={results.ui} />
      </Card>
    </div>
  )
}

/** Inline Jev probe result: ok/latency/model, or a sanitized error code + message. */
function TestResultLine({ result, t }: { result: JevTestState; t: (key: string) => string }): ReactNode {
  const parts: string[] = []
  if (result.kind === 'ok') parts.push(t('jev.test.ok'))
  else parts.push(t('jev.test.fail'))
  if (result.latencyMs !== undefined) parts.push(`${t('jev.test.latency')} ${String(result.latencyMs)}ms`)
  if (result.model !== undefined) parts.push(`${t('jev.test.model')} ${result.model}`)
  if (result.code !== undefined) parts.push(`${t('jev.test.code')} ${result.code}`)
  if (result.message !== undefined) parts.push(result.message)
  return <div className="dshc-test-result" data-kind={result.kind} role="status">{parts.join(' · ')}</div>
}

/** Read the display-only confidence floor from the config view (M1 patch §1.1). */

/** One settings card surface. */
function Card({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="dshc-card">
      <div className="dshc-card-title">{title}</div>
      {children}
    </section>
  )
}

/** Inline save result for one group. */
function ResultLine({ result }: { result: GroupResult | undefined }): ReactNode {
  if (result === undefined) return null
  return <div className="dshc-result" data-kind={result.kind} role="status">{result.text}</div>
}

function toDraft(row: WorkspaceView): WorkspaceDraft {
  return {
    id: row.id,
    name: row.name ?? row.id,
    path: row.path ?? '',
    allowed: row.allowed === true,
    summary: row.summary ?? '',
    policy: row.policy === 'auto' ? 'auto' : 'inherit',
  }
}

function bindingWorkspace(state: CommanderView): string {
  return state.binding?.workspaceId ?? state.binding?.workspacePath ?? ''
}

function bindingModel(state: CommanderView): string {
  const model = state.binding?.model
  if (model === undefined) return ''
  const parts = [model.provider, model.model].filter((part): part is string => part !== undefined && part !== '')
  return parts.join(' / ')
}

function clampRotationDays(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1
  return Math.min(7, Math.max(1, numeric))
}

function formatRotationDue(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function mergeTheme(ui: UiConfig | undefined, fallback: UiForm['theme']): UiForm['theme'] {
  const theme = ui?.theme
  return theme === 'light' || theme === 'dark' || theme === 'follow' ? theme : fallback
}

