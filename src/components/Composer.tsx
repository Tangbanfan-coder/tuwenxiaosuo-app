import { useEffect, useRef, useState } from 'react'
import { Check, ImagePlus, Save, Send, Square } from 'lucide-react'
import ContextUsage, { contextUsageToolbarSummary } from './ContextUsage'
import ComposerAssetsMenu from './ComposerAssetsMenu'
import ReasoningEffortQuickControl from './ReasoningEffortQuickControl'
import type { ContextUsageState } from '../domain/contextUsage'
import type { IllustrationMode } from '../domain/models'
import type { ReasoningEffort } from '../providers/types'
import type { ContextBudgetPlan } from '../providers/writing'
import type { GenerationPhase } from '../hooks/useWritingTurnController'

interface ComposerProps {
  generationPhase: GenerationPhase
  illustrationMode: IllustrationMode
  reasoningEffort: ReasoningEffort | undefined
  contextUsagePlan?: ContextBudgetPlan
  contextUsageState: ContextUsageState
  onSubmit: (text: string) => Promise<boolean>
  onStop: () => void
  onOpenContextUsage: () => void
  onOpenCharacterAssets: () => void
  onOpenReferenceImage: () => void
  onReasoningEffortChange: (reasoningEffort: ReasoningEffort) => void
  onIllustrationModeChange: (mode: IllustrationMode) => void
}

export default function Composer({
  generationPhase,
  illustrationMode,
  reasoningEffort,
  contextUsagePlan,
  contextUsageState,
  onSubmit,
  onStop,
  onOpenContextUsage,
  onOpenCharacterAssets,
  onOpenReferenceImage,
  onReasoningEffortChange,
  onIllustrationModeChange,
}: ComposerProps) {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [illustrationModeOpen, setIllustrationModeOpen] = useState(false)
  const illustrationModeControlRef = useRef<HTMLDivElement>(null)
  const illustrationModeTriggerRef = useRef<HTMLButtonElement>(null)
  const generating = generationPhase === 'starting' || generationPhase === 'running'
  const saving = generationPhase === 'saving'
  const cancelling = generationPhase === 'cancelling'

  useEffect(() => {
    if (!illustrationModeOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!illustrationModeControlRef.current?.contains(event.target as Node)) setIllustrationModeOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setIllustrationModeOpen(false)
      illustrationModeTriggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [illustrationModeOpen])

  const submit = async () => {
    const text = draft.trim()
    if (!text || generationPhase !== 'idle' || submitting) return
    setSubmitting(true)
    setDraft('')
    try {
      if (await onSubmit(text)) setDraft(text)
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Browsers disagree on composition state during the final IME Enter.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <footer className="composer-wrap">
      <div className="composer">
        <textarea rows={1} value={draft} placeholder="继续写下去，或告诉 AI 你想看到的画面…" aria-label="创作要求" onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <ComposerAssetsMenu onOpenCharacterAssets={onOpenCharacterAssets} onOpenReferenceImage={onOpenReferenceImage} />
            <ReasoningEffortQuickControl value={reasoningEffort} onChange={onReasoningEffortChange} />
            <ContextUsage plan={contextUsagePlan} state={contextUsageState} compactLabel={contextUsageToolbarSummary(contextUsagePlan, contextUsageState)} detailsOpen={false} showDetails={false} onDetailsOpenChange={(open) => { if (open) onOpenContextUsage() }} />
            <div ref={illustrationModeControlRef} className="illustration-mode-control">
              <button ref={illustrationModeTriggerRef} className="composer-tool-button auto-illustrate-button" type="button" aria-expanded={illustrationModeOpen} aria-haspopup="menu" aria-label={`配图模式：${illustrationMode === 'none' ? '无图' : illustrationMode === 'manual' ? '按需' : '自动'}`} onClick={() => setIllustrationModeOpen((open) => !open)}>
                <ImagePlus size={17} aria-hidden="true" /><span>配图</span><strong>{illustrationMode === 'none' ? '无图' : illustrationMode === 'manual' ? '按需' : '自动'}</strong>
              </button>
              {illustrationModeOpen && <div className="illustration-mode-menu" role="menu" aria-label="选择配图模式">
                {([['none', '无图', '只写正文'], ['manual', '按需', '保存建议，手动生成'], ['auto', '自动', '自动生成插画']] as const).map(([mode, label, description]) => (
                  <button key={mode} type="button" role="menuitemradio" aria-checked={illustrationMode === mode} onClick={() => { onIllustrationModeChange(mode); setIllustrationModeOpen(false); illustrationModeTriggerRef.current?.focus() }}>
                    <span><strong>{label}</strong><small>{description}</small></span>{illustrationMode === mode && <Check size={15} aria-hidden="true" />}
                  </button>
                ))}
              </div>}
            </div>
          </div>
          <button className="send-button" type="button" aria-label={cancelling ? '正在停止' : saving ? '正在保存' : generating ? '停止生成' : '发送'} disabled={cancelling || saving || (!generating && (!draft.trim() || submitting))} onClick={() => { if (generating) void onStop(); else if (!cancelling && !saving) void submit() }}>
            <span className="send-button-surface">{saving ? <Save size={16} /> : generating || cancelling ? <Square size={16} /> : <Send size={18} />}</span>
          </button>
        </div>
      </div>
    </footer>
  )
}
