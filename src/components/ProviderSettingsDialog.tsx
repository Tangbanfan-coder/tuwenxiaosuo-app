import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Capacitor } from '@capacitor/core'
import { Check, ChevronDown, Eye, EyeOff, LoaderCircle, PlugZap, Plus, Save, Search, Trash2, X } from 'lucide-react'
import { createProviderConfig } from '../providers/config'
import { browserTransport } from '../providers/browserTransport'
import { listOpenAiModels } from '../providers/openAiCompatible'
import { isModelKnown, lookupModelLimit, withModelMetadata } from '../providers/modelLimits'
import { secretStore } from '../providers/secretStore'
import type { ModelSummary, ProviderConfig, ProviderSettings, ProviderSlot } from '../providers/types'
import { usePresence } from '../hooks/usePresence'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  open: boolean
  nested?: boolean
  settings: ProviderSettings
  initialSlot?: ProviderSlot
  onClose: () => void
  onSave: (settings: ProviderSettings) => void
}

type TestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string }

type ProviderListKey = 'textProviders' | 'imageProviders'

function listKey(slot: ProviderSlot): ProviderListKey {
  return slot === 'text' ? 'textProviders' : 'imageProviders'
}

function providersFor(settings: ProviderSettings, slot: ProviderSlot) {
  const list = settings[listKey(slot)]
  return list?.length ? list : [settings[slot]]
}

function validateBaseUrl(value: string, required = false) {
  const trimmed = value.trim()
  if (!trimmed) return required ? '请先填写服务地址' : null
  try {
    const parsed = new URL(trimmed)
    return ['http:', 'https:'].includes(parsed.protocol) ? null : '服务地址只支持 HTTP 或 HTTPS'
  } catch {
    return '服务地址格式不正确'
  }
}

