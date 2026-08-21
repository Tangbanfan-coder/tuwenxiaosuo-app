import type { ModelReasoningCapabilities } from './modelLimits'
import type { ReasoningEffort } from './types'

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

const DEFAULT_BUDGETS: Record<Exclude<ReasoningEffort, 'auto'>, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
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
 * Clamps a user-facing low/medium/high value upward to the nearest legal model
 * value. Unknown values advertised by a remote table are ignored, avoiding the
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
