import { FileSharer } from '@capgo/capacitor-file-sharer'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { logImagePipeline } from './imagePipelineLog'
import { secretStore } from './secretStore'
import type { GeneratedImageSource, NativeImagePersistenceTarget } from './types'

export interface StoredImageSource {
  imageUrl: string
  localUri?: string
}

export type ImageAssetOrigin = 'generated' | 'imported'
export type ImageAssetPersistenceStage = 'saving' | 'validating'
export type ImageAssetPersistenceStageCallback = (stage: ImageAssetPersistenceStage) => void

const IMAGE_SAVE_TIMEOUT_MS = 120_000
const IMAGE_VALIDATION_TIMEOUT_MS = 10_000
const IMAGE_WRITE_CHUNK_SIZE = 512 * 1024
const IMAGE_VALIDATION_CHUNK_SIZE = 64
const IMAGE_EXTENSIONS = ['png', 'jpg', 'webp', 'gif', 'heic', 'avif'] as const

interface NativeImageAssetStorePlugin {
  download(options: {
    url: string
    projectId: string
    assetId: string
    bearerToken?: string
  }): Promise<{
    localUri: string
    format: ImageFormat
    bytes: number
    responseMs: number
    writeMs: number
    validationAndReplaceMs: number
    durationMs: number
  }>
  generate(options: {
    endpoint: string
    model: string
    prompt: string
    size: string
    projectId: string
    assetId: string
    bearerToken: string
    referenceSources?: string[]
    responseFormat?: 'b64_json'
  }): Promise<{
    localUri: string
    format: ImageFormat
    bytes: number
    responseMode: 'url' | 'b64_json'
    responseMs: number
    writeMs: number
    validationAndReplaceMs: number
    durationMs: number
  }>
}

const NativeImageAssetStore = registerPlugin<NativeImageAssetStorePlugin>('ImageAssetStore')

type ImageFormat = typeof IMAGE_EXTENSIONS[number]

export interface NativeImageGenerationRequest {
  endpoint: string
  model: string
  prompt: string
  size: string
  target: NativeImagePersistenceTarget
  secretRef: string
  referenceSources?: string[]
  responseFormat?: 'b64_json'
}

/**
 * Keeps a generation response in Android: this method deliberately does not
 * fall back after invoking the plugin, because a second request can be billed.
 */