export default function ProviderSettingsDialog({ open, nested = false, settings, initialSlot = 'text', onClose, onSave }: Props) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const providerSelectRef = useRef<HTMLDivElement>(null)
  const { present, closing } = usePresence(open, onClose, 180)
  const [activeSlot, setActiveSlot] = useState<ProviderSlot>('text')
  const [draft, setDraft] = useState(settings)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [baselineApiKeys, setBaselineApiKeys] = useState<Record<string, string>>({})
  const [removedSecretRefs, setRemovedSecretRefs] = useState<string[]>([])
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<Record<string, ModelSummary[]>>({})
  const [modelQuery, setModelQuery] = useState('')
  const [urlError, setUrlError] = useState<Record<string, string | null>>({})
  const [testState, setTestState] = useState<Record<string, TestState>>({})
  const [saving, setSaving] = useState(false)
  const [providerMenuOpen, setProviderMenuOpen] = useState(false)
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState(false)
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setActiveSlot(initialSlot)
    setDraft(settings)
    setShowKey(false)
    setModelQuery('')
    setModels({})
    setUrlError({})
    setTestState({})
    setRemovedSecretRefs([])
    setProviderMenuOpen(false)

    const providers = [...providersFor(settings, 'text'), ...providersFor(settings, 'image')]
    const uniqueProviders = Array.from(new Map(providers.map((provider) => [provider.secretRef, provider])).values())
    void Promise.all(uniqueProviders.map(async (provider) => [provider.secretRef, await secretStore.get(provider.secretRef)] as const)).then((entries) => {
      if (cancelled) return
      const keys = Object.fromEntries(entries.map(([ref, key]) => [ref, key ?? '']))
      setApiKeys(keys)
      setBaselineApiKeys(keys)
      window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    })
    return () => { cancelled = true }
  }, [initialSlot, open, settings])

  useEffect(() => {
    if (!providerMenuOpen) return
    const handleDocumentClick = (event: MouseEvent) => {
      if (providerSelectRef.current && !providerSelectRef.current.contains(event.target as Node)) setProviderMenuOpen(false)
    }
    document.addEventListener('click', handleDocumentClick)
    return () => document.removeEventListener('click', handleDocumentClick)
  }, [providerMenuOpen])

  const current = draft[activeSlot]
  const providers = providersFor(draft, activeSlot)
  const currentModels = models[current.id] ?? []
  const currentKey = apiKeys[current.secretRef] ?? ''
  const status = testState[current.id] ?? { status: 'idle' as const }
  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings)
      || JSON.stringify(apiKeys) !== JSON.stringify(baselineApiKeys)
      || removedSecretRefs.length > 0,
    [apiKeys, baselineApiKeys, draft, removedSecretRefs, settings],
  )
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase()
    if (!query) return currentModels
    return currentModels.filter((model) => model.id.toLocaleLowerCase().includes(query))
  }, [currentModels, modelQuery])

  const autoContextPlaceholder = useMemo(() => {
    if (!current.model) return '自动识别'
    const limit = lookupModelLimit(current.model)
    return limit ? `${limit.context.toLocaleString()}（自动）` : '未识别（按 32K 保守）'
  }, [current.model])

  const modelUnknownWarning = useMemo(() => {
    if (!current.model || current.manualContextLength) return undefined
    if (isModelKnown(current.model)) return undefined
    return `未能识别“${current.model}”的上下文窗口，将按 32K 保守估算；建议在上方手动填写窗口大小。`
  }, [current.model, current.manualContextLength])

  if (!present) return null

  function updateCurrent(patch: Partial<ProviderConfig>) {
    setDraft((value) => {
      const nextCurrent = { ...value[activeSlot], ...patch }
      const key = listKey(activeSlot)
      const nextList = providersFor(value, activeSlot).map((provider) => provider.id === value[activeSlot].id ? nextCurrent : provider)
      return { ...value, [activeSlot]: nextCurrent, [key]: nextList }
    })
    setTestState((value) => ({ ...value, [current.id]: { status: 'idle' } }))
  }

  function switchSlot(slot: ProviderSlot) {
    setActiveSlot(slot)
    setShowKey(false)
    setModelQuery('')
    setProviderMenuOpen(false)
  }

  function selectProvider(id: string) {
    const next = providers.find((provider) => provider.id === id)
    if (!next) return
    setDraft((value) => ({ ...value, [activeSlot]: next }))
    setShowKey(false)
    setModelQuery('')
    setProviderMenuOpen(false)
  }

  function addProvider() {
    const provider = createProviderConfig(activeSlot)
    const key = listKey(activeSlot)
    setDraft((value) => ({ ...value, [activeSlot]: provider, [key]: [...providersFor(value, activeSlot), provider] }))
    setApiKeys((value) => ({ ...value, [provider.secretRef]: '' }))
    setBaselineApiKeys((value) => ({ ...value, [provider.secretRef]: '' }))
    setShowKey(false)
    setModelQuery('')
    setProviderMenuOpen(false)
  }

  function removeCurrentProvider() {
    if (providers.length <= 1) {
      setTestState((value) => ({ ...value, [current.id]: { status: 'error', message: '至少保留一个供应商；可以把它清空为自定义接口' } }))
      return
    }
    setConfirmDeleteProvider(true)
  }

  function performDeleteProvider() {
    const nextList = providers.filter((provider) => provider.id !== current.id)
    const next = nextList[0]
    const key = listKey(activeSlot)
    setDraft((value) => ({ ...value, [activeSlot]: next, [key]: nextList }))
    setRemovedSecretRefs((value) => value.includes(current.secretRef) ? value : [...value, current.secretRef])
    setShowKey(false)
    setModelQuery('')
    setProviderMenuOpen(false)
  }

  async function performDiscard() {
    await restoreKeys()
    setApiKeys({})
    setShowKey(false)
    onClose()
  }

  async function restoreKeys() {
    for (const [ref, value] of Object.entries(baselineApiKeys)) {
      if (value) await secretStore.set(ref, value)
      else await secretStore.remove(ref)
    }
  }

  async function close() {
    if (isDirty) {
      setConfirmDiscardOpen(true)
      return
    }
    await restoreKeys()
    setApiKeys({})
    setShowKey(false)
    onClose()
  }

  async function testConnection() {
    const validationMessage = validateBaseUrl(current.baseUrl, true)
    setUrlError((value) => ({ ...value, [current.id]: validationMessage }))
    if (validationMessage) return
    if (!currentKey.trim()) {
      setTestState((value) => ({ ...value, [current.id]: { status: 'error', message: '请先填写 API Key' } }))
      return
    }

    setTestState((value) => ({ ...value, [current.id]: { status: 'loading' } }))
    try {
      await secretStore.set(current.secretRef, currentKey.trim())
      const result = await listOpenAiModels(current, browserTransport)
      setDraft((value) => {
        const nextCurrent = { ...value[activeSlot], baseUrl: result.baseUrl }
        const key = listKey(activeSlot)
        const nextList = providersFor(value, activeSlot).map((provider) => provider.id === value[activeSlot].id ? nextCurrent : provider)
        return { ...value, [activeSlot]: nextCurrent, [key]: nextList }
      })
      setModels((value) => ({ ...value, [current.id]: result.models }))
      setModelQuery('')
      const pathAdded = result.baseUrl !== current.baseUrl.trim().replace(/\/+$/, '')
      setTestState((value) => ({
        ...value,
        [current.id]: { status: 'success', message: `${pathAdded ? '已自动补全兼容路径；' : ''}已获取 ${result.models.length} 个模型，请从下方选择` },
      }))
    } catch (error) {
      setTestState((value) => ({
        ...value,
        [current.id]: { status: 'error', message: error instanceof Error ? error.message : '连接失败' },
      }))
    }
  }

  async function save() {
    for (const slot of ['text', 'image'] as const) {
      for (const provider of providersFor(draft, slot)) {
        const validationMessage = validateBaseUrl(provider.baseUrl)
        if (validationMessage) {
          setActiveSlot(slot)
          setUrlError((value) => ({ ...value, [provider.id]: validationMessage }))
          setTestState((value) => ({ ...value, [provider.id]: { status: 'error', message: '请先修正服务地址' } }))
          return
        }
      }
    }

    setSaving(true)
    try {
      for (const slot of ['text', 'image'] as const) {
        for (const provider of providersFor(draft, slot)) {
          const key = apiKeys[provider.secretRef]?.trim() ?? ''
          if (key) await secretStore.set(provider.secretRef, key)
          else await secretStore.remove(provider.secretRef)
        }
      }
      for (const ref of removedSecretRefs) await secretStore.remove(ref)
      onSave(draft)
      setApiKeys({})
      onClose()
    } finally {
      setSaving(false)
    }
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (providerMenuOpen) {
        setProviderMenuOpen(false)
        return
      }
      void close()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ))
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, slot: ProviderSlot) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    switchSlot(slot === 'text' ? 'image' : 'text')
  }

  return (
    <div className={`dialog-backdrop${nested ? ' nested-dialog-backdrop' : ''}${closing ? ' closing' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) void close()
    }}>
      <section
        ref={dialogRef}
        className={`provider-dialog${nested ? ' nested-provider-dialog' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-settings-title"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="dialog-header">
          <div>
            <h2 id="provider-settings-title">模型接口</h2>
            <p>可保存多家供应商，再分别选择文本和图片服务</p>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭模型设置" onClick={() => void close()}><X size={20} /></button>
        </header>

        <div className="provider-tabs" role="tablist" aria-label="接口类型">
          <button id="tab-text" type="button" role="tab" aria-controls="provider-panel" aria-selected={activeSlot === 'text'} onKeyDown={(event) => handleTabKeyDown(event, 'text')} onClick={() => switchSlot('text')}>文本模型</button>
          <button id="tab-image" type="button" role="tab" aria-controls="provider-panel" aria-selected={activeSlot === 'image'} onKeyDown={(event) => handleTabKeyDown(event, 'image')} onClick={() => switchSlot('image')}>图片模型</button>
        </div>

        <div id="provider-panel" className="dialog-body" role="tabpanel" aria-labelledby={`tab-${activeSlot}`}>
          <div className="provider-chooser">
            <div className="field provider-select-field">
              <span>当前供应商</span>
              <div ref={providerSelectRef} className="theme-select provider-select">
                <button
                  className="theme-select-trigger provider-select-trigger"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={providerMenuOpen}
                  onKeyDown={(event) => {
                    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
                    event.preventDefault()
                    setProviderMenuOpen(true)
                  }}
                  onClick={() => setProviderMenuOpen((value) => !value)}
                >
                  <PlugZap size={16} aria-hidden="true" />
                  <span className="theme-select-copy">
                    <strong>{current.name || '未命名供应商'}</strong>
                    <small>{current.model || current.baseUrl || '尚未配置模型与地址'}</small>
                  </span>
                  <ChevronDown size={17} aria-hidden="true" className={providerMenuOpen ? 'rotate-180' : undefined} />
                </button>
                {providerMenuOpen && (
                  <div className="theme-select-menu provider-select-menu" role="listbox" aria-label="选择供应商">
                    {providers.map((provider) => {
                      const selected = provider.id === current.id
                      return (
                        <button
                          key={provider.id}
                          className="theme-select-option"
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => selectProvider(provider.id)}
                        >
                          <PlugZap size={15} aria-hidden="true" />
                          <span>
                            <strong>{provider.name || '未命名供应商'}</strong>
                            <small>{provider.model || provider.baseUrl || '尚未配置'}</small>
                          </span>
                          {selected && <Check size={15} aria-hidden="true" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="provider-actions">
              <button type="button" onClick={addProvider}><Plus size={16} />新增</button>
              <button type="button" onClick={removeCurrentProvider} disabled={providers.length <= 1}><Trash2 size={16} />删除</button>
            </div>
          </div>

          <label className="field">
            <span>显示名称</span>
            <input value={current.name} onChange={(event) => updateCurrent({ name: event.target.value })} />
          </label>

          <label className="field">
            <span>服务地址</span>
            <input
              inputMode="url"
              spellCheck={false}
              value={current.baseUrl}
              placeholder="https://example/v1"
              aria-invalid={Boolean(urlError[current.id])}
              aria-describedby={urlError[current.id] ? `url-error-${current.id}` : undefined}
              onBlur={() => setUrlError((value) => ({ ...value, [current.id]: validateBaseUrl(current.baseUrl) }))}
              onChange={(event) => {
                updateCurrent({ baseUrl: event.target.value })
                setUrlError((value) => ({ ...value, [current.id]: null }))
              }}
            />
            <small className="field-hint">填写官网或代理地址即可；获取模型列表时会自动尝试常见的 `/v1` 路径。</small>
            {urlError[current.id] && <small id={`url-error-${current.id}`} className="field-error">{urlError[current.id]}</small>}
          </label>

          <div className="field">
            <label htmlFor={`api-key-${current.id}`}>API Key</label>
            <div className="secret-input">
              <input
                id={`api-key-${current.id}`}
                type={showKey ? 'text' : 'password'}
                value={currentKey}
                autoComplete="off"
                placeholder="sk-…"
                onChange={(event) => {
                  setApiKeys((value) => ({ ...value, [current.secretRef]: event.target.value }))
                  setTestState((value) => ({ ...value, [current.id]: { status: 'idle' } }))
                }}
              />
              <button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowKey((value) => !value)}>
                {showKey ? <Eye size={18} /> : <EyeOff size={18} />}
              </button>
            </div>
          </div>

          <label className="field">
            <span>模型 ID</span>
            <input
              value={current.model}
              placeholder={activeSlot === 'image' ? 'gpt-image-2' : 'model-id'}
              onChange={(event) => updateCurrent({
                model: event.target.value,
                contextLength: undefined,
                maxOutputTokens: undefined,
              })}
            />
          </label>

          <div className="model-limit-fields">
            <label className="field">
              <span>上下文窗口（tokens，留空自动识别）</span>
              <input
                inputMode="numeric"
                value={current.manualContextLength ?? ''}
                placeholder={autoContextPlaceholder}
                onChange={(event) => {
                  const value = event.target.value
                  updateCurrent({ manualContextLength: value ? Math.max(0, Math.floor(Number(value))) || undefined : undefined })
                }}
              />
            </label>
            <label className="field">
              <span>最大输出（tokens，留空用默认）</span>
              <input
                inputMode="numeric"
                value={current.manualMaxOutputTokens ?? ''}
                placeholder="16K"
                onChange={(event) => {
                  const value = event.target.value
                  updateCurrent({ manualMaxOutputTokens: value ? Math.max(0, Math.floor(Number(value))) || undefined : undefined })
                }}
              />
            </label>
          </div>
          {modelUnknownWarning && <p className="field-hint model-limit-hint">{modelUnknownWarning}</p>}

          {activeSlot === 'text' && Capacitor.isNativePlatform() && (
            <label className="provider-streaming-toggle">
              <span>
                <strong>流式输出</strong>
                <small>通过 WebView 实时显示正文，仅在中转服务支持 CORS 时启用。</small>
              </span>
              <input
                type="checkbox"
                checked={Boolean(current.androidStreamingEnabled)}
                onChange={(event) => updateCurrent({ androidStreamingEnabled: event.target.checked })}
              />
              <span className="switch" aria-hidden="true" />
            </label>
          )}

          <div className="connection-row">
            <button className="test-button" type="button" disabled={status.status === 'loading'} onClick={() => void testConnection()}>
              {status.status === 'loading' ? <LoaderCircle className="spin" size={18} /> : <PlugZap size={18} />}
              {status.status === 'loading' ? '正在获取…' : '获取模型列表'}
            </button>
            <span className={`connection-status ${status.status}`} aria-live="polite">
              {status.status === 'success' && <Check size={15} />}
              {'message' in status ? status.message : ''}
            </span>
          </div>

          {currentModels.length > 0 && (
            <section className="model-picker" aria-label="可用模型">
              <header>
                <strong>选择模型</strong>
                <span>{visibleModels.length} / {currentModels.length}</span>
              </header>
              {currentModels.length > 6 && (
                <label className="model-search">
                  <Search size={17} />
                  <input value={modelQuery} placeholder="搜索模型 ID" onChange={(event) => setModelQuery(event.target.value)} />
                </label>
              )}
              <div className="model-list" role="listbox" aria-label="模型列表">
                {visibleModels.map((model) => (
                  <button key={model.id} type="button" role="option" aria-selected={current.model === model.id} onClick={() => updateCurrent({
                    ...withModelMetadata(current, model),
                    manualContextLength: current.manualContextLength,
                    manualMaxOutputTokens: current.manualMaxOutputTokens,
                  })}>
                    <span><strong>{model.id}</strong>{model.ownedBy && <small>{model.ownedBy}</small>}</span>
                    {current.model === model.id && <Check size={17} />}
                  </button>
                ))}
                {visibleModels.length === 0 && <p>没有匹配的模型，可以直接在上方填写 ID。</p>}
              </div>
            </section>
          )}
        </div>

        <footer className="dialog-footer">
          <span>{isDirty ? '有未保存的更改' : '当前配置已同步'}</span>
          <button className="save-button" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? <LoaderCircle className="spin" size={18} /> : <Save size={18} />}
            {saving ? '正在保存…' : '保存配置'}
          </button>
        </footer>
      </section>
      <ConfirmDialog
        open={confirmDeleteProvider}
        title="删除供应商"
        message={`确定删除供应商“${current.name || '未命名'}”吗？它的 API Key 也会从本机移除。`}
        confirmLabel="删除"
        danger
        onClose={() => setConfirmDeleteProvider(false)}
        onConfirm={performDeleteProvider}
      />
      <ConfirmDialog
        open={confirmDiscardOpen}
        title="放弃未保存的更改？"
        message="模型配置尚未保存。"
        confirmLabel="放弃更改"
        onClose={() => setConfirmDiscardOpen(false)}
        onConfirm={() => void performDiscard()}
      />
    </div>
  )
}
