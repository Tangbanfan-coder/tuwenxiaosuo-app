import embeddedLimits from '../data/model-limits.min.json'

export interface ModelLimit {
  context: number
  output?: number
}

/**
 * The reasoning controls advertised by models.dev. These values describe
 * capabilities only; request field names and JSON shapes belong to an
 * endpoint adapter (see endpointReasoningAdapters.ts).
 *
 * The index signature deliberately keeps fields added by models.dev intact
 * when the table is refreshed. Known fields are still validated at the data
 * boundary below before they are exposed to the rest of the app.
 */
export type ReasoningOption =
  | ({ type: 'toggle' } & Record<string, unknown>)
  | ({ type: 'effort'; values: string[] } & Record<string, unknown>)
  | ({ type: 'budget_tokens'; min?: number; max?: number } & Record<string, unknown>)

export interface ModelReasoningCapabilities {
  reasoning: boolean
  options: ReasoningOption[]
  effortValues?: string[]
  budgetRange?: { min?: number; max?: number }
}

export const MODEL_LIMIT_URLS = [
  'https://cdn.jsdelivr.net/gh/Tangbanfan-coder/tuwenxiaosuo-app@main/data/model-limits.min.json',
  'https://raw.githubusercontent.com/Tangbanfan-coder/tuwenxiaosuo-app/main/data/model-limits.min.json',
] as const
const CACHE_KEY = 'illustrated-story-chat.model-limits.cache.v2'
const CHECKED_KEY = 'illustrated-story-chat.model-limits.checked.v2'
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

interface LimitEntry {
  m: string
  c: number
  o?: number
  p?: string
  rg?: 0 | 1
  ro?: ReasoningOption[]
}

interface LimitsPayload {
  schemaVersion?: number
  generatedAt?: string
  models: LimitEntry[]
}

let runtimeModels: LimitEntry[] = embeddedLimits.models as LimitEntry[]

const EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isReasoningOption(value: unknown): value is ReasoningOption {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'toggle') return true
  if (value.type === 'effort') {
    return Array.isArray(value.values)
      && value.values.every((item) => typeof item === 'string' && item.trim().length > 0)
  }
  if (value.type === 'budget_tokens') {
    return (value.min === undefined || (typeof value.min === 'number' && Number.isFinite(value.min) && value.min >= 0))
      && (value.max === undefined || (typeof value.max === 'number' && Number.isFinite(value.max) && value.max >= 0))
      && (value.min === undefined || value.max === undefined || value.min <= value.max)
  }
  return false
}

function isLimitEntry(value: unknown): value is LimitEntry {
  if (!isRecord(value)
    || typeof value.m !== 'string' || !value.m.trim()
    || typeof value.c !== 'number' || !Number.isFinite(value.c) || value.c <= 0
    || (value.o !== undefined && (typeof value.o !== 'number' || !Number.isFinite(value.o) || value.o <= 0))
    || (value.p !== undefined && (typeof value.p !== 'string' || !value.p.trim()))
    || (value.rg !== undefined && value.rg !== 0 && value.rg !== 1)
    || (value.ro !== undefined && (!Array.isArray(value.ro) || !value.ro.every(isReasoningOption)))) {
    return false
  }
  return true
}

function isValidModelEntries(value: unknown): value is LimitEntry[] {
  return Array.isArray(value) && value.length > 0 && value.every(isLimitEntry)
}

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

function modelVariants(modelId: string) {
  const variants = new Set<string>()
  const add = (value: string) => {
    const normalized = value.trim().toLocaleLowerCase()
    if (!normalized) return
    variants.add(normalized)
    const stripped = stripVendorPrefix(normalized)
    if (stripped) variants.add(stripped)
  }
  add(modelId)
  return [...variants]
}

function matchesModelId(entryModelId: string, requestedModelId: string) {
  const candidates = modelVariants(entryModelId)
  const requested = modelVariants(requestedModelId)
  for (const candidate of candidates) {
    for (const normalized of requested) {
      if (candidate === normalized) return true
    }
  }
  for (const candidate of candidates.sort((left, right) => right.length - left.length)) {
    for (const normalized of requested) {
      const exactMatch = normalized.startsWith(candidate)
        && (normalized[candidate.length] === undefined || /[:/\-._\s]/.test(normalized[candidate.length] ?? ''))
      const reverseMatch = candidate.startsWith(normalized)
        && /[:/\-._\s]/.test(candidate[normalized.length] ?? '')
      if (exactMatch || reverseMatch) return true
    }
  }
  return false
}

