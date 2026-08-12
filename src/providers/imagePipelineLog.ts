import { Capacitor, registerPlugin } from '@capacitor/core'

interface NativeImagePipelineLoggerPlugin {
  write(options: { level: 'info' | 'warn'; message: string }): Promise<void>
}

const NativeImagePipelineLogger = registerPlugin<NativeImagePipelineLoggerPlugin>('ImagePipelineLogger')
const ALLOWED_FIELDS = new Set([
  'phase', 'operation', 'model', 'responseMode', 'durationMs', 'approximateBytes',
  'usesProviderAuth', 'referenceCount', 'origin', 'format', 'chunks', 'writeMs',
  'validationAndReplaceMs', 'usesReferences', 'bytes', 'responseMs', 'status',
])

function safeDetails(details: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(details).filter(([key, value]) => (
    ALLOWED_FIELDS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)
  )))
}

export function logImagePipeline(level: 'info' | 'warn', details: Record<string, unknown>) {
  const message = JSON.stringify(safeDetails(details))
  if (Capacitor.isNativePlatform()) {
    void NativeImagePipelineLogger.write({ level, message }).catch(() => undefined)
    return
  }
  const browserMessage = `[image-pipeline] ${message}`
  if (level === 'warn') {
    console.warn(browserMessage)
    return
  }
  console.info(browserMessage)
}
