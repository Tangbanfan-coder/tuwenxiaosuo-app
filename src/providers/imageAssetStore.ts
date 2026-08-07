import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'

export interface StoredImageSource {
  imageUrl: string
  localUri?: string
}

const IMAGE_SAVE_TIMEOUT_MS = 120_000
const IMAGE_VALIDATION_TIMEOUT_MS = 10_000
const IMAGE_EXTENSIONS = ['png', 'jpg', 'webp', 'gif'] as const

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function imageDirectoryFor(projectId: string) {
  return `projects/${safePathSegment(projectId)}/images`
}

function imagePathFor(projectId: string, assetId: string, extension: string) {
  return `${imageDirectoryFor(projectId)}/${safePathSegment(assetId)}.${extension}`
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

function dataUrlParts(dataUrl: string) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) throw new Error('图片数据格式不正确')
  return { mimeType: match[1], base64: match[2] }
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片数据'))
    reader.onerror = () => reject(new Error('无法读取图片数据'))
    reader.readAsDataURL(blob)
  })
}

function extensionForMime(mimeType: string) {
  if (mimeType.includes('jpeg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('gif')) return 'gif'
  return 'png'
}

function extensionForSource(source: string) {
  try {
    const pathname = new URL(source).pathname.toLocaleLowerCase()
    if (pathname.endsWith('.jpeg') || pathname.endsWith('.jpg')) return 'jpg'
    if (pathname.endsWith('.webp')) return 'webp'
    if (pathname.endsWith('.gif')) return 'gif'
  } catch {
    // Temporary image URLs do not always have a conventional filename.
  }
  return 'png'
}

function decodedImageBytes(base64: string) {
  const normalized = base64.replace(/^data:[^;,]+;base64,/, '').replace(/\s/g, '')
  try {
    const binary = atob(normalized)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

function bytesStartWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value)
}

function bytesEndWith(bytes: Uint8Array, signature: number[]) {
  if (bytes.length < signature.length) return false
  const offset = bytes.length - signature.length
  return signature.every((value, index) => bytes[offset + index] === value)
}

function hasCompleteImageBytes(base64: string, extension: string) {
  const bytes = decodedImageBytes(base64)
  if (!bytes || bytes.length < 12) return false
  if (extension === 'png') return bytesStartWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10]) && bytesEndWith(bytes, [73, 69, 78, 68, 174, 66, 96, 130])
  if (extension === 'jpg') return bytesStartWith(bytes, [255, 216, 255]) && bytesEndWith(bytes, [255, 217])
  if (extension === 'webp') return bytesStartWith(bytes, [82, 73, 70, 70]) && bytesStartWith(bytes.slice(8), [87, 69, 66, 80])
  if (extension === 'gif') return (bytesStartWith(bytes, [71, 73, 70, 56, 55, 97]) || bytesStartWith(bytes, [71, 73, 70, 56, 57, 97])) && bytesEndWith(bytes, [59])
  return false
}

async function persistedImageIsComplete(path: string, extension: string) {
  try {
    const result = await withTimeout(
      Filesystem.readFile({ path, directory: Directory.Data }),
      IMAGE_VALIDATION_TIMEOUT_MS,
      '校验图片文件超时',
    )
    return typeof result.data === 'string' && hasCompleteImageBytes(result.data, extension)
  } catch {
    return false
  }
}

export async function recoverPersistedImageAsset(projectId: string, assetId: string, minModifiedAt = 0): Promise<StoredImageSource | undefined> {
  if (!Capacitor.isNativePlatform()) return undefined

  for (const extension of IMAGE_EXTENSIONS) {
    const path = imagePathFor(projectId, assetId, extension)
    try {
      const stat = await Filesystem.stat({ path, directory: Directory.Data })
      const modifiedAt = Math.max(stat.mtime || 0, stat.ctime || 0)
      if (stat.type !== 'file' || stat.size <= 0 || modifiedAt + 5_000 < minModifiedAt) continue
      if (!(await persistedImageIsComplete(path, extension))) continue
      const localUri = stat.uri || (await Filesystem.getUri({ path, directory: Directory.Data })).uri
      return { imageUrl: '', localUri }
    } catch {
      // Try the next supported extension.
    }
  }

  return undefined
}

export async function persistImageAsset(source: string, projectId: string, assetId: string): Promise<StoredImageSource> {
  if (!Capacitor.isNativePlatform()) return { imageUrl: source }

  const imageDirectory = imageDirectoryFor(projectId)

  try {
    await Filesystem.stat({ path: imageDirectory, directory: Directory.Data })
  } catch {
    await Filesystem.mkdir({
      path: imageDirectory,
      directory: Directory.Data,
      recursive: true,
    })
  }

  if (!source.startsWith('data:')) {
    const path = imagePathFor(projectId, assetId, extensionForSource(source))
    const saveStartedAt = Date.now()
    try {
      // Native download runs outside the WebView, so providers do not need to
      // expose temporary image URLs to the app's CORS origin.
      const result = await withTimeout(
        Filesystem.downloadFile({
          url: source,
          path,
          directory: Directory.Data,
          recursive: true,
        }),
        IMAGE_SAVE_TIMEOUT_MS,
        '保存图片超过 120 秒仍未完成',
      )
      const localUri = result.path || (await Filesystem.getUri({ path, directory: Directory.Data })).uri
      if (!(await persistedImageIsComplete(path, extensionForSource(source)))) {
        throw new Error('图片文件不完整')
      }
      return { imageUrl: source, localUri }
    } catch (error) {
      const recovered = await recoverPersistedImageAsset(projectId, assetId, saveStartedAt)
      if (recovered?.localUri) return { imageUrl: source, localUri: recovered.localUri }
      const detail = error instanceof Error && error.message ? `（${error.message}）` : ''
      throw new Error(`图片已生成，但无法保存到手机本地${detail}`)
    }
  }

  const dataUrl = source

  const { mimeType, base64 } = dataUrlParts(dataUrl)
  const extension = extensionForMime(mimeType)
  if (!hasCompleteImageBytes(base64, extension)) throw new Error('图片数据不完整')
  const path = imagePathFor(projectId, assetId, extension)
  const saveStartedAt = Date.now()
  try {
    const result = await withTimeout(
      Filesystem.writeFile({
        path,
        data: base64,
        directory: Directory.Data,
        recursive: true,
      }),
      IMAGE_SAVE_TIMEOUT_MS,
      '保存图片超过 120 秒仍未完成',
    )
    if (!(await persistedImageIsComplete(path, extension))) throw new Error('图片文件不完整')
    return { imageUrl: source, localUri: result.uri }
  } catch (error) {
    const recovered = await recoverPersistedImageAsset(projectId, assetId, saveStartedAt)
    if (recovered?.localUri) return { imageUrl: source, localUri: recovered.localUri }
    const detail = error instanceof Error && error.message ? `（${error.message}）` : ''
    throw new Error(`图片已生成，但无法保存到手机本地${detail}`)
  }
}

export function resolveImageSource(imageUrl?: string, localUri?: string) {
  if (localUri) return Capacitor.convertFileSrc(localUri)
  return imageUrl
}
