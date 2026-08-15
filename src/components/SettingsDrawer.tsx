import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, BookText, Brain, Brush, Check, ChevronDown, ChevronRight, FileText, Gauge, History, Image, Moon, ScrollText, Sun, X } from 'lucide-react'
import { contextUsageSummary, type ContextUsageState } from './ContextUsage'
import { ILLUSTRATION_STYLE_PRESETS, getIllustrationStylePreset } from '../domain/illustrationStyles'
import { THEME_PRESETS, getThemePreset } from '../domain/themes'
import type { AppearanceMode, ContextBudget, IllustrationStylePresetId, ThemePresetId } from '../domain/models'
import type { ProviderConfig, ProviderSettings, ProviderSlot } from '../providers/types'
import type { ContextBudgetPlan } from '../providers/writing'
import { usePresence } from '../hooks/usePresence'

interface Props {
  open: boolean
  suspended?: boolean
  projectTitle: string
  activeThemeId: ThemePresetId
  onClose: () => void
  onThemeChange: (themeId: ThemePresetId) => Promise<void>
  activeIllustrationStyleId: IllustrationStylePresetId
  activeCustomStylePrompt: string
  onIllustrationStyleChange: (styleId: IllustrationStylePresetId, customPrompt?: string) => Promise<void>
  activeWritingInstructions: string
  onEditWritingInstructions: () => void
  globalWritingInstructions?: string
  onEditGlobalWritingInstructions?: () => void
  styleCorpusSummary?: { sourceCount: number; fragmentCount: number }
  onOpenStyleCorpus?: () => void
  onOpenProseEvaluation?: () => void
  contextBudget: ContextBudget
  onContextBudgetChange: (budget: ContextBudget) => Promise<void>
  contextUsagePlan?: ContextBudgetPlan
  contextUsageState: ContextUsageState
  onOpenContextUsage: () => void
  onOpenSummaryHistory: () => void
  providerSettings: ProviderSettings
  onOpenProviderSettings: (slot: ProviderSlot) => void
  appearanceMode: AppearanceMode
  onAppearanceChange: (mode: AppearanceMode) => void
}

type SettingsPage = 'home' | 'writing' | 'memory' | 'appearance' | 'providers'

const PAGE_TITLES: Record<SettingsPage, string> = {
  home: '设置',
  writing: '写作',
  memory: '记忆与上下文',
  appearance: '外观',
  providers: '模型服务',
}

function providerSummary(provider: ProviderConfig) {
  const name = provider.name.trim() || '未命名供应商'
  const model = provider.model.trim()
  return model ? `${name} · ${model}` : `${name} · 未选择模型`
}

