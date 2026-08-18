import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ImagePlus, LoaderCircle, Maximize2, Pencil, RefreshCcw, Save, Sparkles, Square, ThumbsDown, ThumbsUp, TriangleAlert, WandSparkles, X } from 'lucide-react'
import { listMessageFeedback, listMessageParagraphsWithCurrentStyleIssues, storyDatabase, toggleFeedbackBatch, upsertPreferenceSignal } from '../data/storyDatabase'
import type { CharacterAsset, ConversationMessage, Feedback, FeedbackScope, FeedbackVerdict, IllustrationAsset, ProseStyleIssue, RewriteStrength, StoredParagraph, WritingCandidate } from '../domain/models'
import { resolveIllustrationReferences } from '../domain/illustrationReferences'
import { createParagraphFingerprint } from '../domain/paragraphs'
import { resolveImageSource } from '../providers/imageAssetStore'
import { usePresence } from '../hooks/usePresence'

type ParagraphAnchor = {
  id: string
  index: number
  text: string
  fingerprint: string
}

export type IllustrationGenerationStage = 'waiting' | 'downloading' | 'saving' | 'validating'

export function illustrationGenerationStageText(stage: IllustrationGenerationStage | undefined) {
  if (stage === 'downloading') return '正在接收图片'
  if (stage === 'saving') return '正在保存到手机'
  if (stage === 'validating') return '正在校验文件'
  return '正在等待图片生成'
}

export function illustrationDirectionItems(illustration: IllustrationAsset | undefined) {
  if (!illustration) return []
  return [
    ['场景', illustration.prompt],
    ['动作', illustration.action],
    ['身体与手势', illustration.bodyLanguage],
    ['表情', illustration.expression],
    ['视线目标', illustration.gaze],
    ['镜头', illustration.camera],
    ['动态线索', illustration.motion],
  ].filter((item): item is [string, string] => Boolean(item[1]))
}

function illustrationStatusText(illustration: IllustrationAsset | undefined, imageProviderReady: boolean, referenceReason?: string, generationStage?: IllustrationGenerationStage) {
  const label = illustration?.generationMode === 'manual' ? '按需插画' : '自动插画'
  if (!illustration) return `${label} · 等待生成`
  if (illustration.status === 'generating') return `${label} · ${illustrationGenerationStageText(generationStage)}`
  if (illustration.status === 'ready') return `${label} · 已保存`
  if (illustration.status === 'failed') return `${label} · ${illustration.errorMessage || '生成失败'}`
  if (!imageProviderReady) return `${label} · 等待配置图片模型`
  if (referenceReason) return `${label} · ${referenceReason}`
  return `${label} · 等待手动生成`
}

