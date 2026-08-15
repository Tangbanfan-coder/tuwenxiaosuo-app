import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { logImagePipeline } from '../imagePipelineLog'
import { secretStore } from '../secretStore'
import type { GeneratedImageSource } from '../types'
import { nativeImageAssetStore } from './nativeGeneration'
import { approximateBase64Bytes, dataUrlParts, extensionForMime, IMAGE_EXTENSIONS, IMAGE_SAVE_TIMEOUT_MS, IMAGE_WRITE_CHUNK_SIZE, imageDirectoryFor, imageFormatFromBase64Head, imagePathFor, persistedImageFormat, type ImageAssetOrigin, type ImageAssetPersistenceStageCallback, type StoredImageSource, withTimeout } from './fileSupport'

async function writeBase64InChunks(path: string, base64: string) {
  const result = await Filesystem.writeFile({ path, data: base64.slice(0, IMAGE_WRITE_CHUNK_SIZE), directory: Directory.Data, recursive: true })
  for (let offset = IMAGE_WRITE_CHUNK_SIZE; offset < base64.length; offset += IMAGE_WRITE_CHUNK_SIZE) {
    await Filesystem.appendFile({ path, data: base64.slice(offset, offset + IMAGE_WRITE_CHUNK_SIZE), directory: Directory.Data })
  }
  return result
}

async function replaceTemporaryImage(temporaryPath: string, path: string) {
  try {
    await Filesystem.rename({ from: temporaryPath, to: path, directory: Directory.Data })
    return
  } catch (initialError) {
    const backupPath = `${temporaryPath}.previous`
    try { await Filesystem.deleteFile({ path: backupPath, directory: Directory.Data }) } catch { /* stale backup is optional */ }
    try { await Filesystem.rename({ from: path, to: backupPath, directory: Directory.Data }) } catch { throw initialError }
    try { await Filesystem.rename({ from: temporaryPath, to: path, directory: Directory.Data }) } catch (replacementError) {
      try { await Filesystem.rename({ from: backupPath, to: path, directory: Directory.Data }) } catch { /* original error is actionable */ }
      throw replacementError
    }
    try { await Filesystem.deleteFile({ path: backupPath, directory: Directory.Data }) } catch { /* new image is durable */ }
  }
}

export async function recoverPersistedImageAsset(projectId: string, assetId: string, minModifiedAt = 0): Promise<StoredImageSource | undefined> {
  if (!Capacitor.isNativePlatform()) return undefined
  for (const extension of IMAGE_EXTENSIONS) {
    const path = imagePathFor(projectId, assetId, extension)
    try {
      const stat = await Filesystem.stat({ path, directory: Directory.Data })
      const modifiedAt = Math.max(stat.mtime || 0, stat.ctime || 0)
      if (stat.type !== 'file' || stat.size <= 0 || modifiedAt < minModifiedAt || !await persistedImageFormat(path)) continue
      return { imageUrl: '', localUri: stat.uri || (await Filesystem.getUri({ path, directory: Directory.Data })).uri }
    } catch { /* probe next supported extension */ }
  }
  return undefined
}

