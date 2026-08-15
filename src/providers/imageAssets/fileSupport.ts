import { Directory, Filesystem } from '@capacitor/filesystem'

export interface StoredImageSource {
  imageUrl: string
  localUri?: string
}

export type ImageAssetOrigin = 'generated' | 'imported'
export type ImageAssetPersistenceStage = 'saving' | 'validating'
export type ImageAssetPersistenceStageCallback = (stage: ImageAssetPersistenceStage) => void
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'webp', 'gif', 'heic', 'avif'] as const
export type ImageFormat = typeof IMAGE_EXTENSIONS[number]

export const IMAGE_SAVE_TIMEOUT_MS = 120_000
export const IMAGE_VALIDATION_TIMEOUT_MS = 10_000
export const IMAGE_WRITE_CHUNK_SIZE = 512 * 1024
export const IMAGE_VALIDATION_CHUNK_SIZE = 64

const BMFF_BRANDS: Record<string, ImageFormat> = {
  heic: 'heic', heix: 'heic', heim: 'heic', heis: 'heic', hevc: 'heic', hevx: 'heic',
  mif1: 'heic', msf1: 'heic', avif: 'avif', avis: 'avif',
}

export function imagePathFor(projectId: string, assetId: string, extension: string) {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `projects/${safe(projectId)}/images/${safe(assetId)}.${extension}`
}

export function imageDirectoryFor(projectId: string) {
  return imagePathFor(projectId, '_', 'tmp').replace(/\/_\.tmp$/, '')
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs) })])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

export function normalizedBase64(value: string) {
  const compact = value.replace(/^data:[^;,]+;base64,/, '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const remainder = compact.length % 4
  return remainder ? `${compact}${'='.repeat(4 - remainder)}` : compact
}

export function dataUrlParts(dataUrl: string) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) throw new Error('图片数据格式不正确')
  return { mimeType: match[1], base64: normalizedBase64(match[2]) }
}

export function approximateBase64Bytes(base64: string) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

export function decodedImageBytes(base64: string) {
  try { return Uint8Array.from(atob(normalizedBase64(base64)), (character) => character.charCodeAt(0)) } catch { return undefined }
}

function bytesStartWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value)
}

export function detectImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (!bytes || bytes.length < 12) return undefined
  if (bytesStartWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'png'
  if (bytesStartWith(bytes, [255, 216, 255])) return 'jpg'
  if (bytesStartWith(bytes, [71, 73, 70, 56])) return 'gif'
  if (bytesStartWith(bytes, [82, 73, 70, 70]) && bytesStartWith(bytes.slice(8), [87, 69, 66, 80])) return 'webp'
  const readAscii = (offset: number, length: number) => Array.from({ length }, (_, index) => String.fromCharCode(bytes[offset + index] ?? 0)).join('')
  if (readAscii(4, 4) !== 'ftyp') return undefined
  return BMFF_BRANDS[readAscii(8, 4)] ?? (bytesStartWith(bytes, [0, 0, 0, 1]) ? BMFF_BRANDS[readAscii(20, 4)] : undefined)
}

export function extensionForMime(mimeType: string) {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('gif')) return 'gif'
  if (mimeType.includes('heic') || mimeType.includes('heif')) return 'heic'
  if (mimeType.includes('avif')) return 'avif'
  if (mimeType.includes('png')) return 'png'
  return undefined
}

export function imageFormatFromBase64Head(base64: string) {
  const bytes = decodedImageBytes(base64.slice(0, 128))
  return bytes ? detectImageFormat(bytes) : undefined
}

export async function persistedImageFormat(path: string): Promise<ImageFormat | undefined> {
  try {
    const stat = await withTimeout(Filesystem.stat({ path, directory: Directory.Data }), IMAGE_VALIDATION_TIMEOUT_MS, '校验图片文件超时')
    if (stat.type !== 'file' || stat.size < 12) return undefined
    const length = Math.min(stat.size, IMAGE_VALIDATION_CHUNK_SIZE)
    const [headResult, tailResult] = await Promise.all([
      withTimeout(Filesystem.readFile({ path, directory: Directory.Data, offset: 0, length }), IMAGE_VALIDATION_TIMEOUT_MS, '校验图片文件超时'),
      withTimeout(Filesystem.readFile({ path, directory: Directory.Data, offset: Math.max(0, stat.size - length), length }), IMAGE_VALIDATION_TIMEOUT_MS, '校验图片文件超时'),
    ])
    if (typeof headResult.data !== 'string' || typeof tailResult.data !== 'string') return undefined
    const head = decodedImageBytes(headResult.data)
    const tail = decodedImageBytes(tailResult.data)
    if (!head || !tail) return undefined
    const format = detectImageFormat(head)
    const endsWith = (signature: number[]) => tail.length >= signature.length && signature.every((value, index) => tail[tail.length - signature.length + index] === value)
    if (!format || (format === 'png' && !endsWith([73, 69, 78, 68, 174, 66, 96, 130])) || (format === 'jpg' && !endsWith([255, 217])) || (format === 'gif' && !endsWith([59]))) return undefined
    return format
  } catch { return undefined }
}

export async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片数据'))
    reader.onerror = () => reject(new Error('无法读取图片数据'))
    reader.readAsDataURL(blob)
  })
}
