import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ImagePlus, LoaderCircle, Pencil, RefreshCw, Save, UserPlus, X } from 'lucide-react'
import type { CharacterAsset, NarrativePronoun, ReferenceStyleMode } from '../domain/models'
import { resolveImageSource } from '../providers/imageAssetStore'
import { usePresence } from '../hooks/usePresence'

interface Props {
  open: boolean
  characters: CharacterAsset[]
  onClose: () => void
  onGenerate: (characterId: string, feedback?: string) => Promise<void>
  onConfirm: (characterId: string) => Promise<void>
  onReferenceStyleModeChange: (characterId: string, referenceStyleMode: ReferenceStyleMode) => Promise<void>
  onUpdateProfile: (characterId: string, profile: { narrativePronoun?: NarrativePronoun; ageAndBuild: string; fixedTraits: string[]; defaultLook: string; wardrobe: string }) => Promise<void>
  onAnalyzeReference: (characterId: string) => Promise<void>
  onCreateCharacter: () => void
  onCancelGeneration: () => void
  generationActive: boolean
}

interface ProfileDraft {
  narrativePronoun?: NarrativePronoun
  ageAndBuild: string
  fixedTraitsText: string
  defaultLook: string
  wardrobe: string
}

export default function CharacterAssetsDrawer({ open, characters, onClose, onGenerate, onConfirm, onReferenceStyleModeChange, onUpdateProfile, onAnalyzeReference, onCreateCharacter, onCancelGeneration, generationActive }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [feedbackCharacterId, setFeedbackCharacterId] = useState<string>()
  const [feedback, setFeedback] = useState('')
  const [editingCharacterId, setEditingCharacterId] = useState<string>()
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>()
  const [savingProfile, setSavingProfile] = useState(false)
  const [pendingPortraits, setPendingPortraits] = useState<Record<string, 'portrait' | 'revision'>>({})
  const [analyzingCharacterId, setAnalyzingCharacterId] = useState<string>()
  const [analysisNotice, setAnalysisNotice] = useState<Record<string, { kind: 'success' | 'error'; text: string }>>({})
  const analysisNoticeTimerRef = useRef<number | undefined>(undefined)
  const { present, closing } = usePresence(open, onClose, 180)

  useEffect(() => {
    const timerId = analysisNoticeTimerRef.current
    return () => { if (timerId !== undefined) window.clearTimeout(timerId) }
  }, [])

  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  if (!present) return null

  function startEditing(character: CharacterAsset) {
    setEditingCharacterId(character.id)
    setProfileDraft({
      narrativePronoun: character.narrativePronoun,
      ageAndBuild: character.identity.ageAndBuild ?? '',
      fixedTraitsText: character.identity.fixedTraits.join('、'),
      defaultLook: character.appearance.defaultLook ?? '',
      wardrobe: character.appearance.wardrobe ?? '',
    })
  }

  async function saveProfile(characterId: string) {
    if (!profileDraft || savingProfile) return
    setSavingProfile(true)
    try {
      await onUpdateProfile(characterId, {
        narrativePronoun: profileDraft.narrativePronoun,
        ageAndBuild: profileDraft.ageAndBuild,
        fixedTraits: profileDraft.fixedTraitsText.split(/[、,，]/).map((trait) => trait.trim()).filter(Boolean),
        defaultLook: profileDraft.defaultLook,
        wardrobe: profileDraft.wardrobe,
      })
      setEditingCharacterId(undefined)
      setProfileDraft(undefined)
    } finally {
      setSavingProfile(false)
    }
  }

  async function requestPortrait(characterId: string, feedbackText?: string) {
    if (pendingPortraits[characterId]) return
    const kind = feedbackText ? 'revision' : 'portrait'
    setPendingPortraits((value) => ({ ...value, [characterId]: kind }))
    try {
      await onGenerate(characterId, feedbackText)
      if (kind === 'revision') {
        setFeedbackCharacterId(undefined)
        setFeedback('')
      }
    } catch {
      // The persisted portrait error is rendered on the asset; keep revision input intact for retry.
    } finally {
      setPendingPortraits((value) => {
        const { [characterId]: _completed, ...rest } = value
        return rest
      })
    }
  }

  async function analyzeReference(characterId: string) {
    if (analyzingCharacterId) return
    if (analysisNoticeTimerRef.current !== undefined) window.clearTimeout(analysisNoticeTimerRef.current)
    setAnalyzingCharacterId(characterId)
    setAnalysisNotice((value) => {
      const { [characterId]: _cleared, ...rest } = value
      return rest
    })
    try {
      await onAnalyzeReference(characterId)
      setAnalysisNotice((value) => ({ ...value, [characterId]: { kind: 'success', text: '外貌档案已更新，请核对后再次确认' } }))
      analysisNoticeTimerRef.current = window.setTimeout(() => {
        analysisNoticeTimerRef.current = undefined
        setAnalysisNotice((value) => {
          const { [characterId]: _expired, ...rest } = value
          return rest
        })
      }, 4000)
    } catch (error) {
      setAnalysisNotice((value) => ({ ...value, [characterId]: { kind: 'error', text: error instanceof Error ? error.message : '外貌识别失败，请手动补充档案' } }))
    } finally {
      setAnalyzingCharacterId(undefined)
    }
  }

  return (
    <div className={`asset-backdrop${closing ? ' closing' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <aside className="asset-drawer" role="dialog" aria-modal="true" aria-labelledby="character-assets-title">
        <header className="drawer-header">
          <div>
            <h2 id="character-assets-title">角色资产</h2>
            <p>定妆照确认后才会用于剧情插画</p>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭角色资产" onClick={onClose}><X size={20} /></button>
        </header>

        <div className="character-assets-list">
          <div className="asset-toolbar">
            <button className="quiet-button" type="button" onClick={onCreateCharacter}><UserPlus size={16} />新建角色</button>
            {generationActive && <button className="quiet-button danger" type="button" onClick={onCancelGeneration}>停止后续生成</button>}
          </div>
          {characters.length === 0 && (
            <div className="empty-assets"><UserPlus size={28} /><h3>还没有角色</h3><p>可主动创建角色；写作模型识别到新角色后也会记录在这里。</p></div>
          )}
          {characters.map((character) => {
            const status = character.portraitStatus ?? (character.status === 'confirmed' ? 'confirmed' : 'planned')
            const isFeedbackOpen = feedbackCharacterId === character.id
            const pendingPortrait = pendingPortraits[character.id]
            const portraitGenerating = status === 'generating' || Boolean(pendingPortrait)
            const referenceStyleMode = character.continuity.referenceStyleMode ?? 'project'
            const analyzing = analyzingCharacterId === character.id
            const analysisResult = analysisNotice[character.id]
            return (
              <article className="character-asset" key={character.id} aria-busy={portraitGenerating || undefined}>
                <div className="portrait-frame">
                  {character.continuity.referenceImageUrl || character.continuity.localUri ? (
                    <img src={resolveImageSource(character.continuity.referenceImageUrl, character.continuity.localUri)} alt={`${character.name}定妆照候选`} />
                  ) : portraitGenerating ? (
                    <div className="portrait-state"><LoaderCircle className="spin" size={25} /><span>正在生成定妆照…</span></div>
                  ) : (
                    <div className="portrait-state"><ImagePlus size={25} /><span>{status === 'failed' ? '本次生成失败' : '尚未生成定妆照'}</span></div>
                  )}
                </div>

                <div className="character-copy">
                  <header><div><h3>{character.name}</h3><p>{character.role}</p></div><span className={`asset-status ${portraitGenerating ? 'generating' : status}`} role="status" aria-live="polite">{statusLabel(portraitGenerating ? 'generating' : status)}</span></header>
                  {editingCharacterId === character.id && profileDraft ? (
                    <form className="character-profile-editor" onSubmit={(event) => {
                      event.preventDefault()
                      void saveProfile(character.id)
                    }}>
                      <fieldset className="pronoun-choice" disabled={savingProfile}>
                        <legend>叙事代词</legend>
                        <div role="radiogroup" aria-label="叙事代词">
                          {([
                            [undefined, '未选择'],
                            ['she', '她'],
                            ['he', '他'],
                            ['ta', 'TA'],
                            ['name', '仅使用姓名'],
                          ] as const).map(([value, label]) => (
                            <button
                              key={value ?? 'unset'}
                              type="button"
                              role="radio"
                              aria-checked={profileDraft.narrativePronoun === value}
                              onClick={() => setProfileDraft({ ...profileDraft, narrativePronoun: value })}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </fieldset>
                      <label>
                        <span>身份锚点</span>
                        <input value={profileDraft.ageAndBuild} placeholder="年龄感与体型" onChange={(event) => setProfileDraft({ ...profileDraft, ageAndBuild: event.target.value })} />
                      </label>
                      <label>
                        <span>固定特征</span>
                        <input value={profileDraft.fixedTraitsText} placeholder="用顿号分隔，例如：左耳垂痣、深棕色卷发" onChange={(event) => setProfileDraft({ ...profileDraft, fixedTraitsText: event.target.value })} />
                      </label>
                      <label>
                        <span>默认外貌</span>
                        <input value={profileDraft.defaultLook} placeholder="发型、五官与常态气质" onChange={(event) => setProfileDraft({ ...profileDraft, defaultLook: event.target.value })} />
                      </label>
                      <label>
                        <span>当前服装</span>
                        <input value={profileDraft.wardrobe} placeholder="按剧情描述服装" onChange={(event) => setProfileDraft({ ...profileDraft, wardrobe: event.target.value })} />
                      </label>
                      <p className="profile-editor-hint">修改会用于之后的定妆照与剧情插画；已有参考图时，人脸仍以参考图为准。</p>
                      <div className="profile-editor-actions">
                        <button className="quiet-button" type="button" disabled={savingProfile} onClick={() => {
                          setEditingCharacterId(undefined)
                          setProfileDraft(undefined)
                        }}>取消</button>
                        <button className="confirm-asset-button" type="submit" disabled={savingProfile}>
                          {savingProfile ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}保存档案
                        </button>
                      </div>
                    </form>
                  ) : (
                    <dl>
                      <div><dt>叙事代词</dt><dd>{pronounLabel(character.narrativePronoun)}</dd></div>
                      <div><dt>身份锚点</dt><dd>{character.identity.ageAndBuild || '待补充'}</dd></div>
                      <div><dt>固定特征</dt><dd>{character.identity.fixedTraits.join('、') || '待补充'}</dd></div>
                      <div><dt>默认外貌</dt><dd>{character.appearance.defaultLook || '待补充'}</dd></div>
                      <div><dt>当前服装</dt><dd>{character.appearance.wardrobe || '待补充'}</dd></div>
                    </dl>
                  )}
                  <button
                    className="edit-profile-button"
                    type="button"
                    aria-label={`编辑角色 ${character.name} 的档案`}
                    onClick={() => editingCharacterId === character.id ? undefined : startEditing(character)}
                  >
                    <Pencil size={14} />编辑档案
                  </button>
                  {status === 'failed' && <p className="asset-error" role="alert">{character.portraitError}</p>}

                  {(character.continuity.referenceImageUrl || character.continuity.localUri) && (
                    <div className="asset-reference-style">
                      <span>参考图画风</span>
                      <div role="radiogroup" aria-label={`${character.name}的参考图画风`}>
                        <button type="button" role="radio" aria-checked={referenceStyleMode === 'project'} onClick={() => void onReferenceStyleModeChange(character.id, 'project')}>统一为作品画风</button>
                        <button type="button" role="radio" aria-checked={referenceStyleMode === 'reference'} onClick={() => void onReferenceStyleModeChange(character.id, 'reference')}>保留图片画风</button>
                      </div>
                      <p>{referenceStyleMode === 'project'
                        ? '后续插画只参考外貌，并统一转换为作品画风。'
                        : '后续插画会保留该角色参考图的原有画风。'}</p>
                      <button className="quiet-button" type="button" disabled={analyzing} aria-busy={analyzing} onClick={() => void analyzeReference(character.id)}>
                        {analyzing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                        {analyzing ? '正在识别外貌…' : '识别参考图'}
                      </button>
                      {analysisResult && (
                        <p className={`asset-analysis-note ${analysisResult.kind}`} role={analysisResult.kind === 'error' ? 'alert' : 'status'}>
                          {analysisResult.kind === 'success' && <CheckCircle2 size={13} aria-hidden="true" />}
                          {analysisResult.text}
                        </p>
                      )}
                    </div>
                  )}

                  {status === 'review' && !isFeedbackOpen && (
                    <div className="asset-actions">
                      <button className="confirm-asset-button" type="button" disabled={!character.narrativePronoun} title={!character.narrativePronoun ? '请先补充叙事代词' : undefined} onClick={() => void onConfirm(character.id)}><CheckCircle2 size={17} />确认并作为参考</button>
                      <button className="quiet-button" type="button" onClick={() => {
                        setFeedbackCharacterId(character.id)
                        setFeedback('')
                      }}>不满意，生成优化版</button>
                    </div>
                  )}

                  {isFeedbackOpen && (
                    <form className="portrait-feedback" onSubmit={(event) => {
                      event.preventDefault()
                      if (!feedback.trim() || pendingPortrait) return
                      void requestPortrait(character.id, feedback.trim())
                    }}>
                      <label htmlFor={`portrait-feedback-${character.id}`}>具体哪里不满意？</label>
                      <textarea
                        id={`portrait-feedback-${character.id}`}
                        rows={3}
                        value={feedback}
                        disabled={Boolean(pendingPortrait)}
                        placeholder="例如：发型更利落，年龄年轻两三岁，保留眼下小痣和大衣。"
                        onChange={(event) => setFeedback(event.target.value)}
                      />
                      <div><button className="quiet-button" type="button" disabled={Boolean(pendingPortrait)} onClick={() => setFeedbackCharacterId(undefined)}>取消</button><button className="confirm-asset-button" type="submit" disabled={!feedback.trim() || Boolean(pendingPortrait)}>{pendingPortrait ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}{pendingPortrait === 'revision' ? '正在生成优化版' : '生成优化版'}</button></div>
                    </form>
                  )}

                  {(status === 'planned' || status === 'failed') && (
                    <button className="confirm-asset-button full-width" type="button" disabled={Boolean(pendingPortrait)} onClick={() => void requestPortrait(character.id)}>
                      {pendingPortrait ? <LoaderCircle className="spin" size={17} /> : status === 'failed' ? <RefreshCw size={17} /> : <ImagePlus size={17} />}
                      {pendingPortrait ? '正在生成定妆照' : status === 'failed' ? '手动重试定妆照' : '生成定妆照'}
                    </button>
                  )}

                  {status === 'confirmed' && <p className="confirmed-note"><CheckCircle2 size={16} />后续插画会自动参考这张定妆照</p>}
                </div>
              </article>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

function statusLabel(status: CharacterAsset['portraitStatus']) {
  if (status === 'generating') return '生成中'
  if (status === 'review') return '待确认'
  if (status === 'failed') return '失败'
  if (status === 'confirmed') return '已确认'
  return '待生成'
}

function pronounLabel(pronoun: NarrativePronoun | undefined) {
  if (pronoun === 'she') return '她'
  if (pronoun === 'he') return '他'
  if (pronoun === 'ta') return 'TA'
  if (pronoun === 'name') return '仅使用姓名'
  return '待补充'
}