export default function SettingsDrawer({
  open,
  suspended = false,
  projectTitle,
  activeThemeId,
  onClose,
  onThemeChange,
  activeIllustrationStyleId,
  activeCustomStylePrompt,
  onIllustrationStyleChange,
  activeWritingInstructions,
  onEditWritingInstructions,
  globalWritingInstructions,
  onEditGlobalWritingInstructions,
  styleCorpusSummary,
  onOpenStyleCorpus,
  onOpenProseEvaluation,
  contextBudget,
  onContextBudgetChange,
  contextUsagePlan,
  contextUsageState,
  onOpenContextUsage,
  onOpenSummaryHistory,
  providerSettings,
  onOpenProviderSettings,
  appearanceMode,
  onAppearanceChange,
}: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)
  const themeSelectRef = useRef<HTMLDivElement>(null)
  const styleSelectRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<SettingsPage>('home')
  const [openSelect, setOpenSelect] = useState<'theme' | 'style' | null>(null)
  const [customStyleEditorOpen, setCustomStyleEditorOpen] = useState(false)
  const [customStylePrompt, setCustomStylePrompt] = useState(activeCustomStylePrompt)
  const { present, closing } = usePresence(open, onClose, 180)

  const themeMenuOpen = openSelect === 'theme'
  const styleMenuOpen = openSelect === 'style'
  const writingInstructionsPreview = activeWritingInstructions.trim().replace(/\s+/g, ' ')
  const globalWritingPreview = globalWritingInstructions?.trim().replace(/\s+/g, ' ')

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    if (suspended || wasOpenRef.current) return
    wasOpenRef.current = true
    setPage('home')
    setOpenSelect(null)
    setCustomStyleEditorOpen(false)
    closeButtonRef.current?.focus()
  }, [open, suspended])

  useEffect(() => {
    if (page === 'home') return
    setOpenSelect(null)
    backButtonRef.current?.focus()
  }, [page])

  useEffect(() => {
    if (!open || suspended) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (customStyleEditorOpen) {
        setCustomStyleEditorOpen(false)
        return
      }
      if (openSelect) {
        setOpenSelect(null)
        return
      }
      if (page !== 'home') {
        setPage('home')
        return
      }
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [customStyleEditorOpen, onClose, open, openSelect, page, suspended])

  useEffect(() => {
    if (!openSelect) return
    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target as Node
      const clickedInsideTheme = Boolean(themeSelectRef.current?.contains(target))
      const clickedInsideStyle = Boolean(styleSelectRef.current?.contains(target))
      if (!clickedInsideTheme && !clickedInsideStyle) setOpenSelect(null)
    }
    document.addEventListener('click', handleDocumentClick)
    return () => document.removeEventListener('click', handleDocumentClick)
  }, [openSelect])

  useEffect(() => {
    setCustomStylePrompt(activeCustomStylePrompt)
  }, [activeCustomStylePrompt])

  if (!present) return null

  return (
    <div className={`settings-backdrop${closing ? ' closing' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <aside
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-drawer-title"
        aria-hidden={suspended || undefined}
        data-suspended={suspended ? 'true' : 'false'}
      >
        <header className="drawer-header">
          {page !== 'home' && (
            <button
              ref={backButtonRef}
              className="icon-button drawer-back-button"
              type="button"
              aria-label="返回设置"
              onClick={() => setPage('home')}
            >
              <ArrowLeft size={19} />
            </button>
          )}
          <div>
            <h2 id="settings-drawer-title">{PAGE_TITLES[page]}</h2>
            <p>当前作品 · {projectTitle}</p>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="settings-content">
          {page === 'home' && (
            <>
              <section className="settings-section" aria-labelledby="settings-app-appearance">
                <h3 id="settings-app-appearance">界面外观</h3>
                <div className="appearance-options" role="radiogroup" aria-label="界面外观">
                  <button type="button" role="radio" aria-checked={appearanceMode === 'dark'} onClick={() => onAppearanceChange('dark')}><Moon size={16} />深色</button>
                  <button type="button" role="radio" aria-checked={appearanceMode === 'light'} onClick={() => onAppearanceChange('light')}><Sun size={16} />浅色</button>
                </div>
                <p className="settings-help">只改变应用界面。</p>
              </section>

              <section className="settings-section" aria-labelledby="settings-categories">
                <h3 id="settings-categories">分类</h3>
                <div className="settings-navigation-list">
                  <button type="button" onClick={() => setPage('writing')}>
                    <ScrollText size={18} aria-hidden="true" />
                    <span><strong>写作</strong><small>创作设定、风格语料库与文风优化数据</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => setPage('memory')}>
                    <Brain size={18} aria-hidden="true" />
                    <span><strong>记忆与上下文</strong><small>上下文长度、本轮用量与摘要历史</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => setPage('appearance')}>
                    <Brush size={18} aria-hidden="true" />
                    <span><strong>外观</strong><small>{getIllustrationStylePreset(activeIllustrationStyleId).label} · 插画与故事样式</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => setPage('providers')}>
                    <FileText size={18} aria-hidden="true" />
                    <span><strong>模型服务</strong><small>{providerSummary(providerSettings.text)}</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
              </section>
            </>
          )}

          {page === 'writing' && (
            <>
              <section className="settings-section" aria-labelledby="global-writing-settings">
                <h3 id="global-writing-settings">全局创作设定</h3>
                <div className="settings-navigation-stack">
                  <button type="button" onClick={onEditGlobalWritingInstructions} disabled={!onEditGlobalWritingInstructions}>
                    <ScrollText size={18} aria-hidden="true" />
                    <span>
                      <strong>全局创作设定</strong>
                      <small>{globalWritingPreview || '对所有作品生效的默认规则'}</small>
                    </span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
                <p className="settings-help">所有作品都会携带，本作品的局部设定可以临时覆盖。</p>
              </section>

              <section className="settings-section" aria-labelledby="writing-tools-settings">
                <h3 id="writing-tools-settings">创作辅助</h3>
                <div className="settings-navigation-stack">
                  <button type="button" onClick={onOpenStyleCorpus} disabled={!onOpenStyleCorpus}>
                    <BookText size={18} aria-hidden="true" />
                    <span><strong>风格语料库</strong><small>{styleCorpusSummary ? `${styleCorpusSummary.sourceCount} 个来源 · ${styleCorpusSummary.fragmentCount} 个片段` : '导入并整理你认可的表达范例'}</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={onOpenProseEvaluation} disabled={!onOpenProseEvaluation}>
                    <Gauge size={18} aria-hidden="true" />
                    <span><strong>文风优化数据</strong><small>仅本地记录，可审阅后导出</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
              </section>

              <section className="settings-section" aria-labelledby="current-project-writing-settings">
                <h3 id="current-project-writing-settings">当前作品</h3>
                <div className="settings-navigation-list">
                  <button type="button" onClick={onEditWritingInstructions}>
                    <ScrollText size={18} aria-hidden="true" />
                    <span>
                      <strong>局部创作设定</strong>
                      <small>{writingInstructionsPreview || '设置视角、文风、篇幅和长期禁忌'}</small>
                    </span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
                <p className="settings-help">每轮写作都会携带，本轮明确要求可以临时覆盖。</p>
              </section>
            </>
          )}

          {page === 'memory' && (
            <section className="settings-section" aria-labelledby="memory-settings">
              <h3 id="memory-settings">上下文与记忆</h3>
              <div className="context-budget-choice" role="radiogroup" aria-label="写作上下文长度">
                {([
                  ['standard', '标准', '窗口的 55%'],
                  ['long', '长', '窗口的 75%'],
                  ['full', '完整', '窗口的 95%'],
                ] as const).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={contextBudget === value}
                    onClick={() => void onContextBudgetChange(value)}
                  >
                    {label}
                    <span>{hint}</span>
                  </button>
                ))}
              </div>
              <p className="settings-help">按已识别模型的上下文窗口自动换算（输出与安全预留后按比例使用）。越长越不易忘记旧剧情，但更费 token。</p>
              <div className="settings-navigation-stack context-usage-settings-entry">
                <button type="button" onClick={onOpenContextUsage}>
                  <Gauge size={18} aria-hidden="true" />
                  <span>
                    <strong>查看本轮上下文用量</strong>
                    <small>{contextUsageSummary(contextUsagePlan, contextUsageState)}</small>
                  </span>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
                <button type="button" onClick={onOpenSummaryHistory}>
                  <History size={18} aria-hidden="true" />
                  <span>
                    <strong>摘要版本历史</strong>
                    <small>查看章节摘要来源并恢复旧版本</small>
                  </span>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
              </div>
            </section>
          )}

          {page === 'appearance' && (
            <>
              <section className="settings-section" aria-labelledby="story-theme-settings">
                <h3 id="story-theme-settings">作品氛围</h3>
                <div ref={themeSelectRef} className="theme-select">
                  <button
                    className="theme-select-trigger"
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={themeMenuOpen}
                    onClick={() => setOpenSelect((current) => current === 'theme' ? null : 'theme')}
                  >
                    <span className={`theme-select-swatch theme-${activeThemeId}`} aria-hidden="true" />
                    <span className="theme-select-copy"><strong>{getThemePreset(activeThemeId).label}</strong><small>{getThemePreset(activeThemeId).description}</small></span>
                    <ChevronDown size={17} aria-hidden="true" className={themeMenuOpen ? 'rotate-180' : undefined} />
                  </button>
                  {themeMenuOpen && (
                    <div className="theme-select-menu" role="listbox" aria-label="选择作品氛围">
                      {THEME_PRESETS.map((theme) => {
                        const selected = theme.id === activeThemeId
                        return (
                          <button
                            key={theme.id}
                            className="theme-select-option"
                            type="button"
                            role="option"
                            aria-selected={selected}
                            onClick={() => {
                              setOpenSelect(null)
                              void onThemeChange(theme.id)
                            }}
                          >
                            <span className={`theme-select-option-swatch theme-${theme.id}`} aria-hidden="true" />
                            <span><strong>{theme.label}</strong><small>{theme.description}</small></span>
                            {selected && <Check size={15} aria-hidden="true" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
                <p className="settings-help">只改变故事区域，不影响应用操作界面。</p>
              </section>

              <section className="settings-section" aria-labelledby="illustration-style-settings">
                <h3 id="illustration-style-settings">插画画风</h3>
                <div ref={styleSelectRef} className="theme-select illustration-style-select">
                <button
                  className="theme-select-trigger"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={styleMenuOpen}
                  onClick={() => setOpenSelect((current) => current === 'style' ? null : 'style')}
                >
                  <Brush size={16} aria-hidden="true" />
                  <span className="theme-select-copy">
                    <strong>{getIllustrationStylePreset(activeIllustrationStyleId).label}</strong>
                    <small>{activeIllustrationStyleId === 'custom' && activeCustomStylePrompt ? activeCustomStylePrompt : getIllustrationStylePreset(activeIllustrationStyleId).description}</small>
                  </span>
                  <ChevronDown size={17} aria-hidden="true" className={styleMenuOpen ? 'rotate-180' : undefined} />
                </button>
                {styleMenuOpen && (
                  <div className="theme-select-menu illustration-style-menu" role="listbox" aria-label="选择插画画风">
                    {ILLUSTRATION_STYLE_PRESETS.map((style) => {
                      const selected = style.id === activeIllustrationStyleId
                      return (
                        <button
                          key={style.id}
                          className="theme-select-option"
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setOpenSelect(null)
                            if (style.id === 'custom') {
                              setCustomStyleEditorOpen(true)
                              return
                            }
                            setCustomStyleEditorOpen(false)
                            void onIllustrationStyleChange(style.id)
                          }}
                        >
                          <span className={`theme-select-option-swatch illustration-style-${style.id}`} aria-hidden="true" />
                          <span><strong>{style.label}</strong><small>{style.description}</small></span>
                          {selected && <Check size={15} aria-hidden="true" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              {customStyleEditorOpen && (
                <form className="custom-style-editor" onSubmit={(event) => {
                  event.preventDefault()
                  if (!customStylePrompt.trim()) return
                  void onIllustrationStyleChange('custom', customStylePrompt.trim())
                    .then(() => setCustomStyleEditorOpen(false))
                    .catch(() => undefined)
                }}>
                  <label htmlFor="custom-illustration-style">描述整体画风</label>
                  <textarea
                    id="custom-illustration-style"
                    rows={3}
                    maxLength={500}
                    value={customStylePrompt}
                    placeholder="例如：清透的国风工笔画，细线勾勒，淡雅矿物色，保留纸张纹理。"
                    onChange={(event) => setCustomStylePrompt(event.target.value)}
                  />
                  <div><span>{customStylePrompt.length}/500</span><button className="primary-button" type="submit" disabled={!customStylePrompt.trim()}>应用画风</button></div>
                </form>
              )}
                <p className="settings-help">会用于之后生成的定妆照和剧情插画。</p>
              </section>
            </>
          )}

          {page === 'providers' && (
            <section className="settings-section" aria-labelledby="model-service-settings">
              <h3 id="model-service-settings">模型服务</h3>
              <div className="settings-navigation-list">
                <button type="button" onClick={() => onOpenProviderSettings('text')}>
                  <FileText size={18} aria-hidden="true" />
                  <span><strong>文本模型</strong><small>{providerSummary(providerSettings.text)}</small></span>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
                <button type="button" onClick={() => onOpenProviderSettings('image')}>
                  <Image size={18} aria-hidden="true" />
                  <span><strong>图片模型</strong><small>{providerSummary(providerSettings.image)}</small></span>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
              </div>
              <p className="settings-help">详细地址、API Key、供应商和模型列表在二级页面管理。</p>
            </section>
          )}
        </div>
      </aside>
    </div>
  )
}
