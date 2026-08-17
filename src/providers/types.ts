export type ProviderSlot = 'text' | 'image'
export type SecretRef = string
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high'

/**
 * Provider capability model. Each field is optional: an absent field keeps
 * the legacy "auto" behavior (infer from the request context / model id).
 * Only the unified capability resolution in providerCapabilities.ts reads
 * these values; request call sites must never re-implement the decision.
 */
export type ReasoningEffortParameter = 'auto' | 'supported' | 'unsupported'
export type OutputTokenParameter = 'auto' | 'max_tokens' | 'max_completion_tokens' | 'none'
export type TextTransport = 'auto' | 'stream' | 'non-stream'
export type VisionInput = 'auto' | 'supported' | 'unsupported'
export type ImageEdits = 'auto' | 'supported' | 'unsupported'
export type TokenizerStrategy = 'auto' | 'o200k_base' | 'conservative'

export interface ProviderCapabilities {
  /** Whether reasoning_effort is accepted. 'unsupported' never sends it. */
  reasoningEffortParameter?: ReasoningEffortParameter
  /** Which output-token parameter name to send. 'auto' infers from the model id. */
  outputTokenParameter?: OutputTokenParameter
  /** Preferred chat transport. 'auto' lets the call site decide (Web streams, Android background does not). */
  textTransport?: TextTransport
  /** Whether the text model accepts image_url vision input. */
  visionInput?: VisionInput
  /** Whether /images/edits multipart editing is supported. */
  imageEdits?: ImageEdits
  /** Maximum number of reference images accepted by the image provider. */
  maxReferenceImages?: number
  /** Sizes the image provider accepts, e.g. ['1024x1024', '1024x1536']. */
  imageSizes?: string[]
  /** Preferred portrait (character) generation size. */
  portraitSize?: string
  /** Preferred scene (illustration) generation size. */
  sceneSize?: string
  /** Token estimation strategy. 'conservative' over-estimates deliberately. */
  tokenizerStrategy?: TokenizerStrategy
}

export type RequestAuth = { kind: 'bearer'; secretRef: SecretRef }

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  protocol: 'openai-compatible'
  secretRef: SecretRef
  contextLength?: number
  maxOutputTokens?: number
  manualContextLength?: number
  manualMaxOutputTokens?: number
  androidStreamingEnabled?: boolean
  reasoningEffort?: ReasoningEffort
  /** Provider capability model; absent keeps legacy auto-inference behavior. */
  capabilities?: ProviderCapabilities
}

export interface ProviderSettings {
  text: ProviderConfig
  image: ProviderConfig
  textProviders: ProviderConfig[]
  imageProviders: ProviderConfig[]
}

export interface ModelSummary {
  id: string
  ownedBy?: string
  contextLength?: number
  maxOutputTokens?: number
}

export interface ModelListResult {
  models: ModelSummary[]
  baseUrl: string
}

export interface TransportRequest {
  url: string
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  auth?: RequestAuth
  body?: BodyInit
  timeoutMs?: number
  androidTransport?: 'native' | 'webview-stream'
  /** Caller-provided cancellation, combined with the transport's own timeout. */
  signal?: AbortSignal
}

export interface TransportResponse<T> {
  status: number
  data: T
}

export interface ImageDownloadRequest {
  url: string
  auth?: RequestAuth
  timeoutMs?: number
}

export type GeneratedImageSource =
  | { kind: 'inline'; dataUrl: string }
  | { kind: 'remote'; url: string; auth?: RequestAuth }
  | { kind: 'local'; localUri: string }

/** Identifies the native file that a generated image may be written into. */
export interface NativeImagePersistenceTarget {
  projectId: string
  assetId: string
  target?: 'illustration' | 'portrait'
}

export interface HttpTransport {
  request<T>(request: TransportRequest): Promise<TransportResponse<T>>
  stream(request: TransportRequest, onDelta?: (delta: string) => void): Promise<string>
  /** Resolves an image URL to a usable source without exposing credentials to callers. */
  resolveImageSource?(request: ImageDownloadRequest): Promise<string>
}
