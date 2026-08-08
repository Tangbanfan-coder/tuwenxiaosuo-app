import type { HttpTransport, ModelListResult, ModelSummary, ProviderConfig } from './types'

interface ModelsResponse {
  data?: Array<{
    id?: unknown
    owned_by?: unknown
    context_length?: unknown
    inputTokenLimit?: unknown
    outputTokenLimit?: unknown
  }>
}

function positiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '')
}

function candidateBaseUrls(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl)
  const parsed = new URL(normalized)
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path.endsWith('/v1')) return [normalized]
  return [normalized, `${normalized}/v1`]
}

export async function listOpenAiModels(
  config: ProviderConfig,
  transport: HttpTransport,
): Promise<ModelListResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl) throw new Error('请填写 API URL')

  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new Error('API URL 格式不正确')
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('API URL 只支持 HTTP 或 HTTPS')
  }

  let lastError: unknown
  for (const candidate of candidateBaseUrls(baseUrl)) {
    try {
      const response = await transport.request<ModelsResponse>({
        url: `${candidate}/models`,
        method: 'GET',
        auth: { kind: 'bearer', secretRef: config.secretRef },
      })
      if (!Array.isArray(response.data.data)) throw new Error('接口没有返回 OpenAI 兼容的模型列表')
      const models: ModelSummary[] = response.data.data
        .filter((model): model is Record<string, unknown> & { id: string } => typeof model.id === 'string')
        .map((model) => ({
          id: model.id,
          ownedBy: typeof model.owned_by === 'string' ? model.owned_by : undefined,
          contextLength: positiveNumber(model.context_length) ?? positiveNumber(model.inputTokenLimit),
          maxOutputTokens: positiveNumber(model.outputTokenLimit),
        }))
      return { models, baseUrl: candidate }
    } catch (error) {
      lastError = error
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined
      if (status === 401 || status === 403) break
    }
  }
  throw lastError instanceof Error ? lastError : new Error('无法连接兼容接口')
}
