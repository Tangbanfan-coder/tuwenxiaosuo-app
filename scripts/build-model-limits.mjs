import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SOURCE_URL = 'https://models.dev/api.json'
const OUTPUT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'model-limits.min.json')
const PUBLIC_OUTPUT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'model-limits.min.json')

const PROVIDER_WHITELIST = new Set([
  'openai', 'anthropic', 'google', 'deepseek', 'moonshotai', 'zhipuai',
  'alibaba', 'minimax', 'xai', 'mistral', 'meta', 'stepfun', 'openrouter',
  'siliconflow',
])

const REASONING_OPTION_TYPES = new Set(['toggle', 'effort', 'budget_tokens'])

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function normalizeReasoningOptions(options) {
  if (!Array.isArray(options)) return undefined
  const normalized = []
  for (const option of options) {
    if (!option || typeof option !== 'object' || !REASONING_OPTION_TYPES.has(option.type)) return undefined
    if (option.type === 'toggle') {
      normalized.push({ ...option, type: 'toggle' })
      continue
    }
    if (option.type === 'effort') {
      if (!Array.isArray(option.values) || !option.values.every((value) => typeof value === 'string' && value.trim())) return undefined
      normalized.push({ ...option, type: 'effort', values: [...option.values] })
      continue
    }
    if ((option.min !== undefined && !isFiniteNonNegative(option.min))
      || (option.max !== undefined && !isFiniteNonNegative(option.max))
      || (option.min !== undefined && option.max !== undefined && option.min > option.max)) return undefined
    normalized.push({ ...option, type: 'budget_tokens' })
  }
  return normalized
}

const response = await fetch(SOURCE_URL)
if (!response.ok) throw new Error(`models.dev 下载失败：HTTP ${response.status}`)
const raw = await response.json()

const entries = []
for (const [providerId, provider] of Object.entries(raw ?? {})) {
  if (!PROVIDER_WHITELIST.has(providerId)) continue
  if (!provider || typeof provider !== 'object') continue
  const models = provider.models
  if (!models || typeof models !== 'object') continue
  for (const [modelId, info] of Object.entries(models)) {
    if (!info || typeof info !== 'object') continue
    const outputModalities = info.modalities?.output
    const isChatModel = Array.isArray(outputModalities) && outputModalities.includes('text')
    if (!isChatModel) continue
    const limit = info.limit ?? {}
    if (typeof limit.context !== 'number' || limit.context <= 0) continue
    const maxOutput = limit.output
    const reasoningOptions = normalizeReasoningOptions(info.reasoning_options)
    entries.push({
      m: modelId,
      c: Math.floor(limit.context),
      ...(typeof maxOutput === 'number' && maxOutput > 0 ? { o: Math.floor(maxOutput) } : {}),
      p: providerId,
      ...(typeof info.reasoning === 'boolean' ? { rg: info.reasoning ? 1 : 0 } : {}),
      ...(reasoningOptions === undefined ? {} : { ro: reasoningOptions }),
    })
  }
}

entries.sort((a, b) => a.m.localeCompare(b.m))
const payload = JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(), models: entries })
mkdirSync(dirname(OUTPUT_FILE), { recursive: true })
writeFileSync(OUTPUT_FILE, payload, 'utf8')
mkdirSync(dirname(PUBLIC_OUTPUT_FILE), { recursive: true })
writeFileSync(PUBLIC_OUTPUT_FILE, payload, 'utf8')
console.log(`model-limits.min.json 已生成：${entries.length} 个模型，${(statSync(OUTPUT_FILE).size / 1024).toFixed(1)} KB`)
