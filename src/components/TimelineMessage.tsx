import { useCallback, useEffect, useState } from 'react'
import { ImagePlus, LoaderCircle, Maximize2, Sparkles, ThumbsDown, ThumbsUp, TriangleAlert, X } from 'lucide-react'
import { listMessageFeedback, storyDatabase, toggleFeedback } from '../data/storyDatabase'
import type { CharacterAsset, ConversationMessage, Feedback, FeedbackScope, FeedbackVerdict, IllustrationAsset, StoredParagraph } from '../domain/models'
import { createParagraphFingerprint } from '../domain/paragraphs'
import { resolveImageSource } from '../providers/imageAssetStore'

type ParagraphAnchor = {
  id: string
  index: number
  text: string
  fingerprint: string
}

function characterHasConfirmedReference(character: CharacterAsset | undefined) {
  return Boolean(
    character
      && character.status === 'confirmed'
      && (character.continuity.referenceImageUrl || character.continuity.localUri),
  )
}

function illustrationReferencesReady(illustration: IllustrationAsset, characters: CharacterAsset[]) {
  return illustration.referenceCharacterIds.every((characterId) => (
    characterHasConfirmedReference(characters.find((character) => character.id === characterId))
  ))
}

function illustrationStatusText(illustration: IllustrationAsset | undefined, imageProviderReady: boolean, referencesReady: boolean) {
  if (!illustration) return '自动插画 · 等待生成'
  if (illustration.status === 'generating') return '自动插画 · 正在生成'
  if (illustration.status === 'ready') return '自动插画 · 已保存'
  if (illustration.status === 'failed') return `自动插画 · ${illustration.errorMessage || '生成失败'}`
  if (!imageProviderReady) return '自动插画 · 等待配置图片模型'
  if (!referencesReady) return '自动插画 · 等待角色定妆照'
  return '自动插画 · 等待手动生成'
}

export default function TimelineMessage({
  message,
  illustration,
  onRetryIllustration,
  imageProviderReady,
  onOpenImageSettings,
  characters,
  onOpenCharacterAssets,
  onOpenIllustration,
}: {
  message: ConversationMessage
  illustration?: IllustrationAsset
  onRetryIllustration: (illustrationId: string) => Promise<void>
  imageProviderReady: boolean
  onOpenImageSettings: () => void
  characters: CharacterAsset[]
  onOpenCharacterAssets: () => void
  onOpenIllustration: (source: string, title: string, alt: string, localUri?: string) => void
}) {
  const [showVisualPrompt, setShowVisualPrompt] = useState(false)
  const referencesReady = Boolean(illustration && illustrationReferencesReady(illustration, characters))
  const canGenerate = Boolean(illustration && imageProviderReady && referencesReady && (illustration.status === 'planned' || illustration.status === 'failed'))
  const imageSource = illustration ? resolveImageSource(illustration.imageUrl, illustration.localUri) : undefined

  if (message.kind === 'user') {
    return <div className="message-row user-row"><div className="user-bubble">{message.text}</div></div>
  }

  if (message.kind === 'notice') {
    return (
      <div className="message-row assistant-row notice-indent">
        <div className={`assistant-notice ${message.status ?? 'ready'}`} role={message.status === 'failed' ? 'alert' : 'status'}>
          {message.status === 'pending'
            ? <LoaderCircle className="spin" size={14} />
            : message.status === 'failed'
              ? <TriangleAlert size={14} />
              : <Sparkles size={14} />}
          {message.text}
        </div>
      </div>
    )
  }

  if (message.kind === 'prose') return <FeedbackProse message={message} />

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
        ) : (
          <div className="illustration-placeholder" role="img" aria-label={`${message.title ?? '剧情'}插画生成占位图`}>
            {illustration?.status === 'generating' ? <LoaderCircle className="spin" size={27} aria-hidden="true" /> : <ImagePlus size={27} aria-hidden="true" />}
            <span className="placeholder-label">
              {illustration?.status === 'generating'
                ? '正在生成图片…'
                : !imageProviderReady
                   ? '请先配置图片模型'
                   : !referencesReady
                     ? '请先确认角色定妆照'
                     : '点击下方按钮生成插画'}
            </span>
          </div>
        )}
        <figcaption>
          <div><strong>{message.title}</strong><span>{illustrationStatusText(illustration, imageProviderReady, referencesReady)}</span></div>
          <div className="illustration-actions">
            {illustration && (illustration.status === 'failed' || illustration.status === 'planned') && !imageProviderReady && <button type="button" onClick={onOpenImageSettings}>配置图片模型</button>}
            {illustration && (illustration.status === 'failed' || illustration.status === 'planned') && imageProviderReady && !referencesReady && <button type="button" onClick={onOpenCharacterAssets}>查看角色资产</button>}
            {illustration && illustration.status === 'failed' && canGenerate && <button type="button" onClick={() => void onRetryIllustration(illustration.id)}>重新生成</button>}
            {illustration && illustration.status === 'planned' && canGenerate && <button type="button" onClick={() => void onRetryIllustration(illustration.id)}>生成插画</button>}
            <button type="button" aria-expanded={showVisualPrompt} onClick={() => setShowVisualPrompt((value) => !value)}>视觉指令</button>
          </div>
        </figcaption>
        {showVisualPrompt && <div className="visual-prompt"><strong>本轮画面描述</strong><p>{illustration?.prompt || '这条旧消息没有保存视觉指令。'}</p></div>}
      </figure>
    </div>
  )
}