export async function generateNativeImageAsset(request: NativeImageGenerationRequest): Promise<StoredImageSource | undefined> {
  if (!Capacitor.isNativePlatform()) return undefined
  const bearerToken = await secretStore.get(request.secretRef)
  if (!bearerToken) throw new Error('请填写 API Key')
  const startedAt = Date.now()
  try {
    const stored = await NativeImageAssetStore.generate({
      endpoint: request.endpoint,
      model: request.model,
      prompt: request.prompt,
      size: request.size,
      projectId: request.target.projectId,
      assetId: request.target.assetId,
      bearerToken,
      referenceSources: request.referenceSources,
      responseFormat: request.responseFormat,
    })
    logImagePipeline('info', {
      phase: 'native-generation-persist-complete',
      operation: request.referenceSources?.length ? 'edit' : 'generation',
      format: stored.format,
      bytes: stored.bytes,
      responseMode: stored.responseMode,
      referenceCount: request.referenceSources?.length,
      responseMs: stored.responseMs,
      writeMs: stored.writeMs,
      validationAndReplaceMs: stored.validationAndReplaceMs,
      durationMs: stored.durationMs,
    })
    return { imageUrl: '', localUri: stored.localUri }
  } catch (error) {
    logImagePipeline('warn', {
      phase: 'native-generation-persist-failed',
      operation: request.referenceSources?.length ? 'edit' : 'generation',
      referenceCount: request.referenceSources?.length,
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

const BMFF_BRANDS: Record<string, ImageFormat> = {
  heic: 'heic', heix: 'heic', heim: 'heic', heis: 'heic', hevc: 'heic', hevx: 'heic',
  mif1: 'heic', msf1: 'heic',
  avif: 'avif', avis: 'avif',
}

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
  return { mimeType: match[1], base64: normalizedBase64(match[2]) }
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
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('gif')) return 'gif'
  if (mimeType.includes('heic') || mimeType.includes('heif')) return 'heic'
  if (mimeType.includes('avif')) return 'avif'
  if (mimeType.includes('png')) return 'png'
  return undefined
}

function normalizedBase64(value: string) {
  const compact = value.replace(/^data:[^;,]+;base64,/, '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const remainder = compact.length % 4
  return remainder ? `${compact}${'='.repeat(4 - remainder)}` : compact
}

function approximateBase64Bytes(base64: string) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

function decodedImageBytes(base64: string) {
  const normalized = normalizedBase64(base64)
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

function detectImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (!bytes || bytes.length < 12) return undefined
  if (bytesStartWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'png'
  if (bytesStartWith(bytes, [255, 216, 255])) return 'jpg'
  if (bytesStartWith(bytes, [71, 73, 70, 56])) return 'gif'
  if (bytesStartWith(bytes, [82, 73, 70, 70]) && bytesStartWith(bytes.slice(8), [87, 69, 66, 80])) return 'webp'
  const readAscii = (offset: number, length: number) => {
    let value = ''
    for (let index = 0; index < length; index++) value += String.fromCharCode(bytes[offset + index] ?? 0)
    return value
  }
  if (readAscii(4, 4) !== 'ftyp') return undefined
  const brand = BMFF_BRANDS[readAscii(8, 4)] ?? (bytesStartWith(bytes, [0, 0, 0, 1]) ? BMFF_BRANDS[readAscii(20, 4)] : undefined)
  return brand
}

function imageFormatFromBase64Head(base64: string): ImageFormat | undefined {
  // Format selection only needs a tiny prefix. Full completion validation runs
  // against the temporary native file after the chunked write.
  const bytes = decodedImageBytes(base64.slice(0, 128))
  return bytes ? detectImageFormat(bytes) : undefined
}

async function persistedImageFormat(path: string): Promise<ImageFormat | undefined> {
  try {
    const stat = await withTimeout(
      Filesystem.stat({ path, directory: Directory.Data }),
      IMAGE_VALIDATION_TIMEOUT_MS,
      '校验图片文件超时',
    )
    if (stat.type !== 'file' || stat.size < 12) return undefined
    const headLength = Math.min(stat.size, IMAGE_VALIDATION_CHUNK_SIZE)
    const tailLength = Math.min(stat.size, IMAGE_VALIDATION_CHUNK_SIZE)
    const [headResult, tailResult] = await Promise.all([
      withTimeout(
        Filesystem.readFile({ path, directory: Directory.Data, offset: 0, length: headLength }),
        IMAGE_VALIDATION_TIMEOUT_MS,
        '校验图片文件超时',
      ),
      withTimeout(
        Filesystem.readFile({ path, directory: Directory.Data, offset: Math.max(0, stat.size - tailLength), length: tailLength }),
        IMAGE_VALIDATION_TIMEOUT_MS,
        '校验图片文件超时',
      ),
    ])
    if (typeof headResult.data !== 'string' || typeof tailResult.data !== 'string') return undefined
    const head = decodedImageBytes(headResult.data)
    const tail = decodedImageBytes(tailResult.data)
    if (!head || !tail) return undefined
    const format = detectImageFormat(head)
    if (!format) return undefined
    if (format === 'png' && !bytesEndWith(tail, [73, 69, 78, 68, 174, 66, 96, 130])) return undefined
    if (format === 'jpg' && !bytesEndWith(tail, [255, 217])) return undefined
    if (format === 'gif' && !bytesEndWith(tail, [59])) return undefined
    return format
  } catch {
    return undefined
  }
}

async function persistedImageIsComplete(path: string) {
  return Boolean(await persistedImageFormat(path))
}

async function writeBase64InChunks(path: string, base64: string) {
  const firstChunk = base64.slice(0, IMAGE_WRITE_CHUNK_SIZE)
  const result = await Filesystem.writeFile({
    path,
    data: firstChunk,
    directory: Directory.Data,
    recursive: true,
  })
  for (let offset = IMAGE_WRITE_CHUNK_SIZE; offset < base64.length; offset += IMAGE_WRITE_CHUNK_SIZE) {
    await Filesystem.appendFile({
      path,
      data: base64.slice(offset, offset + IMAGE_WRITE_CHUNK_SIZE),
      directory: Directory.Data,
    })
  }
  return result
}

async function replaceTemporaryImage(temporaryPath: string, path: string) {
  try {
    await Filesystem.rename({ from: temporaryPath, to: path, directory: Directory.Data })
    return
  } catch (initialError) {
    const backupPath = `${temporaryPath}.previous`
    try {
      await Filesystem.deleteFile({ path: backupPath, directory: Directory.Data })
    } catch {
      // No stale backup from an earlier interrupted replacement.
    }
    try {
      await Filesystem.rename({ from: path, to: backupPath, directory: Directory.Data })
    } catch {
      throw initialError
    }
    try {
      await Filesystem.rename({ from: temporaryPath, to: path, directory: Directory.Data })
    } catch (replacementError) {
      try {
        await Filesystem.rename({ from: backupPath, to: path, directory: Directory.Data })
      } catch {
        // The original replacement error remains the most actionable failure.
      }
      throw replacementError
    }
    try {
      await Filesystem.deleteFile({ path: backupPath, directory: Directory.Data })
    } catch {
      // The new complete image is already safely in place; leave cleanup for later.
    }
  }
}

export async function recoverPersistedImageAsset(projectId: string, assetId: string, minModifiedAt = 0): Promise<StoredImageSource | undefined> {
  if (!Capacitor.isNativePlatform()) return undefined

  for (const extension of IMAGE_EXTENSIONS) {
    const path = imagePathFor(projectId, assetId, extension)
    try {
      const stat = await Filesystem.stat({ path, directory: Directory.Data })
      const modifiedAt = Math.max(stat.mtime || 0, stat.ctime || 0)
      if (stat.type !== 'file' || stat.size <= 0 || modifiedAt < minModifiedAt) continue
      if (!(await persistedImageIsComplete(path))) continue
      const localUri = stat.uri || (await Filesystem.getUri({ path, directory: Directory.Data })).uri
      return { imageUrl: '', localUri }
    } catch {
      // Try the next supported extension.
    }
  }

  return undefined
}

export async function persistImageAsset(
  source: string | GeneratedImageSource,
  projectId: string,
  assetId: string,
  origin: ImageAssetOrigin = 'generated',
  onStageChange?: ImageAssetPersistenceStageCallback,
): Promise<StoredImageSource> {
  const normalizedSource: GeneratedImageSource = typeof source === 'string'
    ? { kind: 'inline', dataUrl: source }
    : source
  if (!Capacitor.isNativePlatform()) {
    return { imageUrl: normalizedSource.kind === 'inline' ? normalizedSource.dataUrl : normalizedSource.kind === 'remote' ? normalizedSource.url : normalizedSource.localUri }
  }

  if (normalizedSource.kind === 'local') return { imageUrl: '', localUri: normalizedSource.localUri }

  if (normalizedSource.kind === 'remote') {
    const downloadStartedAt = Date.now()
    try {
      const bearerToken = normalizedSource.auth?.kind === 'bearer'
        ? await secretStore.get(normalizedSource.auth.secretRef) ?? undefined
        : undefined
      if (normalizedSource.auth && !bearerToken) throw new Error('请填写 API Key')
      onStageChange?.('saving')
      const stored = await NativeImageAssetStore.download({
        url: normalizedSource.url,
        projectId,
        assetId,
        bearerToken,
      })
      onStageChange?.('validating')
      logImagePipeline('info', {
        phase: 'native-url-persist-complete',
        assetId,
        origin,
        format: stored.format,
        bytes: stored.bytes,
        usesProviderAuth: Boolean(normalizedSource.auth),
        responseMs: stored.responseMs,
        writeMs: stored.writeMs,
        validationAndReplaceMs: stored.validationAndReplaceMs,
        durationMs: stored.durationMs,
      })
      return { imageUrl: '', localUri: stored.localUri }
    } catch (error) {
      const status = typeof error === 'object' && error ? (error as { status?: unknown; data?: { status?: unknown } }).status
        ?? (error as { data?: { status?: unknown } }).data?.status
        : undefined
      logImagePipeline('warn', {
        phase: 'native-url-persist-failed',
        assetId,
        origin,
        usesProviderAuth: Boolean(normalizedSource.auth),
        durationMs: Date.now() - downloadStartedAt,
        status: typeof status === 'number' ? status : undefined,
        message: error instanceof Error ? error.message : String(error),
      })
      if (!normalizedSource.auth && (status === 401 || status === 403)) {
        throw new Error('图片 URL 位于第三方地址且拒绝匿名读取。为避免泄露 API Key，应用不会向该地址发送凭据；请让服务返回 b64_json 或可公开读取的签名 URL。', { cause: error })
      }
      const action = origin === 'imported' ? '参考图' : '图片已生成，但'
      throw new Error(`${action}无法下载并保存到手机本地`, { cause: error })
    }
  }

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

  if (!normalizedSource.dataUrl.startsWith('data:')) throw new Error('图片数据尚未下载为可保存的格式')

  const dataUrl = normalizedSource.dataUrl

  const { mimeType, base64 } = dataUrlParts(dataUrl)
  const detected = imageFormatFromBase64Head(base64)
  const extension = detected ?? extensionForMime(mimeType)
  if (!extension) throw new Error('图片数据不完整，无法识别格式')
  const path = imagePathFor(projectId, assetId, extension)
  const temporaryPath = imagePathFor(projectId, assetId, 'tmp')
  const saveStartedAt = Date.now()
  try {
    onStageChange?.('saving')
    await withTimeout(
      writeBase64InChunks(temporaryPath, base64),
      IMAGE_SAVE_TIMEOUT_MS,
      '保存图片超过 120 秒仍未完成',
    )
    const writeCompletedAt = Date.now()
    onStageChange?.('validating')
    if (!(await persistedImageIsComplete(temporaryPath))) throw new Error('图片文件不完整')
    await replaceTemporaryImage(temporaryPath, path)
    const localUri = (await Filesystem.getUri({ path, directory: Directory.Data })).uri
    const completedAt = Date.now()
    logImagePipeline('info', {
      phase: 'native-persist-complete',
      assetId,
      origin,
      format: extension,
      approximateBytes: approximateBase64Bytes(base64),
      chunks: Math.ceil(base64.length / IMAGE_WRITE_CHUNK_SIZE),
      writeMs: writeCompletedAt - saveStartedAt,
      validationAndReplaceMs: completedAt - writeCompletedAt,
      durationMs: completedAt - saveStartedAt,
    })
    // On Android the local file is authoritative. Keeping source here would
    // duplicate a potentially multi-megabyte Base64 string in IndexedDB.
    return { imageUrl: '', localUri }
  } catch (error) {
    logImagePipeline('warn', {
      phase: 'native-persist-failed',
      assetId,
      origin,
      durationMs: Date.now() - saveStartedAt,
      message: error instanceof Error ? error.message : String(error),
    })
    const recovered = await recoverPersistedImageAsset(projectId, assetId, saveStartedAt)
    if (recovered?.localUri) return recovered
    const detail = error instanceof Error && error.message ? `（${error.message}）` : ''
    const action = origin === 'imported' ? '参考图' : '图片已生成，但'
    throw new Error(`${action}无法保存到手机本地${detail}`)
  }
}

export function resolveImageSource(imageUrl?: string, localUri?: string) {
  if (localUri) return Capacitor.convertFileSrc(localUri)
  return imageUrl
}

const SAVED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const

function extensionFromPath(path: string) {
  const fileName = decodeURIComponent(path.split(/[\\/]/).pop() ?? '')
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return undefined
  const extension = fileName.slice(dot + 1).toLowerCase()
  return SAVED_IMAGE_EXTENSIONS.includes(extension as typeof SAVED_IMAGE_EXTENSIONS[number]) ? extension : undefined
}

function contentTypeForExtension(extension: string) {
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

function safeSavedFileName(title: string) {
  return title.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || '插画'
}

export async function saveImageToDevice(source: string, localUri: string | undefined, title: string): Promise<void> {
  if (Capacitor.isNativePlatform() && localUri) {
    const extension = extensionFromPath(localUri) ?? 'png'
    const fileName = `叙影-${safeSavedFileName(title)}.${extension}`
    await FileSharer.save({
      path: localUri,
      filename: fileName,
      contentType: contentTypeForExtension(extension),
      android: { saveDirectory: 'pictures', relativePath: '叙影' },
    })
    return
  }

  const response = await fetch(source)
  if (!response.ok) throw new Error('无法读取图片数据')
  const bytes = new Uint8Array(await (await response.blob()).arrayBuffer())
  const extension = detectImageFormat(bytes) ?? 'png'
  const fileName = `叙影-${safeSavedFileName(title)}.${extension}`
  const dataUrl = await blobToDataUrl(new Blob([bytes]))
  await FileSharer.save({
    base64Data: dataUrl,
    filename: fileName,
    contentType: contentTypeForExtension(extension),
    android: { saveDirectory: 'pictures', relativePath: '叙影' },
  })
}
