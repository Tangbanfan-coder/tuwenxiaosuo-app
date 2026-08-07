import { useEffect, useRef, useState } from 'react'
import { ImagePlus, LoaderCircle, Upload, X } from 'lucide-react'
import type { CharacterAsset, ReferenceStyleMode } from '../domain/models'

interface Props {
  open: boolean
  characters: CharacterAsset[]
  onClose: () => void
  onImport: (target: ReferenceImageTarget, dataUrl: string, referenceStyleMode: ReferenceStyleMode) => Promise<void>
}

export type ReferenceImageTarget = { characterId: string } | { name: string; role: string }

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'))
    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.readAsDataURL(file)
  })
}

export default function ReferenceImageDialog({ open, characters, onClose, onImport }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [characterId, setCharacterId] = useState('')
  const [characterName, setCharacterName] = useState('')
  const [characterRole, setCharacterRole] = useState('主要角色')
  const [preview, setPreview] = useState('')
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [referenceStyleMode, setReferenceStyleMode] = useState<ReferenceStyleMode>('project')

  useEffect(() => {
    if (!open) return
    setCharacterId(characters[0]?.id ?? '')
    setCharacterName('')
    setCharacterRole('主要角色')
    setPreview('')
    setFileName('')
    setError('')
    setReferenceStyleMode('project')
    window.requestAnimationFrame(() => closeButtonRef.current?.focus())
  }, [characters, open])

  if (!open) return null

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !saving) onClose()
    }}>
      <section className="reference-dialog" role="dialog" aria-modal="true" aria-labelledby="reference-dialog-title">
        <header className="dialog-header">
          <div>
            <h2 id="reference-dialog-title">导入角色参考图</h2>
            <p>{characters.length ? '图片只会绑定到你选择的角色' : '先建立角色，再把图片设为外貌参考'}</p>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭参考图导入" disabled={saving} onClick={onClose}><X size={20} /></button>
        </header>
        <div className="reference-dialog-body">
          {characters.length ? (
            <label className="field">
              <span>指定角色</span>
              <select value={characterId} onChange={(event) => setCharacterId(event.target.value)}>
                {characters.map((character) => <option key={character.id} value={character.id}>{character.name} · {character.role}</option>)}
              </select>
            </label>
          ) : (
            <div className="reference-character-setup">
              <label className="field">
                <span>角色名称</span>
                <input
                  value={characterName}
                  maxLength={40}
                  placeholder="请使用故事中会出现的名字"
                  onChange={(event) => setCharacterName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>角色身份（可选）</span>
                <input
                  value={characterRole}
                  maxLength={40}
                  placeholder="例如：主角、侦探、少年"
                  onChange={(event) => setCharacterRole(event.target.value)}
                />
              </label>
              <p>后续视觉计划识别到同名角色时，会沿用这张图片，不会自动替换角色外貌。</p>
            </div>
          )}

          <fieldset className="reference-style-choice">
            <legend>参考图画风</legend>
            <div role="radiogroup" aria-label="参考图画风处理方式">
              <button type="button" role="radio" aria-checked={referenceStyleMode === 'project'} onClick={() => setReferenceStyleMode('project')}>统一为作品画风</button>
              <button type="button" role="radio" aria-checked={referenceStyleMode === 'reference'} onClick={() => setReferenceStyleMode('reference')}>保留图片画风</button>
            </div>
            <p>{referenceStyleMode === 'project'
              ? '只提取角色外貌和服装，后续插画会重新渲染为作品统一画风。'
              : '角色会保留这张图片的绘制或摄影风格，可用于有意的跨画风故事。'}</p>
          </fieldset>

          <label className="reference-file-picker">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) return
                if (file.size > 20 * 1024 * 1024) {
                  setError('图片不能超过 20 MB')
                  return
                }
                setError('')
                setFileName(file.name)
                void fileToDataUrl(file).then(setPreview).catch((readError) => setError(readError instanceof Error ? readError.message : '无法读取图片'))
              }}
            />
            {preview ? <img src={preview} alt="待导入的角色参考图预览" /> : <div><ImagePlus size={27} /><strong>选择手机中的图片</strong><span>支持 JPG、PNG、WebP，最大 20 MB</span></div>}
          </label>
          {fileName && <p className="selected-file">已选择：{fileName}</p>}
          {error && <p className="asset-error" role="alert">{error}</p>}
        </div>
        <footer className="dialog-footer">
          <span>{characters.length ? '导入后仍需确认，才会用于后续插画' : '角色和图片会一起保存，确认后用于插画'}</span>
          <button className="save-button" type="button" disabled={!(characters.length ? characterId : characterName.trim()) || !preview || saving} onClick={() => {
            const target: ReferenceImageTarget = characters.length
              ? { characterId }
              : { name: characterName.trim(), role: characterRole.trim() || '主要角色' }
            setSaving(true)
            void onImport(target, preview, referenceStyleMode).finally(() => setSaving(false))
          }}>
            {saving ? <LoaderCircle className="spin" size={18} /> : <Upload size={18} />}
            {saving ? '正在导入…' : '导入参考图'}
          </button>
        </footer>
      </section>
    </div>
  )
}
