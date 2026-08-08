export type ProviderSlot = 'text' | 'image'
export type SecretRef = string

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
}

export interface TransportResponse<T> {
  status: number
  data: T
}

export interface HttpTransport {
  request<T>(request: TransportRequest): Promise<TransportResponse<T>>
  stream(request: TransportRequest, onDelta: (delta: string) => void): Promise<string>
}