export default function TimelineMessage({
  message,
  illustration,
  onRetryIllustration,
  onRetryWriting,
  imageProviderReady,
  onOpenImageSettings,
  characters,
  onOpenCharacterAssets,
  onOpenIllustration,
  illustrationGenerationStage,
  onRewriteParagraph,
  onApplyRewrite,
  onProseEvaluation,
  canEditUserMessage,
  onEditUserMessage,
  canRegenerate,
  writingCandidate,
  regenerationBusy,
  writingBusy,
  onRegenerateProse,
  onKeepOriginalProse,
  onAdoptCandidateProse,
  onAnalyzeFeedbackPreference,
}: {
  message: ConversationMessage
  illustration?: IllustrationAsset
  onRetryIllustration: (illustrationId: string) => Promise<void>
  onRetryWriting?: (message: ConversationMessage) => void
  imageProviderReady: boolean
  onOpenImageSettings: () => void
  characters: CharacterAsset[]
  onOpenCharacterAssets: () => void
  onOpenIllustration: (source: string, title: string, alt: string, localUri?: string) => void
  illustrationGenerationStage?: IllustrationGenerationStage
  onRewriteParagraph?: (input: { message: ConversationMessage; paragraph: StoredParagraph; strength: RewriteStrength }) => Promise<string>
  onApplyRewrite?: (input: { message: ConversationMessage; paragraph: StoredParagraph; rewrittenText: string }) => Promise<void>
  onProseEvaluation?: (event: { type: 'analyzed' | 'rewrite_opened' | 'rewrite_kept_original'; message: ConversationMessage; paragraph: StoredParagraph }) => void
  canEditUserMessage?: boolean
  onEditUserMessage?: (message: ConversationMessage, text: string) => Promise<boolean>
  canRegenerate?: boolean
  writingCandidate?: WritingCandidate
  regenerationBusy?: boolean
  writingBusy?: boolean
  onRegenerateProse?: (message: ConversationMessage) => void
  onKeepOriginalProse?: (message: ConversationMessage) => Promise<void>
  onAdoptCandidateProse?: (message: ConversationMessage) => Promise<void>
  onAnalyzeFeedbackPreference?: (input: { feedback: Feedback[]; verdict: FeedbackVerdict; reason?: string; targetTexts: string[] }) => Promise<void>
}) {
  const [showVisualPrompt, setShowVisualPrompt] = useState(false)
  const referenceResolution = illustration ? resolveIllustrationReferences(illustration, characters) : undefined
  const referenceReason = referenceResolution && !referenceResolution.ready ? referenceResolution.reason : undefined
  const canGenerate = Boolean(illustration && imageProviderReady && !referenceReason && (illustration.status === 'planned' || illustration.status === 'failed'))
  const imageSource = illustration ? resolveImageSource(illustration.imageUrl, illustration.localUri) : undefined
  const directionItems = illustrationDirectionItems(illustration)
  const referenceCharacters = referenceResolution?.ready ? referenceResolution.characters : []
  const blockedCharacterReadyForConfirmation = Boolean(illustration && referenceReason && illustration.referenceCharacterIds.some((id) => characters.find((character) => character.id === id)?.portraitStatus === 'review'))

  if (message.kind === 'user') {
    return <EditableUserMessage message={message} canEdit={canEditUserMessage} onSave={onEditUserMessage} />
  }

  if (message.kind === 'notice') {
    const failed = message.status === 'failed'
    const cancelled = message.status === 'cancelled'
    return (
      <div className="message-row assistant-row notice-indent">
        <div className={`assistant-notice ${message.status ?? 'ready'}`} role={failed ? 'alert' : 'status'}>
          {message.status === 'pending'
            ? <LoaderCircle className="spin" size={14} />
            : cancelled
              ? <Square size={13} />
              : failed
                ? <TriangleAlert size={14} />
                : <Sparkles size={14} />}
          <span>{message.text}</span>
          {(failed || cancelled) && onRetryWriting && (
            <button className="notice-retry" type="button" onClick={() => onRetryWriting(message)}>重新生成</button>
          )}
        </div>
      </div>
    )
  }

  if (message.kind === 'prose') return <FeedbackProse message={message} onRewriteParagraph={onRewriteParagraph} onApplyRewrite={onApplyRewrite} onProseEvaluation={onProseEvaluation} canRegenerate={canRegenerate} writingCandidate={writingCandidate} regenerationBusy={regenerationBusy} writingBusy={writingBusy} onRegenerateProse={onRegenerateProse} onKeepOriginalProse={onKeepOriginalProse} onAdoptCandidateProse={onAdoptCandidateProse} onAnalyzeFeedbackPreference={onAnalyzeFeedbackPreference} />

  return (
    <div className="message-row illustration-row">
      <figure className="illustration-card">
        {imageSource ? (
          <button
            className="illustration-image-button"
            type="button"
            aria-label={`放大查看${message.title ?? '剧情插画'}`}
            onClick={() => onOpenIllustration(imageSource, message.title ?? '剧情插画', message.title ?? '剧情插画', illustration?.localUri)}
          >
            <img className="generated-illustration" src={imageSource} alt={message.title ?? '剧情插画'} />
            <span className="illustration-zoom-hint" aria-hidden="true"><Maximize2 size={17} /></span>
          </button>
        ) : illustration?.status === 'generating' ? (
          <div className="illustration-placeholder" role="img" aria-label={`${message.title ?? '剧情'}插画生成占位图`}>
            <LoaderCircle className="spin" size={27} aria-hidden="true" />
            <span className="placeholder-label">
              {illustrationGenerationStageText(illustrationGenerationStage)}
            </span>
          </div>
        ) : <div className="illustration-asset-summary"><ImagePlus size={18} aria-hidden="true" /><span>{illustration?.status === 'failed' ? '插画生成失败，可检查指令后重试' : '已保存视觉建议，等待你决定是否生成'}</span></div>}
        <figcaption>
          <div><strong>{message.title}</strong><span>{illustrationStatusText(illustration, imageProviderReady, referenceReason, illustrationGenerationStage)}</span></div>
          <div className="illustration-actions">
            {illustration && (illustration.status === 'failed' || illustration.status === 'planned') && !imageProviderReady && <button type="button" onClick={onOpenImageSettings}>配置图片模型</button>}
            {illustration && (illustration.status === 'failed' || illustration.status === 'planned') && imageProviderReady && referenceReason && (
              blockedCharacterReadyForConfirmation
                ? <button type="button" className="illustration-unlock-action" onClick={onOpenCharacterAssets}>去确认角色，解锁插画</button>
                : <button type="button" onClick={onOpenCharacterAssets}>查看角色资产</button>
            )}
            {illustration && illustration.status === 'failed' && canGenerate && <button type="button" onClick={() => void onRetryIllustration(illustration.id)}>重新生成</button>}
            {illustration && illustration.status === 'planned' && canGenerate && <button type="button" onClick={() => void onRetryIllustration(illustration.id)}>生成插画</button>}
            <button type="button" aria-expanded={showVisualPrompt} onClick={() => setShowVisualPrompt((value) => !value)}>视觉指令</button>
          </div>
        </figcaption>
        {showVisualPrompt && (
          <div className="visual-prompt">
            <strong>实际生图指令</strong>
            {directionItems.length ? (
              <dl className="visual-direction-list">
                {directionItems.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
              </dl>
            ) : <p>这条旧消息没有保存视觉指令。</p>}
            {referenceCharacters.length > 0 && (
              <p className="visual-reference-rule">
                人物参考：{referenceCharacters.map((character) => character.name).join('、')}。参考图固定身份与稳定外貌，动作、表情、视线和构图按本轮剧情重新设计。
              </p>
            )}
          </div>
        )}
      </figure>
    </div>
  )
}

function EditableUserMessage({ message, canEdit, onSave }: { message: ConversationMessage; canEdit?: boolean; onSave?: (message: ConversationMessage, text: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false)
  const effectiveText = message.pendingRevisionText ?? message.text ?? ''
  const [draft, setDraft] = useState(effectiveText)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const editTriggerRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { present: editorPresent, closing: editorClosing } = usePresence(editing, () => undefined, 220)

  useEffect(() => {
    setDraft(message.pendingRevisionText ?? message.text ?? '')
    if (!canEdit) setEditing(false)
  }, [canEdit, message.id, message.pendingRevisionText, message.text])

  useEffect(() => {
    if (!editing) return
    const focusTimer = window.setTimeout(() => {
      const textarea = textareaRef.current
      textarea?.focus()
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length)
    }, 0)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return
      event.preventDefault()
      closeEditor()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [editing, saving])

  function closeEditor() {
    if (saving) return
    setDraft(effectiveText)
    setError('')
    setEditing(false)
    window.setTimeout(() => editTriggerRef.current?.focus(), 240)
  }

  async function save() {
    const text = draft.trim()
    if (!text) {
      setError('内容不能为空')
      return
    }
    if (!onSave) return
    setSaving(true)
    setError('')
    try {
      if (await onSave(message, text)) {
        setEditing(false)
        window.setTimeout(() => editTriggerRef.current?.focus(), 240)
      }
      else setError('保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  const editor = editorPresent && createPortal(
    <div
      className={`user-message-edit-backdrop${editorClosing ? ' closing' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) closeEditor()
      }}
    >
      <section className="user-message-edit-sheet" role="dialog" aria-modal="true" aria-label="编辑已发送内容">
        <div className="user-message-edit-handle" aria-hidden="true" />
        <form className="user-message-edit-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <textarea ref={textareaRef} aria-label="编辑已发送内容" value={draft} disabled={saving} onChange={(event) => setDraft(event.target.value)} rows={5} />
          {error && <span className="user-message-edit-error" role="alert">{error}</span>}
          <div className="user-message-edit-sheet-actions">
            <button type="button" disabled={saving} onClick={closeEditor}>取消</button>
            <button className="primary" type="submit" disabled={saving}>
              {saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              {saving ? '保存中…' : '保存修改'}
            </button>
          </div>
        </form>
      </section>
    </div>,
    document.querySelector('.app-shell') ?? document.body,
  )

  return <>
    <div className="message-row user-row"><div className="user-message-stack">
      <div className="user-bubble">
        <div className="user-message-content"><span className="user-message-text">{effectiveText}</span>{message.pendingRevisionText && <span className="user-message-pending-revision">修改待重新生成，尚未应用</span>}</div>
      </div>
      {!editing && canEdit && <div className="user-message-actions" aria-label="消息操作">
        <button ref={editTriggerRef} className="user-message-edit-trigger" type="button" aria-label="编辑已发送内容" title="编辑已发送内容" onClick={() => setEditing(true)}><Pencil size={16} aria-hidden="true" /></button>
      </div>}
    </div>
    </div>
    {editor}
  </>
}

function FeedbackProse({ message, onRewriteParagraph, onApplyRewrite, onProseEvaluation, canRegenerate, writingCandidate, regenerationBusy, writingBusy, onRegenerateProse, onKeepOriginalProse, onAdoptCandidateProse, onAnalyzeFeedbackPreference }: { message: ConversationMessage; onRewriteParagraph?: (input: { message: ConversationMessage; paragraph: StoredParagraph; strength: RewriteStrength }) => Promise<string>; onApplyRewrite?: (input: { message: ConversationMessage; paragraph: StoredParagraph; rewrittenText: string }) => Promise<void>; onProseEvaluation?: (event: { type: 'analyzed' | 'rewrite_opened' | 'rewrite_kept_original'; message: ConversationMessage; paragraph: StoredParagraph }) => void; canRegenerate?: boolean; writingCandidate?: WritingCandidate; regenerationBusy?: boolean; writingBusy?: boolean; onRegenerateProse?: (message: ConversationMessage) => void; onKeepOriginalProse?: (message: ConversationMessage) => Promise<void>; onAdoptCandidateProse?: (message: ConversationMessage) => Promise<void>; onAnalyzeFeedbackPreference?: (input: { feedback: Feedback[]; verdict: FeedbackVerdict; reason?: string; targetTexts: string[] }) => Promise<void> }) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedVerdict, setSelectedVerdict] = useState<FeedbackVerdict>('up')
  const [storedParagraphs, setStoredParagraphs] = useState<StoredParagraph[]>([])
  const [rewriteParagraph, setRewriteParagraph] = useState<StoredParagraph>()

  const refreshFeedback = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setFeedback(await listMessageFeedback(message.projectId, message.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '反馈读取失败')
    } finally {
      setLoading(false)
    }
  }, [message.id, message.projectId])

  useEffect(() => {
    void refreshFeedback()
  }, [refreshFeedback])

  useEffect(() => {
    let cancelled = false
    void listMessageParagraphsWithCurrentStyleIssues(message.projectId, message.id).then((rows) => {
      if (!cancelled) { setStoredParagraphs(rows.sort((left, right) => left.index - right.index)); rows.forEach((paragraph) => onProseEvaluation?.({ type: 'analyzed', message, paragraph })) }
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [message])

  function openPanel(verdict: FeedbackVerdict) {
    setSelectedVerdict(verdict)
    setPanelOpen(true)
    void refreshFeedback()
  }

  return (
    <article className="story-prose">
      {message.paragraphs?.map((paragraph, index) => {
        const stored = storedParagraphs.find((item) => item.index === index && item.text === paragraph)
        const issueCount = stored?.styleIssues?.length ?? 0
        return <div className="prose-paragraph" key={`${message.id}-${index}`}><p>{paragraph}</p>{issueCount > 0 && <button className="prose-optimize-trigger" type="button" aria-label={`优化第 ${index + 1} 段，${issueCount} 个建议`} onClick={() => { if (stored) onProseEvaluation?.({ type: 'rewrite_opened', message, paragraph: stored }); setRewriteParagraph(stored) }}><WandSparkles size={14} />可优化 {issueCount}</button>}</div>
      })}
      <div className="message-feedback-actions" aria-label="正文反馈">
        <button
          className={`feedback-trigger ${feedback.some((item) => item.scope === 'message' && item.verdict === 'up') ? 'is-active' : ''}`}
          type="button"
          aria-label="点赞这条正文"
          title="点赞这条正文"
          onClick={() => openPanel('up')}
        ><ThumbsUp size={15} aria-hidden="true" />点赞</button>
        <button
          className={`feedback-trigger ${feedback.some((item) => item.scope === 'message' && item.verdict === 'down') ? 'is-active' : ''}`}
          type="button"
          aria-label="点踩这条正文"
          title="点踩这条正文"
          onClick={() => openPanel('down')}
        ><ThumbsDown size={15} aria-hidden="true" />点踩</button>
        {canRegenerate && onRegenerateProse && (
          <button className="feedback-trigger prose-regenerate-trigger" type="button" disabled={writingBusy} onClick={() => onRegenerateProse(message)}>
            {regenerationBusy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RefreshCcw size={15} aria-hidden="true" />}
            {regenerationBusy ? '生成中…' : '重新生成'}
          </button>
        )}
      </div>
      {writingCandidate && (
        <div className="writing-candidate-panel" role="dialog" aria-label="正文版本比较" aria-modal="false">
          <header><strong>比较最近一轮正文</strong><span>原版仍在使用，采用前不会覆盖</span></header>
          <div className="writing-candidate-comparison">
            <section><h4>原版</h4>{message.paragraphs?.map((paragraph, index) => <p key={`original-${index}`}>{paragraph}</p>)}</section>
            <section><h4>新版</h4>{writingCandidate.result.paragraphs.map((paragraph, index) => <p key={`candidate-${index}`}>{paragraph}</p>)}</section>
          </div>
          <footer>
            <button type="button" disabled={writingBusy} onClick={() => void onKeepOriginalProse?.(message)}>保留原版</button>
            <button className="primary" type="button" disabled={writingBusy} onClick={() => void onAdoptCandidateProse?.(message)}><Check size={16} aria-hidden="true" />采用新版</button>
          </footer>
        </div>
      )}
      {panelOpen && (
        <FeedbackPanel
          message={message}
          feedback={feedback}
          loading={loading}
          error={error}
          initialVerdict={selectedVerdict}
          onClose={() => setPanelOpen(false)}
          onSaved={setFeedback}
          refreshFeedback={refreshFeedback}
          onAnalyzeFeedbackPreference={onAnalyzeFeedbackPreference}
        />
      )}
      {rewriteParagraph && <RewritePanel message={message} paragraph={rewriteParagraph} onClose={() => { onProseEvaluation?.({ type: 'rewrite_kept_original', message, paragraph: rewriteParagraph }); setRewriteParagraph(undefined) }} onRewrite={onRewriteParagraph} onApply={async (rewrittenText) => { await onApplyRewrite?.({ message, paragraph: rewriteParagraph, rewrittenText }); setRewriteParagraph(undefined) }} />}
    </article>
  )
}

function RewritePanel({ message, paragraph, onClose, onRewrite, onApply }: { message: ConversationMessage; paragraph: StoredParagraph; onClose: () => void; onRewrite?: (input: { message: ConversationMessage; paragraph: StoredParagraph; strength: RewriteStrength }) => Promise<string>; onApply: (text: string) => Promise<void> }) {
  const [strength, setStrength] = useState<RewriteStrength>('balanced')
  const [suggestion, setSuggestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [applying, setApplying] = useState(false)
  const issues: ProseStyleIssue[] = paragraph.styleIssues ?? []
  async function generate() { if (!onRewrite) return; setBusy(true); setError(''); try { setSuggestion(await onRewrite({ message, paragraph, strength })) } catch (cause) { setError(cause instanceof Error ? cause.message : '建议稿生成失败') } finally { setBusy(false) } }
  return <div className="rewrite-panel" role="dialog" aria-label="段落优化建议">
    <header><strong>段落优化</strong><button className="feedback-close" type="button" aria-label="关闭段落优化" onClick={onClose}><X size={16} /></button></header>
    <div className="rewrite-issues">{issues.map((issue) => <span key={issue.ruleId}>{issue.explanation}</span>)}</div>
    <div className="rewrite-strength" role="radiogroup" aria-label="改写强度">{([['light','轻度'],['balanced','均衡'],['strong','强力']] as const).map(([value,label]) => <button key={value} type="button" role="radio" aria-checked={strength === value} disabled={busy || applying} onClick={() => { setStrength(value); setSuggestion(''); setError('') }}>{label}</button>)}</div>
    <div className="rewrite-comparison"><section><h4>原文</h4><p>{paragraph.text}</p></section><section><h4>建议稿</h4>{suggestion ? <p>{suggestion}</p> : <p className="feedback-hint">生成后会显示在这里。</p>}</section></div>
    {error && <p className="feedback-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy || applying} onClick={onClose}>保留原文</button>{suggestion ? <button className="primary" type="button" disabled={busy || applying} onClick={() => void (async () => { setApplying(true); setError(''); try { await onApply(suggestion) } catch (cause) { setError(cause instanceof Error ? cause.message : '建议稿应用失败') } finally { setApplying(false) } })()}>{applying ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{applying ? '应用中…' : '采用建议稿'}</button> : <button className="primary" type="button" disabled={busy || applying || !onRewrite} onClick={() => void generate()}>{busy ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}生成建议稿</button>}</footer>
  </div>
}

function FeedbackPanel({
  message,
  feedback,
  loading,
  error,
  initialVerdict,
  onClose,
  onSaved,
  refreshFeedback,
  onAnalyzeFeedbackPreference,
}: {
  message: ConversationMessage
  feedback: Feedback[]
  loading: boolean
  error: string
  initialVerdict: FeedbackVerdict
  onClose: () => void
  onSaved: (feedback: Feedback[]) => void
  refreshFeedback: () => Promise<void>
  onAnalyzeFeedbackPreference?: (input: { feedback: Feedback[]; verdict: FeedbackVerdict; reason?: string; targetTexts: string[] }) => Promise<void>
}) {
  const [scope, setScope] = useState<FeedbackScope>('message')
  const [paragraphIndexes, setParagraphIndexes] = useState<number[]>([])
  const [verdict, setVerdict] = useState<FeedbackVerdict>(initialVerdict)
  const [reason, setReason] = useState('')
  const [customNote, setCustomNote] = useState('')
  const [paragraphs, setParagraphs] = useState<ParagraphAnchor[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    setVerdict(initialVerdict)
  }, [initialVerdict])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const texts = Array.isArray(message.paragraphs) ? message.paragraphs : []
      try {
        const stored = await storyDatabase.paragraphs.where('[projectId+messageId]').equals([message.projectId, message.id]).toArray()
        const anchors = texts.map((text, index) => {
          const fingerprint = createParagraphFingerprint(text)
          const persisted = stored.find((row: StoredParagraph) => (
            row.projectId === message.projectId
              && row.messageId === message.id
              && row.chapterId === message.chapterId
              && row.index === index
              && row.text === text
              && row.fingerprint === fingerprint
          ))
          return { id: persisted?.id ?? `paragraph-message-${message.id}-${index}`, index, text, fingerprint }
        })
        if (!cancelled) setParagraphs(anchors)
      } catch {
        if (!cancelled) setParagraphs(texts.map((text, index) => ({ id: `paragraph-message-${message.id}-${index}`, index, text, fingerprint: createParagraphFingerprint(text) })))
      }
    })()
    return () => { cancelled = true }
  }, [message])

  const current = feedback.find((item) => item.scope === scope && (scope === 'message' || paragraphIndexes.includes(item.paragraphIndex ?? -1)))

  async function submit() {
    if (!message.chapterId) {
      setSaveError('当前正文缺少章节锚点，暂时无法提交反馈')
      return
    }
    const chapterId = message.chapterId
    if (scope === 'paragraph' && paragraphIndexes.length === 0) {
      setSaveError('请选择至少一个段落')
      return
    }
    const anchors = paragraphIndexes.map((index) => paragraphs.find((item) => item.index === index)).filter((item): item is ParagraphAnchor => Boolean(item))
    if (scope === 'paragraph' && anchors.length !== paragraphIndexes.length) {
      setSaveError('段落锚点无效，请重新打开反馈面板')
      return
    }
    setSaving(true)
    setSaveError('')
    let feedbackSaved = false
    try {
      const targets = scope === 'message'
        ? [{ projectId: message.projectId, messageId: message.id, chapterId: message.chapterId, scope }]
        : anchors.map((anchor) => ({
          projectId: message.projectId,
          messageId: message.id,
          chapterId,
          scope,
          paragraphId: anchor.id,
          paragraphIndex: anchor.index,
          paragraphFingerprint: anchor.fingerprint,
        }))
      const input = {
        targets,
        verdict,
        reason: reason || undefined,
        customNote: customNote.trim() || undefined,
      }
      const changed = await toggleFeedbackBatch(input)
      feedbackSaved = true
      await refreshFeedback()
      onSaved(await listMessageFeedback(message.projectId, message.id))
      if (changed.length === 0) {
        onClose()
        return
      }
      // A user-written note is already the authority. Store only a compact
      // future-facing instruction; the reviewed prose stays out of context.
      if (customNote.trim()) {
        const dimension = reason === '剧情方向' ? 'plot' : reason === '人物塑造' ? 'character' : reason === '节奏' ? 'pace' : reason === '语言表达' ? 'rhetoric' : 'description'
        await Promise.all(changed.map((item) => upsertPreferenceSignal({
          feedbackId: item.id, projectId: item.projectId, verdict: item.verdict, dimension,
          instruction: `后续写作：${customNote.trim()}`, source: 'user',
        })))
      } else {
        if (!onAnalyzeFeedbackPreference) throw new Error('反馈已经保存，但当前版本无法调用 AI 分析')
        await onAnalyzeFeedbackPreference({
          feedback: changed,
          verdict,
          reason: reason || undefined,
          targetTexts: scope === 'message' ? (message.paragraphs ?? []) : anchors.map((anchor) => anchor.text),
        })
      }
      onClose()
    } catch (cause) {
      const messageText = cause instanceof Error ? cause.message : '反馈提交失败，请稍后重试'
      setSaveError(feedbackSaved
        ? (messageText.includes('反馈已经保存') ? messageText : `反馈已经保存，但偏好分析未完成：${messageText}`)
        : messageText)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="feedback-panel" role="dialog" aria-label="正文反馈面板" aria-modal="false">
      <div className="feedback-panel-header"><strong>这段正文怎么样？</strong><button type="button" className="feedback-close" aria-label="关闭反馈面板" title="关闭" onClick={onClose}><X size={16} /></button></div>
      {loading && <p className="feedback-hint">正在读取已有反馈…</p>}
      {error && <p className="feedback-error" role="alert">{error}</p>}
      <div className="feedback-verdicts" role="group" aria-label="选择反馈类型">
        <button type="button" className={verdict === 'up' ? 'selected' : ''} onClick={() => setVerdict('up')}><ThumbsUp size={15} />点赞</button>
        <button type="button" className={verdict === 'down' ? 'selected' : ''} onClick={() => setVerdict('down')}><ThumbsDown size={15} />点踩</button>
      </div>
      <div className="feedback-scope" role="group" aria-label="反馈范围">
        <label><input type="radio" checked={scope === 'message'} onChange={() => { setScope('message'); setParagraphIndexes([]) }} />整条正文</label>
        <label><input type="radio" checked={scope === 'paragraph'} onChange={() => setScope('paragraph')} />仅针对某段</label>
      </div>
      {scope === 'paragraph' && <div className="feedback-paragraphs" role="listbox" aria-label="选择段落">
        {paragraphs.map((paragraph) => {
          const selected = paragraphIndexes.includes(paragraph.index)
          return <button key={paragraph.id} type="button" role="option" aria-selected={selected} className={selected ? 'selected' : ''} onClick={() => setParagraphIndexes((current) => selected ? current.filter((index) => index !== paragraph.index) : [...current, paragraph.index].sort((a, b) => a - b))}><span>第 {paragraph.index + 1} 段</span><small>{paragraph.text.slice(0, 44)}{paragraph.text.length > 44 ? '…' : ''}</small></button>
        })}
      </div>}
      <div className="feedback-reasons"><span>{verdict === 'up' ? '喜欢原因' : '点踩原因'}（可选）</span><div>{['剧情方向', '人物塑造', '节奏', '语言表达', '其他'].map((item) => <button key={item} type="button" className={reason === item ? 'selected' : ''} onClick={() => setReason(reason === item ? '' : item)}>{item}</button>)}</div></div>
      <label className="feedback-note">补充说明（可选）<textarea value={customNote} onChange={(event) => setCustomNote(event.target.value)} rows={2} placeholder="告诉我们更多想法…" /></label>
      {!customNote.trim() && <p className="feedback-hint">提交后会调用 1 次文本模型分析写作偏好，可能产生费用；失败不会自动重试，原始反馈仍会保留。</p>}
      {current && <p className="feedback-hint">当前已{current.verdict === 'up' ? '点赞' : '点踩'}，再次提交相同选项将撤销。</p>}
      {saveError && <p className="feedback-error" role="alert">{saveError}</p>}
      <div className="feedback-panel-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={saving} onClick={() => void submit()}>{saving ? '提交中…' : customNote.trim() ? '提交反馈' : 'AI 分析并提交'}</button></div>
    </div>
  )
}
