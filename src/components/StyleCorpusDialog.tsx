import { useEffect, useMemo, useState } from 'react'
import { BookText, LoaderCircle, Sparkles, Trash2, X } from 'lucide-react'
import {
  createStyleCorpusDraftFragments,
  deleteStyleCorpusSource,
  listStyleCorpusFragments,
  listStyleCorpusSources,
  saveStyleCorpusImport,
  splitStyleCorpusText,
} from '../data/storyDatabase'
import type { StyleCorpusFragment, StyleCorpusLabels, StyleCorpusSource } from '../domain/models'
import { suggestStyleCorpusLabels } from '../providers/writing'
import type { HttpTransport, ProviderConfig } from '../providers/types'

type Draft = ReturnType<typeof createStyleCorpusDraftFragments>[number]

const labelText = (labels: StyleCorpusLabels) => [...labels.genres, ...labels.sceneTypes, ...labels.techniques].join('、')
const parseTags = (value: string) => value.split(/[，,、]/).map((item) => item.trim()).filter(Boolean)

export default function StyleCorpusDialog({
  open, textProvider, transport, onClose, onChanged, onEvaluation,
}: {
  open: boolean
  textProvider: ProviderConfig
  transport: HttpTransport
  onClose: () => void
  onChanged: () => void
  onEvaluation?: (event: { type: 'imported' | 'deleted'; fragmentCount?: number }) => void
}) {
  const [sources, setSources] = useState<StyleCorpusSource[]>([])
  const [fragments, setFragments] = useState<StyleCorpusFragment[]>([])
  const [title, setTitle] = useState('')
  const [rawText, setRawText] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deletingSourceId, setDeletingSourceId] = useState<string>()

  const fragmentCountBySource = useMemo(() => fragments.reduce((map, fragment) => map.set(fragment.sourceId, (map.get(fragment.sourceId) ?? 0) + 1), new Map<string, number>()), [fragments])
  const refresh = async () => {
    const [nextSources, nextFragments] = await Promise.all([listStyleCorpusSources(), listStyleCorpusFragments()])
    setSources(nextSources); setFragments(nextFragments)
  }
  useEffect(() => { if (open) void refresh() }, [open])
  useEffect(() => { setDrafts(rawText.trim() ? createStyleCorpusDraftFragments(rawText) : []) }, [rawText])
  if (!open) return null

  const updateLabels = (index: number, patch: Partial<StyleCorpusLabels>) => setDrafts((current) => current.map((draft, itemIndex) => itemIndex === index ? { ...draft, labels: { ...draft.labels, ...patch } } : draft))

  async function suggest() {
    setBusy(true); setError('')
    try {
      const paragraphs = splitStyleCorpusText(rawText)
      const suggestions = await suggestStyleCorpusLabels(paragraphs, textProvider, transport)
      const byId = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]))
      setDrafts(suggestions.map((suggestion) => {
        const selected = suggestion.paragraphIds.map((id) => byId.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
        const text = selected.map((item) => item.text).join('\n\n')
        return { id: `import-fragment-${selected[0]?.fingerprint ?? Math.random()}`, paragraphIds: suggestion.paragraphIds, text, fingerprint: selected.map((item) => item.fingerprint).join(':'), labels: suggestion.labels }
      }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'AI 整理失败，可继续手动保存') }
    finally { setBusy(false) }
  }

  async function save() {
    setBusy(true); setError('')
    try {
      const saved = await saveStyleCorpusImport({ title, rawText, fragments: drafts.map((draft) => ({ ...draft, suggestedLabels: draft.labels })) })
      onEvaluation?.({ type: 'imported', fragmentCount: saved.fragments.length })
      setTitle(''); setRawText(''); setDrafts([]); await refresh(); onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '语料保存失败') }
    finally { setBusy(false) }
  }

  async function removeSource(source: StyleCorpusSource) {
    setDeletingSourceId(source.id); setError('')
    try { await deleteStyleCorpusSource(source.id); onEvaluation?.({ type: 'deleted' }); await refresh(); onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '语料删除失败') }
    finally { setDeletingSourceId(undefined) }
  }

  return <div className="settings-backdrop style-corpus-backdrop" role="presentation">
    <section className="style-corpus-dialog" role="dialog" aria-modal="true" aria-labelledby="style-corpus-title">
      <header className="drawer-header"><div><h2 id="style-corpus-title">风格语料库</h2><p>{sources.length} 个来源 · {fragments.length} 个片段</p></div><button className="icon-button" type="button" aria-label="关闭风格语料库" onClick={onClose}><X size={20} /></button></header>
      <div className="style-corpus-content">
        <section className="style-corpus-import">
          <label>来源名称<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：我喜欢的悬疑对白" /></label>
          <label>导入正文<textarea rows={8} value={rawText} onChange={(event) => setRawText(event.target.value)} placeholder="粘贴你有权使用的文本。应用会按自然段拆分，AI 只建议分组和标签。" /></label>
          <div className="style-corpus-toolbar"><button type="button" disabled={busy || !rawText.trim()} onClick={() => void suggest()}><Sparkles size={17} />AI 辅助整理</button><button className="primary-button" type="button" disabled={busy || !drafts.length} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={17} /> : <BookText size={17} />}确认入库</button></div>
          {error && <p className="feedback-error" role="alert">{error}</p>}
          {drafts.length > 0 && <div className="style-corpus-drafts" aria-label="待确认语料片段">{drafts.map((draft, index) => <article key={draft.id}>
            <p>{draft.text}</p>
            <label>题材与场景<input aria-label={`第 ${index + 1} 个片段的题材与场景`} value={[...draft.labels.genres, ...draft.labels.sceneTypes].join('、')} onChange={(event) => updateLabels(index, { genres: parseTags(event.target.value), sceneTypes: [] })} /></label>
            <label>希望模仿<input aria-label={`第 ${index + 1} 个片段希望模仿`} value={draft.labels.imitate.join('、')} onChange={(event) => updateLabels(index, { imitate: parseTags(event.target.value) })} /></label>
            <label>避免模仿<input aria-label={`第 ${index + 1} 个片段避免模仿`} value={draft.labels.avoid.join('、')} onChange={(event) => updateLabels(index, { avoid: parseTags(event.target.value) })} /></label>
          </article>)}</div>}
        </section>
        <section className="style-corpus-library"><h3>已保存来源</h3>{sources.length ? sources.map((source) => <div className="style-corpus-source" key={source.id}><span><strong>{source.title}</strong><small>{fragmentCountBySource.get(source.id) ?? 0} 个片段 · {labelText(fragments.find((item) => item.sourceId === source.id)?.labels ?? { genres: [], sceneTypes: [], pace: [], techniques: [], emotionalTone: [], imitate: [], avoid: [] }) || '未标注'}</small></span><button type="button" disabled={Boolean(deletingSourceId)} aria-label={`删除语料来源${source.title}`} onClick={() => void removeSource(source)}>{deletingSourceId === source.id ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}</button></div>) : <p className="settings-help">还没有导入语料。</p>}</section>
      </div>
    </section>
  </div>
}