function FeedbackProse({ message }: { message: ConversationMessage }) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedVerdict, setSelectedVerdict] = useState<FeedbackVerdict>('up')

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

  function openPanel(verdict: FeedbackVerdict) {
    setSelectedVerdict(verdict)
    setPanelOpen(true)
    void refreshFeedback()
  }

  return (
    <article className="story-prose">
      {message.paragraphs?.map((paragraph, index) => <p key={`${message.id}-${index}`}>{paragraph}</p>)}
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
      </div>
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
        />
      )}
    </article>
  )
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
}: {
  message: ConversationMessage
  feedback: Feedback[]
  loading: boolean
  error: string
  initialVerdict: FeedbackVerdict
  onClose: () => void
  onSaved: (feedback: Feedback[]) => void
  refreshFeedback: () => Promise<void>
}) {
  const [scope, setScope] = useState<FeedbackScope>('message')
  const [paragraphIndex, setParagraphIndex] = useState<number>()
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

  const current = feedback.find((item) => item.scope === scope && (scope === 'message' || item.paragraphIndex === paragraphIndex))

  async function submit() {
    if (!message.chapterId) {
      setSaveError('当前正文缺少章节锚点，暂时无法提交反馈')
      return
    }
    if (scope === 'paragraph' && paragraphIndex === undefined) {
      setSaveError('请选择一个段落')
      return
    }
    const anchor = paragraphIndex === undefined ? undefined : paragraphs.find((item) => item.index === paragraphIndex)
    if (scope === 'paragraph' && !anchor) {
      setSaveError('段落锚点无效，请重新打开反馈面板')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const input = {
        projectId: message.projectId,
        messageId: message.id,
        chapterId: message.chapterId,
        scope,
        ...(anchor ? { paragraphId: anchor.id, paragraphIndex: anchor.index, paragraphFingerprint: anchor.fingerprint } : {}),
        verdict,
        reason: reason || undefined,
        customNote: customNote.trim() || undefined,
      }
      const next = await toggleFeedback(input)
      await refreshFeedback()
      if (next === null) await refreshFeedback()
      onSaved(await listMessageFeedback(message.projectId, message.id))
      onClose()
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : '反馈提交失败，请稍后重试')
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
        <label><input type="radio" checked={scope === 'message'} onChange={() => { setScope('message'); setParagraphIndex(undefined) }} />整条正文</label>
        <label><input type="radio" checked={scope === 'paragraph'} onChange={() => setScope('paragraph')} />仅针对某段</label>
      </div>
      {scope === 'paragraph' && <div className="feedback-paragraphs" role="listbox" aria-label="选择段落">
        {paragraphs.map((paragraph) => <button key={paragraph.id} type="button" role="option" aria-selected={paragraphIndex === paragraph.index} className={paragraphIndex === paragraph.index ? 'selected' : ''} onClick={() => setParagraphIndex(paragraph.index)}><span>第 {paragraph.index + 1} 段</span><small>{paragraph.text.slice(0, 44)}{paragraph.text.length > 44 ? '…' : ''}</small></button>)}
      </div>}
      {verdict === 'down' && <div className="feedback-reasons"><span>点踩原因（可选）</span><div>{['剧情方向', '人物塑造', '节奏', '语言表达', '其他'].map((item) => <button key={item} type="button" className={reason === item ? 'selected' : ''} onClick={() => setReason(reason === item ? '' : item)}>{item}</button>)}</div></div>}
      <label className="feedback-note">补充说明（可选）<textarea value={customNote} onChange={(event) => setCustomNote(event.target.value)} rows={2} placeholder="告诉我们更多想法…" /></label>
      {current && <p className="feedback-hint">当前已{current.verdict === 'up' ? '点赞' : '点踩'}，再次提交相同选项将撤销。</p>}
      {saveError && <p className="feedback-error" role="alert">{saveError}</p>}
      <div className="feedback-panel-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={saving} onClick={() => void submit()}>{saving ? '提交中…' : '提交反馈'}</button></div>
    </div>
  )
}
