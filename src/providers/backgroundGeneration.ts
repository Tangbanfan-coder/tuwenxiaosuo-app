import { Capacitor, registerPlugin } from '@capacitor/core'
import { secretStore } from './secretStore'

export type BackgroundTaskState = 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type BackgroundTaskKind = 'text' | 'image'

export interface BackgroundTask {
  id: string
  kind: BackgroundTaskKind
  state: BackgroundTaskState
  error?: string
  rawResponse?: string
  localUri?: string
  bytes?: number
  format?: string
  responseMode?: 'url' | 'b64_json'
  responseMs?: number
  writeMs?: number
  validationAndReplaceMs?: number
  durationMs?: number
  metadata?: Record<string, unknown>
}

interface NativeBackgroundGeneration {
  enqueue(options: Record<string, unknown>): Promise<{ id: string; state: BackgroundTaskState }>
  list(): Promise<{ tasks: BackgroundTask[] }>
  readResult(options: { id: string }): Promise<BackgroundTask>
  acknowledge(options: { id: string }): Promise<void>
  cancel(options: { id: string }): Promise<void>
}

const NativeBackgroundGeneration = registerPlugin<NativeBackgroundGeneration>('BackgroundGeneration')

export function supportsBackgroundGeneration() {
  return Capacitor.isNativePlatform() && typeof Capacitor.getPlatform === 'function' && Capacitor.getPlatform() === 'android'
}

export class BackgroundTaskUncertainError extends Error {
  constructor(message = '请求已发出，等待补收结果；状态不明时不会自动重试') { super(message); this.name = 'BackgroundTaskUncertainError' }
}

async function enqueue(kind: BackgroundTaskKind, secretRef: string, request: Record<string, unknown>) {
  if (!supportsBackgroundGeneration()) return undefined
  const bearerToken = await secretStore.get(secretRef)
  if (!bearerToken) throw new Error('请填写 API Key')
  return NativeBackgroundGeneration.enqueue({ kind, secretRef, bearerToken, ...request })
}

export async function enqueueBackgroundTextTask(request: {
  endpoint: string
  body: string
  secretRef: string
  metadata: { projectId: string; userMessageId: string; noticeId: string; autoIllustrate: boolean; forceNewChapter: boolean }
}) {
  return enqueue('text', request.secretRef, request)
}

export async function enqueueBackgroundImageTask(request: {
  endpoint: string
  model: string
  prompt: string
  size: string
  projectId: string
  assetId: string
  secretRef: string
  referenceSources?: string[]
  responseFormat?: 'b64_json'
  metadata: { target: 'illustration' | 'portrait'; assetId: string; projectId: string }
}) {
  return enqueue('image', request.secretRef, request)
}

export async function listBackgroundGenerationTasks() {
  if (!supportsBackgroundGeneration()) return []
  return (await NativeBackgroundGeneration.list()).tasks
}

export async function readBackgroundGenerationTask(id: string) {
  if (!supportsBackgroundGeneration()) return undefined
  return NativeBackgroundGeneration.readResult({ id })
}

export async function acknowledgeBackgroundGenerationTask(id: string) {
  if (!supportsBackgroundGeneration()) return
  await NativeBackgroundGeneration.acknowledge({ id })
}

/** Requests native cancellation for an in-flight task. Cancelling local receipt never guarantees the upstream request was revoked. */
export async function cancelBackgroundGenerationTask(id: string) {
  if (!supportsBackgroundGeneration()) return
  await NativeBackgroundGeneration.cancel({ id })
}

/** Does not retry or recreate a task. It only observes the single native request. */
export async function waitForBackgroundGenerationTask(id: string, intervalMs = 800): Promise<BackgroundTask> {
  while (true) {
    const task = await readBackgroundGenerationTask(id)
    if (!task) throw new Error('后台任务不可用')
    if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled' || task.state === 'unknown') return task
    await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs))
  }
}
