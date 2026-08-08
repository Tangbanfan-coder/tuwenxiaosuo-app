import embeddedLimits from '../data/model-limits.min.json'

export interface ModelLimit {
  context: number
  output?: number
}

const ONLINE_URL = 'https://raw.githubusercontent.com/Tangbanfan-coder/tuwenxiaosuo-app/main/data/model-limits.min.json'
const CACHE_KEY = 'illustrated-story-chat.model-limits.cache.v1'
const CHECKED_KEY = 'illustrated-story-chat.model-limits.checked.v1'
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

interface LimitEntry {
  m: string
  c: number
  o?: number
}

interface LimitsPayload {
  generatedAt?: string
  models: LimitEntry[]
}

let runtimeModels: LimitEntry[] = embeddedLimits.models

function stripVendorPrefix(modelId: string) {
  const slash = modelId.indexOf('/')
  return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

function pickLimit(modelId: string): ModelLimit | undefined {
  const variants = [modelId.toLocaleLowerCase(), stripVendorPrefix(modelId).toLocaleLowerCase()]
  for (const normalized of variants) {
    const exact = runtimeModels.find((model) => model.m.toLocaleLowerCase() === normalized)
    if (exact) return { context: exact.c, output: exact.o }
  }
  for (const model of runtimeModels) {
    const candidate = model.m.toLocaleLowerCase()
    for (const normalized of variants) {
      const exactMatch = normalized.startsWith(candidate) && (normalized[candidate.length] === undefined || /[:/\-._\s]/.test(normalized[candidate.length] ?? ''))
      const reverseMatch = candidate.startsWith(normalized) && /[:/\-._\s]/.test(candidate[normalized.length] ?? '')
      if (exactMatch || reverseMatch) return { context: model.c, output: model.o }
    }
  }
  return undefined
}

export function lookupModelLimit(modelId: string): ModelLimit | undefined {
  if (!modelId.trim()) return undefined
  return pickLimit(modelId)
}

const UNKNOWN_MODEL_CONTEXT_TOKENS = 32_000

export function heuristicModelContextTokens(modelId: string) {
  const id = modelId.toLocaleLowerCase()
  if (id.includes('gemini')) {
    if (id.includes('1.0') || id.includes('gemini-pro-v1')) return 32_000
    return 1_000_000
  }
  if (id.includes('claude')) {
    if (/claude[\s-]?[12][.\s-]/.test(id)) return 100_000
    return 200_000
  }
  if (id.includes('gpt-4')) {
    if (id.includes('32k')) return 32_000
    if (id.includes('4o') || id.includes('turbo') || id.includes('1106') || id.includes('0125')) return 128_000
    if (id.includes('0613') || id.includes('0314') || id.includes('base')) return 8_000
    return 8_000
  }
  if (id.includes('o1') || id.includes('o3') || id.includes('o4')) return 128_000
  if (id.includes('gpt-3.5')) return 8_000
  if (id.includes('deepseek')) return 64_000
  if (id.includes('qwen') || id.includes('qwq')) {
    if (id.includes('qwen3') || id.includes('qwq')) return 128_000
    return 32_000
  }
  if (id.includes('glm') || id.includes('chatglm')) {
    if (id.includes('glm-4') || id.includes('glm4')) return 128_000
    return 32_000
  }
  if (id.includes('moonshot') || id.includes('kimi')) return 128_000
  if (id.includes('ernie') || id.includes('文心')) return 128_000
  if (id.includes('minimax')) return 128_000
  if (id.includes('yi-')) return 32_000
  if (id.includes('llama-3.1') || id.includes('llama-3.3')) return 128_000
  if (id.includes('llama-3')) return 8_000
  if (id.includes('llama-2')) return 4_000
  if (id.includes('mistral') || id.includes('mixtral')) return 32_000
  return UNKNOWN_MODEL_CONTEXT_TOKENS
}

export function isModelKnown(modelId: string) {
  return Boolean(lookupModelLimit(modelId) || heuristicModelContextTokens(modelId) !== UNKNOWN_MODEL_CONTEXT_TOKENS)
}

export function withModelMetadata<T extends { model: string }>(current: T, model: { id: string; contextLength?: number; maxOutputTokens?: number }): T {
  return {
    ...current,
    model: model.id,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
  }
}

export function refreshModelLimits(): Promise<void> {
  return new Promise((resolve) => {
    const applyCached = () => {
      try {
        const raw = localStorage.getItem(CACHE_KEY)
        if (!raw) return
        const cached = JSON.parse(raw) as { etag?: string; models?: LimitEntry[] }
        if (Array.isArray(cached.models) && cached.models.length) runtimeModels = cached.models
      } catch {
        // Corrupted cache; keep the embedded table.
      }
    }

    const checkOnline = async () => {
      let checked = false
      try {
        let etag = ''
        try {
          const raw = localStorage.getItem(CACHE_KEY)
          if (raw) etag = (JSON.parse(raw) as { etag?: string }).etag ?? ''
        } catch {
          etag = ''
        }
        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), 10_000)
        try {
          const response = await fetch(ONLINE_URL, {
            headers: etag ? { 'If-None-Match': etag } : undefined,
            signal: controller.signal,
          })
          if (response.status === 200) {
            const payload = await response.json() as LimitsPayload
            const valid = Array.isArray(payload.models) && payload.models.length
              && payload.models.every((model) =>
                typeof model.m === 'string' && model.m.trim()
                && typeof model.c === 'number' && Number.isFinite(model.c) && model.c > 0
                && (model.o === undefined || (typeof model.o === 'number' && Number.isFinite(model.o) && model.o > 0)))
            if (valid) {
              runtimeModels = payload.models
              localStorage.setItem(CACHE_KEY, JSON.stringify({
                etag: response.headers.get('etag') ?? '',
                models: payload.models,
              }))
            }
          }
          checked = response.status === 200 || response.status === 304
        } finally {
          window.clearTimeout(timeout)
        }
      } catch {
        // Network failure: do not mark as checked so the next launch retries.
      }
      if (checked) {
        try {
          localStorage.setItem(CHECKED_KEY, String(Date.now()))
        } catch {
          // Storage unavailable.
        }
      }
    }

    applyCached()
    try {
      const lastChecked = Number(localStorage.getItem(CHECKED_KEY) ?? 0)
      if (Date.now() - lastChecked >= CHECK_INTERVAL_MS) {
        void checkOnline().finally(resolve)
        return
      }
    } catch {
      // Storage unavailable; nothing to do.
    }
    resolve()
  })
}
