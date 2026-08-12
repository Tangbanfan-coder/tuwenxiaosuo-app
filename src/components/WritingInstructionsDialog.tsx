import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronDown, LoaderCircle, Plus, RefreshCw, Save, Sparkles, Trash2, X } from 'lucide-react'
import { usePresence } from '../hooks/usePresence'
import ConfirmDialog from './ConfirmDialog'
import { estimateWritingInstructionStructureCalls, parseWritingStructureJson, structureWritingInstructions, WRITING_STRUCTURE_CORE_LIMIT } from '../providers/writing'
import { browserTransport } from '../providers/browserTransport'
import type { ProviderConfig } from '../providers/types'
import type { WritingInstructionsStructure } from '../domain/models'

interface Props {
  open: boolean
  projectTitle: string
  value: string
  structure?: string
  onClose: () => void
  onSave: (value: string) => Promise<void>
  onSaveStructure: (structureJson: string | null) => Promise<void>
  textProvider?: ProviderConfig
  isGlobal?: boolean
}

const MAX_LENGTH = 50_000
const STRUCTURE_CALL_WARNING_THRESHOLD = 10

type Phase = 'edit' | 'structuring' | 'review'

export default function WritingInstructionsDialog({ open, projectTitle, value, structure, onClose, onSave, onSaveStructure, textProvider, isGlobal = false }: Props) {
  const dialogRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)
  const [estimatedStructureCalls, setEstimatedStructureCalls] = useState<number>()
  const [phase, setPhase] = useState<Phase>('edit')
  const [structuredResult, setStructuredResult] = useState<WritingInstructionsStructure>()
  const [structureError, setStructureError] = useState('')
  const [existingStructure, setExistingStructure] = useState<WritingInstructionsStructure>()
  const [expandedSection, setExpandedSection] = useState<number>()
  const { present, closing } = usePresence(open, onClose, 180)
  const normalizedValue = value.trim()
  const isDirty = useMemo(() => draft.trim() !== normalizedValue, [draft, normalizedValue])

  useEffect(() => {
    if (!open) return
    setDraft(value)
    setSaving(false)
    setPhase('edit')
    setStructureError('')
    setEstimatedStructureCalls(undefined)
    setStructuredResult(undefined)
    setExpandedSection(undefined)
    setExistingStructure(parseWritingStructureJson(structure))
    window.requestAnimationFrame(() => textareaRef.current?.focus())
    // 仅依赖 open：外部保存原文会触发 value/structure 变化，此时不应重置编辑或整理状态。
  }, [open])

  useEffect(() => {
    if (phase !== 'review' || !structuredResult) return
    setExpandedSection(undefined)
  }, [phase, structuredResult])

  if (!present) return null

  function close() {
    if (saving) return
    if (phase !== 'edit') {
      onClose()
      return
    }
    if (isDirty) {
      setConfirmDiscardOpen(true)
      return
    }
    onClose()
  }

  async function structureDraft(callCountConfirmed = false) {
    if (!textProvider) {
      setStructureError('请先在模型服务中配置文本模型，再使用自动整理。')
      setPhase('edit')
      return
    }
    if (!callCountConfirmed) {
      try {
        const callCount = estimateWritingInstructionStructureCalls(draft, textProvider)
        if (callCount > STRUCTURE_CALL_WARNING_THRESHOLD) {
          setEstimatedStructureCalls(callCount)
          return
        }
      } catch (error) {
        setStructureError(error instanceof Error ? error.message : '无法估算整理调用次数')
        return
      }
    }
    setPhase('structuring')
    setStructureError('')
    try {
      if (isDirty) {
        await onSave(draft)
      }
      const result = await structureWritingInstructions(draft, textProvider, browserTransport)
      setStructuredResult(result)
      setPhase('review')
    } catch (error) {
      setStructureError(error instanceof Error ? error.message : '整理失败，请重试')
      setPhase('edit')
    }
  }

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      await onSave(draft)
      onClose()
    } catch {
      // The parent reports the specific save error without closing the editor.
    } finally {
      setSaving(false)
    }
  }

  async function confirmStructure() {
    if (!structuredResult || saving) return
    if (structuredResult.core.length > WRITING_STRUCTURE_CORE_LIMIT) {
      setStructureError(`核心规则超过 ${WRITING_STRUCTURE_CORE_LIMIT} 字，请精简后再确认保存。分类设定不会受此限制。`)
      return
    }
    setSaving(true)
    try {
      await onSaveStructure(JSON.stringify(structuredResult))
      onClose()
    } catch {
      setStructureError('结构化版本保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  function updateSection(index: number, patch: Partial<WritingInstructionsStructure['sections'][number]>) {
    setStructuredResult((current) => current ? {
      ...current,
      sections: current.sections.map((section, sectionIndex) => sectionIndex === index ? { ...section, ...patch } : section),
    } : current)
  }

  function updateStyleSample(index: number, patch: Partial<WritingInstructionsStructure['styleSamples'][number]>) {
    setStructuredResult((current) => current ? {
      ...current,
      styleSamples: current.styleSamples.map((sample, sampleIndex) => sampleIndex === index ? { ...sample, ...patch } : sample),
    } : current)
  }

  async function skipStructure() {
    if (saving) return
    setSaving(true)
    try {
      await onSaveStructure(null)
      onClose()
    } catch {
      setStructureError('无法清除旧的结构化版本，请重试')
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

  return (
    <div className={`dialog-backdrop${closing ? ' closing' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) close()
    }}>
      <section
        ref={dialogRef}
        className="writing-instructions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="writing-instructions-title"
        aria-describedby="writing-instructions-description"
        onKeyDown={handleKeyDown}
      >
        <header className="dialog-header">
          <div>
            <h2 id="writing-instructions-title">{phase === 'edit' ? (isGlobal ? '全局创作设定' : '局部创作设定') : '整理为分层结构'}</h2>
            <p id="writing-instructions-description">{isGlobal ? '作为所有作品的默认规则，作品专属设定会优先覆盖' : `仅用于《${projectTitle}》`}</p>
          </div>
          <button className="icon-button" type="button" aria-label={`关闭${isGlobal ? '全局' : '局部'}创作设定`} onClick={close}><X size={20} /></button>
        </header>

        {phase === 'edit' && (
          <form className="writing-instructions-form" onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}>
            <label htmlFor="project-writing-instructions">每轮默认遵循的写作规则</label>
            <textarea
              ref={textareaRef}
              id="project-writing-instructions"
              rows={9}
              maxLength={MAX_LENGTH}
              value={draft}
              placeholder="例如：使用第三人称有限视角；文风克制；避免网络用语；每章约两千字；不要替主角作出重大决定。"
              onChange={(event) => setDraft(event.target.value)}
            />
            <p>本轮输入提出不同要求时，以本轮输入为准。留空并保存即可清除长期设定。</p>
            {existingStructure && (
              <div className="structure-status">
                <Sparkles size={15} />
                已整理为分层结构：{existingStructure.sections.length} 个分类、{existingStructure.styleSamples.length} 个风格范例
                {isDirty && <em>（原文已修改，需重新整理）</em>}
              </div>
            )}
            {structureError && <p className="field-error">{structureError}</p>}
            <footer className="dialog-footer">
              <span>{draft.length}/{MAX_LENGTH}</span>
              <div>
                <button className="quiet-button" type="button" disabled={saving} onClick={close}>取消</button>
                {!isGlobal && draft.trim().length > 200 && (
                  <button className="quiet-button structure-button" type="button" disabled={saving} onClick={() => void structureDraft()}>
                    <Sparkles size={15} />整理结构
                  </button>
                )}
                <button className="save-button" type="submit" disabled={saving || !isDirty}>
                  <Save size={17} />{saving ? '正在保存…' : '保存设定'}
                </button>
              </div>
            </footer>
          </form>
        )}

        {phase === 'structuring' && (
          <div className="structuring-panel" aria-live="polite">
            <LoaderCircle className="spin" size={26} />
            <h3>正在把设定整理为分层结构…</h3>
            <p>提取每轮携带的核心规则、按场景加载的分类设定和风格范例。</p>
          </div>
        )}

        {phase === 'review' && structuredResult && (
          <div className="structure-review">
            <div className="structure-core-heading">
              <label htmlFor="structure-core">核心规则（每轮固定携带）</label>
              <span className={structuredResult.core.length > WRITING_STRUCTURE_CORE_LIMIT ? 'over-limit' : undefined}>
                {structuredResult.core.length}/{WRITING_STRUCTURE_CORE_LIMIT}
              </span>
            </div>
            <textarea
              id="structure-core"
              rows={5}
              value={structuredResult.core}
              onChange={(event) => setStructuredResult((current) => current ? { ...current, core: event.target.value } : current)}
            />

            <div className="structure-subheading">分类设定（按当前场景选择加载）</div>
            <div className="structure-section-list">
              {structuredResult.sections.map((section, index) => (
                <div key={section.id} className="structure-section">
                  <button
                    type="button"
                    aria-expanded={expandedSection === index}
                    onClick={() => setExpandedSection((current) => current === index ? undefined : index)}
                  >
                    <span><strong>{section.title}</strong><em>优先级 {section.priority} · {section.tags.join('、')}</em></span>
                    <ChevronDown size={16} className={expandedSection === index ? 'rotate-180' : undefined} />
                  </button>
                  {expandedSection === index && (
                    <div className="structure-section-editor">
                      <div className="structure-editor-row">
                        <label>
                          <span>分类标题</span>
                          <input value={section.title} onChange={(event) => updateSection(index, { title: event.target.value })} />
                        </label>
                        <label className="structure-priority-field">
                          <span>优先级</span>
                          <input
                            type="number"
                            min={1}
                            max={5}
                            value={section.priority}
                            onChange={(event) => updateSection(index, {
                              priority: Math.min(5, Math.max(1, Math.floor(Number(event.target.value) || 1))),
                            })}
                          />
                        </label>
                      </div>
                      <label>
                        <span>检索标签（用逗号分隔）</span>
                        <input
                          value={section.tags.join('，')}
                          onChange={(event) => updateSection(index, {
                            tags: event.target.value.split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean),
                          })}
                        />
                      </label>
                      <label>
                        <span>分类内容</span>
                        <textarea value={section.content} onChange={(event) => updateSection(index, { content: event.target.value })} />
                      </label>
                      <button className="structure-delete-button" type="button" onClick={() => setStructuredResult((current) => current ? {
                        ...current,
                        sections: current.sections.filter((_, sectionIndex) => sectionIndex !== index),
                      } : current)}><Trash2 size={14} />删除分类</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button className="structure-add-button" type="button" onClick={() => setStructuredResult((current) => current ? {
              ...current,
              sections: [...current.sections, {
                id: `section-${Date.now()}-${current.sections.length}`,
                title: '新分类',
                content: '',
                tags: [],
                priority: 1,
              }],
            } : current)}><Plus size={15} />新增分类</button>

            <div className="structure-subheading">风格范例（按场景类型选择）</div>
            <div className="structure-sample-list">
              {structuredResult.styleSamples.map((sample, index) => (
                <div key={index} className="structure-sample">
                  <label>
                    <span>场景类型</span>
                    <input value={sample.sceneType} onChange={(event) => updateStyleSample(index, { sceneType: event.target.value })} />
                  </label>
                  <label>
                    <span>范例内容</span>
                    <textarea value={sample.content} onChange={(event) => updateStyleSample(index, { content: event.target.value })} />
                  </label>
                  <button className="structure-delete-button" type="button" onClick={() => setStructuredResult((current) => current ? {
                    ...current,
                    styleSamples: current.styleSamples.filter((_, sampleIndex) => sampleIndex !== index),
                  } : current)}><Trash2 size={14} />删除范例</button>
                </div>
              ))}
            </div>
            <button className="structure-add-button" type="button" onClick={() => setStructuredResult((current) => current ? {
              ...current,
              styleSamples: [...current.styleSamples, { sceneType: '日常', content: '' }],
            } : current)}><Plus size={15} />新增风格范例</button>

            {structureError && <p className="field-error">{structureError}</p>}

            <footer className="dialog-footer">
              <span>AI 整理结果不会替换你的原文</span>
              <div>
                <button className="quiet-button" type="button" disabled={saving} onClick={() => void structureDraft()}>
                  <RefreshCw size={15} />重新整理
                </button>
                <button className="quiet-button" type="button" disabled={saving} onClick={() => void skipStructure()}>
                  跳过整理
                </button>
                <button className="save-button" type="button" disabled={saving} onClick={() => void confirmStructure()}>
                  <Save size={17} />{saving ? '正在保存…' : '确认保存'}
                </button>
              </div>
            </footer>
          </div>
        )}
      </section>
      <ConfirmDialog
        open={confirmDiscardOpen}
        title="放弃未保存的更改？"
        message={`${isGlobal ? '全局' : '局部'}创作设定尚未保存。`}
        confirmLabel="放弃更改"
        onClose={() => setConfirmDiscardOpen(false)}
        onConfirm={onClose}
      />
      <ConfirmDialog
        open={estimatedStructureCalls !== undefined}
        title="整理调用次数较多"
        message={estimatedStructureCalls === undefined
          ? ''
          : `当前模型预计需要调用 ${estimatedStructureCalls} 次；失败分块最多重试一次，最坏可能达到 ${estimatedStructureCalls * 2} 次。调用会产生额外费用，建议改用上下文窗口更大的模型。`}
        confirmLabel="仍要整理"
        cancelLabel="暂不整理"
        onClose={() => setEstimatedStructureCalls(undefined)}
        onConfirm={() => void structureDraft(true)}
      />
    </div>
  )
}
