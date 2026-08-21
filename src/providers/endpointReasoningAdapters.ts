import { lookupReasoningCapabilities, type ModelReasoningCapabilities } from './modelLimits'
import type { ProviderConfig, ReasoningEffort, ReasoningEffortOption } from './types'

export type ReasoningEffortValue = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type EndpointCapabilitiesSource = 'models.dev' | 'heuristic-only'

export interface EndpointReasoningAdapter {
  /** Exact lower-case URL hostname; ports and paths are intentionally ignored. */
  hostname: string
  /** models.dev provider ID used for the joint capability lookup. */
  providerId?: string
  capabilitiesSource: EndpointCapabilitiesSource
  encode(input: {
    effort: ReasoningEffortValue
    modelId: string
    capabilities: ModelReasoningCapabilities
  }): Record<string, unknown>
}

const EFFORT_ORDER: readonly ReasoningEffortValue[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_RANK = new Map(EFFORT_ORDER.map((value, index) => [value, index]))

const DEFAULT_BUDGETS: Record<'low' | 'medium' | 'high', number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
}

const EFFORT_LABELS: Record<Exclude<ReasoningEffort, 'auto'>, string> = {
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

export const LEGACY_REASONING_EFFORT_OPTIONS: readonly ReasoningEffortOption[] = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

export interface ReasoningEffortResolution {
  options: readonly ReasoningEffortOption[]
  official: boolean
  hint?: string
}

const AUTO_REASONING_OPTION: ReasoningEffortOption = { value: 'auto', label: '自动' }

function normalizeEffortValues(values: readonly string[] | undefined): Array<Exclude<ReasoningEffort, 'auto'>> {
  if (!values) return []
  const known = new Set<Exclude<ReasoningEffort, 'auto'>>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  const result: Array<Exclude<ReasoningEffort, 'auto'>> = []
  for (const value of values) {
    const normalized = value.trim().toLocaleLowerCase() as Exclude<ReasoningEffort, 'auto'>
    if (known.has(normalized) && !result.includes(normalized)) result.push(normalized)
  }
  return result
}

function hasOption(capabilities: ModelReasoningCapabilities, type: string) {
  return capabilities.options.some((option) => option.type === type)
}

function budgetFor(effort: ReasoningEffortValue, capabilities: ModelReasoningCapabilities) {
  if (!hasOption(capabilities, 'budget_tokens')) return undefined
  const defaultEffort = effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'high'
  let budget = DEFAULT_BUDGETS[defaultEffort]
  const range = capabilities.budgetRange
  if (range?.min !== undefined) budget = Math.max(budget, range.min)
  if (range?.max !== undefined) budget = Math.min(budget, range.max)
  return Math.max(0, Math.floor(budget))
}

function toggleFields(input: {
  effort: ReasoningEffortValue
  capabilities: ModelReasoningCapabilities
  field: 'enable_thinking' | 'thinking'
}) {
  const budget = budgetFor(input.effort, input.capabilities)
  const toggle = input.field === 'enable_thinking'
    ? { enable_thinking: true }
    : { thinking: { type: 'enabled' } }
  return budget === undefined ? toggle : { ...toggle, thinking_budget: budget }
}

function hasEffortControl(capabilities: ModelReasoningCapabilities) {
  return capabilities.options.some((option) => option.type === 'effort')
}

function deepseekAdapterEncode(input: Parameters<EndpointReasoningAdapter['encode']>[0]) {
  const toggle = hasOption(input.capabilities, 'toggle') ? { thinking: { type: 'enabled' } } : {}
  const effort = hasEffortControl(input.capabilities) ? { reasoning_effort: input.effort } : {}
  return { ...toggle, ...effort }
}

function zhipuAdapterEncode(input: Parameters<EndpointReasoningAdapter['encode']>[0]) {
  const effort = hasEffortControl(input.capabilities) ? { reasoning_effort: input.effort } : {}
  return { thinking: { type: 'enabled' }, ...effort }
}

function openAiAdapterEncode(input: Parameters<EndpointReasoningAdapter['encode']>[0]) {
  return { reasoning_effort: input.effort }
}

function dashScopeAdapterEncode(input: Parameters<EndpointReasoningAdapter['encode']>[0]) {
  return toggleFields({ effort: input.effort, capabilities: input.capabilities, field: 'enable_thinking' })
}

function moonshotAdapterEncode(input: Parameters<EndpointReasoningAdapter['encode']>[0]) {
  return { thinking: { type: 'enabled' } }
}

function siliconFlowAdapterEncode(input: Parameters<EndpointReasoningAdapter['encode']>[0]) {
  return toggleFields({ effort: input.effort, capabilities: input.capabilities, field: 'enable_thinking' })
}

function volcengineAdapterEncode(input: Parameters<EndpointReasoningAdapter['encode']>[0]) {
  return { thinking: { type: 'enabled' } }
}

/**
 * Official endpoints and their manually maintained wire encodings. The
 * capability table determines whether a model exposes toggle/effort/budget;
 * this registry determines the actual field names and object shape.
 */
export const ENDPOINT_REASONING_ADAPTERS: readonly EndpointReasoningAdapter[] = [
  {
    hostname: 'api.openai.com',
    providerId: 'openai',
    capabilitiesSource: 'models.dev',
    encode: openAiAdapterEncode,
  },
  {
    hostname: 'api.deepseek.com',
    providerId: 'deepseek',
    capabilitiesSource: 'models.dev',
    encode: deepseekAdapterEncode,
  },
  {
    hostname: 'dashscope.aliyuncs.com',
    providerId: 'alibaba',
    capabilitiesSource: 'models.dev',
    encode: dashScopeAdapterEncode,
  },
  {
    hostname: 'open.bigmodel.cn',
    providerId: 'zhipuai',
    capabilitiesSource: 'models.dev',
    encode: zhipuAdapterEncode,
  },
  {
    hostname: 'api.z.ai',
    providerId: 'zhipuai',
    capabilitiesSource: 'models.dev',
    encode: zhipuAdapterEncode,
  },
  {
    hostname: 'api.moonshot.cn',
    providerId: 'moonshotai',
    capabilitiesSource: 'models.dev',
    encode: moonshotAdapterEncode,
  },
  {
    hostname: 'api.moonshot.ai',
    providerId: 'moonshotai',
    capabilitiesSource: 'models.dev',
    encode: moonshotAdapterEncode,
  },
  {
    hostname: 'ark.cn-beijing.volces.com',
    capabilitiesSource: 'heuristic-only',
    encode: volcengineAdapterEncode,
  },
  {
    hostname: 'api.siliconflow.cn',
    providerId: 'siliconflow',
    capabilitiesSource: 'models.dev',
    encode: siliconFlowAdapterEncode,
  },
] as const

/** Resolves only the URL hostname; a suffix such as api.deepseek.com.example.org never matches. */
export function findEndpointReasoningAdapter(baseUrl: string): EndpointReasoningAdapter | undefined {
  try {
    const hostname = new URL(baseUrl).hostname.toLocaleLowerCase()
    return ENDPOINT_REASONING_ADAPTERS.find((adapter) => adapter.hostname === hostname)
  } catch {
    return undefined
  }
}

/**
 * Clamps a user-facing effort value upward to the nearest legal model value.
 * Unknown values advertised by a remote table are ignored, avoiding the
 * accidental transmission of a value that the endpoint does not understand.
 */
export function clampReasoningEffort(requested: ReasoningEffort, legalValues?: string[]): ReasoningEffortValue | undefined {
  if (requested === 'auto') return undefined
  if (legalValues === undefined) return undefined
  const legal = legalValues
    .map((value) => value.toLocaleLowerCase())
    .filter((value): value is ReasoningEffortValue => EFFORT_RANK.has(value as ReasoningEffortValue))
  if (!legal.length) return undefined
  const unique = [...new Set(legal)]
    .sort((left, right) => EFFORT_RANK.get(left)! - EFFORT_RANK.get(right)!)
  const requestedRank = EFFORT_RANK.get(requested as ReasoningEffortValue)!
  const selected = unique.find((value) => EFFORT_RANK.get(value)! >= requestedRank) ?? unique[unique.length - 1]
  return selected
}

/**
 * Conservative same-provider fallback used only when the provider is already
 * established by the endpoint registry and the model table has no entry. It
 * never guesses a protocol for an unknown/non-official endpoint.
 */
export function inferEndpointReasoningCapabilities(adapter: EndpointReasoningAdapter, modelId: string): ModelReasoningCapabilities | undefined {
  const id = modelId.toLocaleLowerCase()
  if (adapter.capabilitiesSource === 'heuristic-only') {
    if (!/(deepseek|qwen|qwq|glm|kimi|moonshot|doubao|reasoning|thinking)/i.test(id)) return undefined
    return { reasoning: true, options: [{ type: 'toggle' }] }
  }

  switch (adapter.providerId) {
    case 'deepseek': {
      if (!/deepseek-v4(?:[-.]|$)/i.test(id)) return undefined
      const values = id.includes('v4-pro') ? ['high', 'max'] : ['low', 'high', 'max']
      return { reasoning: true, options: [{ type: 'toggle' }, { type: 'effort', values }], effortValues: values }
    }
    case 'alibaba':
      if (!/(qwen|qwq|deepseek|glm)/i.test(id)) return undefined
      return { reasoning: true, options: [{ type: 'toggle' }, { type: 'budget_tokens' }] }
    case 'zhipuai':
      if (!/(glm|chatglm)/i.test(id)) return undefined
      if (/glm[-.]?5\.2/i.test(id)) {
        const values: ReasoningEffortValue[] = ['high', 'max']
        return { reasoning: true, options: [{ type: 'effort', values }], effortValues: values }
      }
      return { reasoning: true, options: [{ type: 'toggle' }] }
    case 'moonshotai':
      return /(?:kimi|moonshot)/i.test(id) ? { reasoning: true, options: [{ type: 'toggle' }] } : undefined
    case 'siliconflow':
      return /(deepseek|qwen|qwq|glm|kimi|reasoning|thinking)/i.test(id)
        ? { reasoning: true, options: [{ type: 'toggle' }, { type: 'budget_tokens' }] }
        : undefined
    default:
      return undefined
  }
}

/**
 * Projects endpoint/model reasoning capabilities into the controls shown by
 * the settings page and composer. Unknown and relay endpoints intentionally
 * retain the historical abstract four-level control; official endpoints use
 * only values that their model entry (or the adapter's narrow fallback) says
 * they understand.
 */
export function resolveReasoningEffortOptions(config?: Pick<ProviderConfig, 'baseUrl' | 'model'>): ReasoningEffortResolution {
  if (!config) return { options: LEGACY_REASONING_EFFORT_OPTIONS, official: false }

  const adapter = findEndpointReasoningAdapter(config.baseUrl)
  if (!adapter) return { options: LEGACY_REASONING_EFFORT_OPTIONS, official: false }

  let capabilities: ModelReasoningCapabilities | undefined
  if (adapter.providerId) capabilities = lookupReasoningCapabilities(adapter.providerId, config.model)
  if (!capabilities) capabilities = inferEndpointReasoningCapabilities(adapter, config.model)

  if (!capabilities) {
    return {
      options: [AUTO_REASONING_OPTION],
      official: true,
      hint: '暂未识别当前官方模型的思考能力，仅保留自动。',
    }
  }

  if (!capabilities.reasoning) {
    return {
      options: [AUTO_REASONING_OPTION],
      official: true,
      hint: '当前模型不提供可调节的思考等级。',
    }
  }

  const effortValues = normalizeEffortValues(capabilities.effortValues)
  if (effortValues.length) {
    return {
      options: [AUTO_REASONING_OPTION, ...effortValues.map((value) => ({ value, label: EFFORT_LABELS[value] }))],
      official: true,
      hint: '自动不会发送思考参数；其余选项按当前模型支持的原生值发送。',
    }
  }

  const hasToggle = capabilities.options.some((option) => option.type === 'toggle')
  const hasBudget = capabilities.options.some((option) => option.type === 'budget_tokens')
  if (hasBudget) {
    return {
      options: [AUTO_REASONING_OPTION, ...(['low', 'medium', 'high'] as const).map((value) => ({ value, label: EFFORT_LABELS[value] }))],
      official: true,
      hint: '自动不会发送思考参数；低、中、高会映射为当前模型允许的思考预算。',
    }
  }
  if (hasToggle) {
    return {
      options: [AUTO_REASONING_OPTION, { value: 'low', label: '开启' }],
      official: true,
      hint: '当前模型仅支持开关思考；“开启”会按官方协议发送。',
    }
  }

  return {
    options: [AUTO_REASONING_OPTION],
    official: true,
    hint: '当前模型没有可公开选择的思考等级。',
  }
}

/** Keeps a legacy persisted value usable after a model changes its option set. */
export function normalizeReasoningEffortSelection(value: ReasoningEffort | undefined, options: readonly ReasoningEffortOption[]) {
  const requested = value ?? 'auto'
  if (options.some((option) => option.value === requested)) return requested
  if (requested !== 'auto') return options.find((option) => option.value !== 'auto')?.value ?? 'auto'
  return 'auto'
}
