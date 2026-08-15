import { Capacitor, registerPlugin } from '@capacitor/core'
import { acknowledgeBackgroundGenerationTask, enqueueBackgroundImageTask, waitForBackgroundGenerationTask } from '../backgroundGeneration'
import { logImagePipeline } from '../imagePipelineLog'
import { secretStore } from '../secretStore'
import type { NativeImagePersistenceTarget } from '../types'
import type { ImageFormat, StoredImageSource } from './fileSupport'

interface NativeImageAssetStorePlugin {
  download(options: { url: string; projectId: string; assetId: string; bearerToken?: string }): Promise<NativeImageStorageResult>
  generate(options: { endpoint: string; model: string; prompt: string; size: string; projectId: string; assetId: string; bearerToken: string; referenceSources?: string[]; responseFormat?: 'b64_json' }): Promise<NativeImageGenerationResult>
}

export interface NativeImageStorageResult { localUri: string; format: ImageFormat; bytes: number; responseMs: number; writeMs: number; validationAndReplaceMs: number; durationMs: number }
interface NativeImageGenerationResult extends NativeImageStorageResult { responseMode: 'url' | 'b64_json' }
export const nativeImageAssetStore = registerPlugin<NativeImageAssetStorePlugin>('ImageAssetStore')

export interface NativeImageGenerationRequest { endpoint: string; model: string; prompt: string; size: string; target: NativeImagePersistenceTarget; secretRef: string; referenceSources?: string[]; responseFormat?: 'b64_json' }

export async function generateNativeImageAsset(request: NativeImageGenerationRequest): Promise<StoredImageSource | undefined> {
  if (!Capacitor.isNativePlatform()) return undefined
  const startedAt = Date.now()
  try {
    const background = await enqueueBackgroundImageTask({ endpoint: request.endpoint, model: request.model, prompt: request.prompt, size: request.size, projectId: request.target.projectId, assetId: request.target.assetId, secretRef: request.secretRef, referenceSources: request.referenceSources, responseFormat: request.responseFormat, metadata: { target: request.target.target ?? 'illustration', assetId: request.target.assetId, projectId: request.target.projectId } })
    if (!background) {
      const bearerToken = await secretStore.get(request.secretRef)
      if (!bearerToken) throw new Error('请填写 API Key')
      const stored = await nativeImageAssetStore.generate({ endpoint: request.endpoint, model: request.model, prompt: request.prompt, size: request.size, projectId: request.target.projectId, assetId: request.target.assetId, bearerToken, referenceSources: request.referenceSources, responseFormat: request.responseFormat })
      return { imageUrl: '', localUri: stored.localUri }
    }
    const completed = await waitForBackgroundGenerationTask(background.id)
    if (completed.state !== 'completed' || !completed.localUri) throw new Error(completed.error || '后台图片生成未完成')
    logImagePipeline('info', { phase: 'native-generation-persist-complete', operation: request.referenceSources?.length ? 'edit' : 'generation', format: completed.format, bytes: completed.bytes, responseMode: completed.responseMode, referenceCount: request.referenceSources?.length, responseMs: completed.responseMs, writeMs: completed.writeMs, validationAndReplaceMs: completed.validationAndReplaceMs, durationMs: completed.durationMs })
    await acknowledgeBackgroundGenerationTask(background.id)
    return { imageUrl: '', localUri: completed.localUri }
  } catch (error) {
    logImagePipeline('warn', { phase: 'native-generation-persist-failed', operation: request.referenceSources?.length ? 'edit' : 'generation', referenceCount: request.referenceSources?.length, durationMs: Date.now() - startedAt, message: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
