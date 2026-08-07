import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ImagePlus, LoaderCircle, RefreshCw, UserRound, X } from 'lucide-react'
import type { CharacterAsset, ReferenceStyleMode } from '../domain/models'
import { resolveImageSource } from '../providers/imageAssetStore'
import { usePresence } from '../hooks/usePresence'

interface Props {
  open: boolean
  characters: CharacterAsset[]
  onClose: () => void
  onGenerate: (characterId: string, feedback?: string) => Promise<void>
  onConfirm: (characterId: string) => Promise<void>
  onReferenceStyleModeChange: (characterId: string, referenceStyleMode: ReferenceStyleMode) => Promise<void>
}

export default function CharacterAssetsDrawer({ open, characters, onClose, onGenerate, onConfirm, onReferenceStyleModeChange }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [feedbackCharacterId, setFeedbackCharacterId] = useState<string>()
  const [feedback, setFeedback] = useState('')
  const { present, closing } = usePresence(open, onClose, 180)

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
          {characters.length === 0 && (
            <div className="empty-assets"><UserRound size={28} /><h3>还没有角色</h3><p>写作模型识别出新角色后，会在这里建立独立资产。</p></div>
          )}
          {characters.map((character) => {
            const status = character.portraitStatus ?? (character.status === 'confirmed' ? 'confirmed' : 'planned')
            const isFeedbackOpen = feedbackCharacterId === character.id
            const referenceStyleMode = character.continuity.referenceStyleMode ?? 'project'
            return (
              <article className="character-asset" key={character.id}>
                <div className="portrait-frame">
                  {character.continuity.referenceImageUrl || character.continuity.localUri ? (
                    <img src={resolveImageSource(character.continuity.referenceImageUrl, character.continuity.localUri)} alt={`${character.name}定妆照候选`} />
                  ) : status === 'generating' ? (
                    <div className="portrait-state"><LoaderCircle className="spin" size={25} /><span>正在生成定妆照…</span></div>
                  ) : (
                    <div className="portrait-state"><ImagePlus size={25} /><span>{status === 'failed' ? '本次生成失败' : '尚未生成定妆照'}</span></div>
                  )}
                </div>

                <div className="character-copy">
                  <header><div><h3>{character.name}</h3><p>{character.role}</p></div><span className={`asset-status ${status}`}>{statusLabel(status)}</span></header>
                  <dl>
                    <div><dt>身份锚点</dt><dd>{character.identity.ageAndBuild || '待补充'}</dd></div>
                    <div><dt>固定特征</dt><dd>{character.identity.fixedTraits.join('、') || '待补充'}</dd></div>
                    <div><dt>当前服装</dt><dd>{character.appearance.wardrobe || '待补充'}</dd></div>
                  </dl>
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
                    </div>
                  )}

                  {status === 'review' && !isFeedbackOpen && (
                    <div className="asset-actions">
                      <button className="confirm-asset-button" type="button" onClick={() => void onConfirm(character.id)}><CheckCircle2 size={17} />确认并作为参考</button>
                      <button className="quiet-button" type="button" onClick={() => {
                        setFeedbackCharacterId(character.id)
                        setFeedback('')
                      }}>不满意，生成优化版</button>
                    </div>
                  )}

                  {isFeedbackOpen && (
                    <form className="portrait-feedback" onSubmit={(event) => {
                      event.preventDefault()
                      if (!feedback.trim()) return
                      void onGenerate(character.id, feedback.trim()).then(() => {
                        setFeedbackCharacterId(undefined)
                        setFeedback('')
                      })
                    }}>
                      <label htmlFor={`portrait-feedback-${character.id}`}>具体哪里不满意？</label>
                      <textarea
                        id={`portrait-feedback-${character.id}`}
                        rows={3}
                        value={feedback}
                        placeholder="例如：发型更利落，年龄年轻两三岁，保留眼下小痣和大衣。"
                        onChange={(event) => setFeedback(event.target.value)}
                      />
                      <div><button className="quiet-button" type="button" onClick={() => setFeedbackCharacterId(undefined)}>取消</button><button className="confirm-asset-button" type="submit" disabled={!feedback.trim()}><RefreshCw size={17} />生成优化版</button></div>
                    </form>
                  )}

                  {(status === 'planned' || status === 'failed') && (
                    <button className="confirm-asset-button full-width" type="button" onClick={() => void onGenerate(character.id)}>
                      {status === 'failed' ? <RefreshCw size={17} /> : <ImagePlus size={17} />}
                      {status === 'failed' ? '手动重试定妆照' : '生成定妆照'}
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
