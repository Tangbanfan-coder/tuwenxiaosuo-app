import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ImagePlus, LoaderCircle, Upload, UserPlus, X } from 'lucide-react'
import type { CharacterAsset, ReferenceStyleMode } from '../domain/models'
import { usePresence } from '../hooks/usePresence'

interface Props {
  open: boolean
  characters: CharacterAsset[]
  onClose: () => void
  onImport: (target: ReferenceImageTarget, dataUrl: string, referenceStyleMode: ReferenceStyleMode) => Promise<void>
}

export type ReferenceImageTarget = { characterId: string } | { name: string; role: string }

const NEW_CHARACTER_ID = '__new_character__'
const IMAGE_DECODE_TIMEOUT_MS = 10_000

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'))
    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.readAsDataURL(file)
  })
}

export function isHeicReferenceFile(file: File) {
  const mime = file.type.toLocaleLowerCase()
  return mime === 'image/heic' || mime === 'image/heif' || /\.hei[cf]$/i.test(file.name)
}

async function decodeImage(file: File) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Some WebViews expose createImageBitmap but do not decode HEIC there;
      // give the platform image decoder a chance before showing the fallback.
    }
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      let timeoutId: number | undefined
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
        image.onload = null
        image.onerror = null
        if (error) reject(error)
        else resolve()
      }
      image.onload = () => settle()
      image.onerror = () => settle(new Error('图片解码失败'))
      timeoutId = window.setTimeout(() => settle(new Error('图片解码超时')), IMAGE_DECODE_TIMEOUT_MS)
      image.src = objectUrl
    })
    return image
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function referenceFileToDataUrl(file: File) {
  if (!isHeicReferenceFile(file)) return fileToDataUrl(file)

  try {
    const image = await decodeImage(file)
    const width = 'naturalWidth' in image ? image.naturalWidth : image.width
    const height = 'naturalHeight' in image ? image.naturalHeight : image.height
    if (!width || !height) throw new Error('图片尺寸无效')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('设备不支持图片转换')
    context.drawImage(image, 0, 0)
    if ('close' in image && typeof image.close === 'function') image.close()

    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 转换失败')), 'image/png')
    })
    return await fileToDataUrl(new File([png], file.name.replace(/\.hei[cf]$/i, '.png'), { type: 'image/png' }))
  } catch {
    throw new Error('这台设备无法解码 HEIC/HEIF 图片，请先将图片转换为 JPG、PNG 或 WebP 后再导入')
  }
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
  const [characterMenuOpen, setCharacterMenuOpen] = useState(false)
  const characterSelectRef = useRef<HTMLDivElement>(null)
  const { present, closing } = usePresence(open, onClose, 180)

  useEffect(() => {
    if (!open) return
    setCharacterId(characters[0]?.id ?? NEW_CHARACTER_ID)
    setCharacterName('')
    setCharacterRole('主要角色')
    setPreview('')
    setFileName('')
    setError('')
    setReferenceStyleMode('project')
    setCharacterMenuOpen(false)
    window.requestAnimationFrame(() => closeButtonRef.current?.focus())
  }, [characters, open])

  useEffect(() => {
    if (!characterMenuOpen) return
    const handleDocumentClick = (event: MouseEvent) => {
      if (!characterSelectRef.current?.contains(event.target as Node)) setCharacterMenuOpen(false)
    }
    document.addEventListener('click', handleDocumentClick)
    return () => document.removeEventListener('click', handleDocumentClick)
  }, [characterMenuOpen])

  if (!present) return null

  return (
    <div className={`dialog-backdrop${closing ? ' closing' : ''}`} role="presentation" onMouseDown={(event) => {
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
            <div className="field">
              <span>指定角色</span>
              <div ref={characterSelectRef} className="theme-select character-select">
                <button
                  className="theme-select-trigger"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={characterMenuOpen}
                  onClick={() => setCharacterMenuOpen((value) => !value)}
                >
                  <span className="theme-select-copy">
                    <strong>{characterId === NEW_CHARACTER_ID ? '新建角色' : (characters.find((character) => character.id === characterId)?.name ?? '请选择角色')}</strong>
                    <small>{characterId === NEW_CHARACTER_ID ? '创建角色并绑定这张参考图' : (characters.find((character) => character.id === characterId)?.role ?? '参考图将绑定到这个角色')}</small>
                  </span>
                  <ChevronDown size={17} aria-hidden="true" className={characterMenuOpen ? 'rotate-180' : undefined} />
                </button>
                {characterMenuOpen && (
                  <div className="theme-select-menu character-select-menu" role="listbox" aria-label="选择角色">
                    {characters.map((character) => {
                      const selected = character.id === characterId
                      return (
                        <button
                          key={character.id}
                          className="theme-select-option"
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setCharacterId(character.id)
                            setCharacterMenuOpen(false)
                          }}
                        >
                          <span><strong>{character.name}</strong><small>{character.role}</small></span>
                          {selected && <Check size={15} aria-hidden="true" />}
                        </button>
                      )
                    })}
                    <button
                      className="theme-select-option"
                      type="button"
                      role="option"
                      aria-selected={characterId === NEW_CHARACTER_ID}
                      onClick={() => {
                        setCharacterId(NEW_CHARACTER_ID)
                        setCharacterMenuOpen(false)
                      }}
                    >
                      <span><strong>新建角色</strong><small>为新角色上传参考图</small></span>
                      {characterId === NEW_CHARACTER_ID ? <Check size={15} aria-hidden="true" /> : <UserPlus size={15} aria-hidden="true" />}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {characterId === NEW_CHARACTER_ID && (
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
              aria-label="选择角色参考图片"
              accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) return
                if (file.size > 20 * 1024 * 1024) {
                  setPreview('')
                  setFileName('')
                  setError('图片不能超过 20 MB')
                  return
                }
                setError('')
                setPreview('')
                setFileName(file.name)
                void referenceFileToDataUrl(file).then(setPreview).catch((readError) => setError(readError instanceof Error ? readError.message : '无法读取图片'))
              }}
            />
            {preview ? <img src={preview} alt="待导入的角色参考图预览" /> : <div><ImagePlus size={27} /><strong>选择手机中的图片</strong><span>支持 JPG、PNG、WebP、HEIC/HEIF，最大 20 MB</span></div>}
          </label>
          {fileName && <p className="selected-file">已选择：{fileName}</p>}
          {error && <p className="asset-error" role="alert">{error}</p>}
        </div>
        <footer className="dialog-footer">
          <span>{characterId === NEW_CHARACTER_ID ? '角色和图片会一起保存，确认后用于插画' : '导入后仍需确认，才会用于后续插画'}</span>
          <button className="save-button" type="button" disabled={!(characterId === NEW_CHARACTER_ID ? characterName.trim() : characterId) || !preview || saving} onClick={() => {
            const target: ReferenceImageTarget = characterId === NEW_CHARACTER_ID
              ? { name: characterName.trim(), role: characterRole.trim() || '主要角色' }
              : { characterId }
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