export async function persistImageAsset(source: string | GeneratedImageSource, projectId: string, assetId: string, origin: ImageAssetOrigin = 'generated', onStageChange?: ImageAssetPersistenceStageCallback): Promise<StoredImageSource> {
  const normalizedSource: GeneratedImageSource = typeof source === 'string' ? { kind: 'inline', dataUrl: source } : source
  if (!Capacitor.isNativePlatform()) return { imageUrl: normalizedSource.kind === 'inline' ? normalizedSource.dataUrl : normalizedSource.kind === 'remote' ? normalizedSource.url : normalizedSource.localUri }
  if (normalizedSource.kind === 'local') return { imageUrl: '', localUri: normalizedSource.localUri }
  if (normalizedSource.kind === 'remote') return persistRemoteImageAsset(normalizedSource, projectId, assetId, origin, onStageChange)

  const imageDirectory = imageDirectoryFor(projectId)
  try { await Filesystem.stat({ path: imageDirectory, directory: Directory.Data }) } catch { await Filesystem.mkdir({ path: imageDirectory, directory: Directory.Data, recursive: true }) }
  if (!normalizedSource.dataUrl.startsWith('data:')) throw new Error('图片数据尚未下载为可保存的格式')
  const { mimeType, base64 } = dataUrlParts(normalizedSource.dataUrl)
  const extension = imageFormatFromBase64Head(base64) ?? extensionForMime(mimeType)
  if (!extension) throw new Error('图片数据不完整，无法识别格式')
  const path = imagePathFor(projectId, assetId, extension)
  const temporaryPath = imagePathFor(projectId, assetId, 'tmp')
  const saveStartedAt = Date.now()
  try {
    onStageChange?.('saving')
    await withTimeout(writeBase64InChunks(temporaryPath, base64), IMAGE_SAVE_TIMEOUT_MS, '保存图片超过 120 秒仍未完成')
    const writeCompletedAt = Date.now()
    onStageChange?.('validating')
    if (!await persistedImageFormat(temporaryPath)) throw new Error('图片文件不完整')
    await replaceTemporaryImage(temporaryPath, path)
    const localUri = (await Filesystem.getUri({ path, directory: Directory.Data })).uri
    const completedAt = Date.now()
    logImagePipeline('info', { phase: 'native-persist-complete', assetId, origin, format: extension, approximateBytes: approximateBase64Bytes(base64), chunks: Math.ceil(base64.length / IMAGE_WRITE_CHUNK_SIZE), writeMs: writeCompletedAt - saveStartedAt, validationAndReplaceMs: completedAt - writeCompletedAt, durationMs: completedAt - saveStartedAt })
    return { imageUrl: '', localUri }
  } catch (error) {
    logImagePipeline('warn', { phase: 'native-persist-failed', assetId, origin, durationMs: Date.now() - saveStartedAt, message: error instanceof Error ? error.message : String(error) })
    const recovered = await recoverPersistedImageAsset(projectId, assetId, saveStartedAt)
    if (recovered?.localUri) return recovered
    const detail = error instanceof Error && error.message ? `（${error.message}）` : ''
    const action = origin === 'imported' ? '参考图' : '图片已生成，但'
    throw new Error(`${action}无法保存到手机本地${detail}`)
  }
}

async function persistRemoteImageAsset(source: Extract<GeneratedImageSource, { kind: 'remote' }>, projectId: string, assetId: string, origin: ImageAssetOrigin, onStageChange?: ImageAssetPersistenceStageCallback): Promise<StoredImageSource> {
  const downloadStartedAt = Date.now()
  try {
    const bearerToken = source.auth?.kind === 'bearer' ? await secretStore.get(source.auth.secretRef) ?? undefined : undefined
    if (source.auth && !bearerToken) throw new Error('请填写 API Key')
    onStageChange?.('saving')
    const stored = await nativeImageAssetStore.download({ url: source.url, projectId, assetId, bearerToken })
    onStageChange?.('validating')
    logImagePipeline('info', { phase: 'native-url-persist-complete', assetId, origin, format: stored.format, bytes: stored.bytes, usesProviderAuth: Boolean(source.auth), responseMs: stored.responseMs, writeMs: stored.writeMs, validationAndReplaceMs: stored.validationAndReplaceMs, durationMs: stored.durationMs })
    return { imageUrl: '', localUri: stored.localUri }
  } catch (error) {
    const status = typeof error === 'object' && error ? (error as { status?: unknown; data?: { status?: unknown } }).status ?? (error as { data?: { status?: unknown } }).data?.status : undefined
    logImagePipeline('warn', { phase: 'native-url-persist-failed', assetId, origin, usesProviderAuth: Boolean(source.auth), durationMs: Date.now() - downloadStartedAt, status: typeof status === 'number' ? status : undefined, message: error instanceof Error ? error.message : String(error) })
    if (!source.auth && (status === 401 || status === 403)) throw new Error('图片 URL 位于第三方地址且拒绝匿名读取。为避免泄露 API Key，应用不会向该地址发送凭据；请让服务返回 b64_json 或可公开读取的签名 URL。', { cause: error })
    const action = origin === 'imported' ? '参考图' : '图片已生成，但'
    throw new Error(`${action}无法下载并保存到手机本地`, { cause: error })
  }
}