function reasoningCapabilitiesFromEntry(entry: LimitEntry): ModelReasoningCapabilities | undefined {
  if (entry.rg === undefined) return undefined
  const options = entry.ro ?? []
  const effortOption = options.find((option) => option.type === 'effort')
  const budgetOption = options.find((option) => option.type === 'budget_tokens')
  const effortValues = effortOption?.type === 'effort'
    ? effortOption.values.filter((value) => EFFORT_VALUES.has(value.toLocaleLowerCase()))
    : undefined
  const budgetRange = budgetOption?.type === 'budget_tokens'
    ? {
        ...(budgetOption.min === undefined ? {} : { min: budgetOption.min }),
        ...(budgetOption.max === undefined ? {} : { max: budgetOption.max }),
      }
    : undefined
  return {
    reasoning: entry.rg === 1,
    options,
    ...(effortValues === undefined ? {} : { effortValues }),
    ...(budgetRange && Object.keys(budgetRange).length ? { budgetRange } : {}),
  }
}

/**
 * Looks up reasoning capabilities using the models.dev provider ID and model
 * ID as a joint key. Unlike context-window lookup, this function intentionally
 * never falls back to an entry belonging to another provider: the same model
 * name may have different controls and legal values on different routes.
 */
export function lookupReasoningCapabilities(providerId: string, modelId: string): ModelReasoningCapabilities | undefined {
  const provider = providerId.trim().toLocaleLowerCase()
  if (!provider || !modelId.trim()) return undefined
  const candidates = runtimeModels
    .filter((entry) => entry.p?.trim().toLocaleLowerCase() === provider)
    .sort((left, right) => right.m.length - left.m.length)
  const match = candidates.find((entry) => matchesModelId(entry.m, modelId))
  return match ? reasoningCapabilitiesFromEntry(match) : undefined
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
  if (id.includes('grok')) return 256_000
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

export type ModelWindowSource = 'manual' | 'provider-metadata' | 'model-table' | 'heuristic' | 'unknown-default'

export interface ResolvedModelWindow {
  tokens: number
  source: ModelWindowSource
}

/**
 * Single resolution order for a model's context window, with an explicit
 * source for each outcome so the UI and errors can tell manual settings apart
 * from table/heuristic values:
 *   manual (user override) > provider-metadata (from the /models list) >
 *   model-table (embedded/remote table) > heuristic (name matching) >
 *   unknown-default (32k fallback).
 */
export function resolveModelWindow(config: { manualContextLength?: number; contextLength?: number; model: string }): ResolvedModelWindow {
  if (config.manualContextLength && config.manualContextLength > 0) {
    return { tokens: config.manualContextLength, source: 'manual' }
  }
  if (config.contextLength && config.contextLength > 0) {
    return { tokens: config.contextLength, source: 'provider-metadata' }
  }
  const fromTable = lookupModelLimit(config.model)
  if (fromTable) return { tokens: fromTable.context, source: 'model-table' }
  const heuristic = heuristicModelContextTokens(config.model)
  if (heuristic !== UNKNOWN_MODEL_CONTEXT_TOKENS) return { tokens: heuristic, source: 'heuristic' }
  return { tokens: heuristic, source: 'unknown-default' }
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
        const cached = JSON.parse(raw) as { schemaVersion?: number; etag?: string; models?: unknown }
        if (cached.schemaVersion === 2 && isValidModelEntries(cached.models)) runtimeModels = cached.models
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
          if (raw) {
            const cached = JSON.parse(raw) as { schemaVersion?: number; etag?: string }
            if (cached.schemaVersion === 2) etag = cached.etag ?? ''
          }
        } catch {
          etag = ''
        }
        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), 10_000)
        try {
          for (const url of MODEL_LIMIT_URLS) {
            let response: Response
            try {
              response = await fetch(url, {
                headers: etag ? { 'If-None-Match': etag } : undefined,
                signal: controller.signal,
              })
            } catch {
              if (controller.signal.aborted) throw new Error('模型表更新超时')
              continue
            }
            if (response.status === 304) {
              checked = true
              break
            }
            if (response.status !== 200) continue

            let payload: LimitsPayload
            try {
              payload = await response.json() as LimitsPayload
            } catch {
              continue
            }
            const valid = payload.schemaVersion === 2 && isValidModelEntries(payload.models)
            if (!valid) continue

            runtimeModels = payload.models
            localStorage.setItem(CACHE_KEY, JSON.stringify({
              schemaVersion: 2,
              generatedAt: payload.generatedAt,
              etag: response.headers.get('etag') ?? '',
              models: payload.models,
            }))
            checked = true
            break
          }
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
