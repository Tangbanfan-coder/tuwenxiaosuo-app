import type { FeedbackVerdict, PreferenceDimension } from '../../domain/models'
import { buildChatCompletionPayload, extractTextResponse } from '../chatCompatibility'
import { normalizeBaseUrl } from '../openAiCompatible'
import type { HttpTransport, ProviderConfig } from '../types'

export interface FeedbackPreferenceInput {
  verdict: FeedbackVerdict
  reason?: string
  targetTexts: readonly string[]
}

export interface AnalyzedPreference {
  dimension: PreferenceDimension
  instruction: string
}

const dimensions = new Set<PreferenceDimension>(['plot', 'character', 'dialogue', 'pace', 'description', 'rhetoric', 'emotion', 'ending'])
const genericPreferenceTerms = new Set([
  '人物', '剧情', '情节', '正文', '写作', '叙述', '对白', '对话', '节奏', '描写', '语言', '表达', '句式', '语气', '修辞', '情绪', '结尾', '场景', '动作', '细节',
  '冲突', '关系', '信息', '铺垫', '转折', '视角', '直接', '简短', '自然', '具体', '克制', '清晰', '连贯', '推进', '留白',
])

const SYSTEM = `你只分析中文小说读者反馈，输出 JSON：{"preferences":[{"dimension":"dialogue","instruction":"后续对白更直接简短"}]}。只输出 1-3 条可复用的未来写作偏好。instruction 必须以“后续、保持、避免、少用、多用、让”开头；不得出现人物名、专名、事件、地点、时间、原句、引用、具体剧情事实。只选择能够可靠抽象的表达维度。`

function containsSourceSpecificTerm(source: string, instruction: string) {
  const sourceTerms = new Set<string>()
  for (const block of source.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let length = 2; length <= Math.min(4, block.length); length++) {
      for (let index = 0; index + length <= block.length; index++) {
        const term = block.slice(index, index + length)
        if (!genericPreferenceTerms.has(term)) sourceTerms.add(term)
      }
    }
  }
  return Array.from(sourceTerms).some((term) => instruction.includes(term))
}

function parse(content: string, source: string): AnalyzedPreference[] {
  let raw: unknown
  try { raw = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) } catch { throw new Error('偏好分析没有返回有效 JSON') }
  const entries: unknown[] | undefined = raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).preferences) ? (raw as Record<string, unknown>).preferences as unknown[] : undefined
  if (!entries || entries.length < 1 || entries.length > 3) throw new Error('偏好分析未形成可靠的抽象偏好')
  const normalized = entries.map((item) => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const dimension = typeof value.dimension === 'string' ? value.dimension as PreferenceDimension : undefined
    const instruction = typeof value.instruction === 'string' ? value.instruction.trim().replace(/\s+/g, ' ') : ''
    if (!dimension || !dimensions.has(dimension) || !/^(后续|保持|避免|少用|多用|让)/.test(instruction) || instruction.length > 120) throw new Error('偏好分析包含无效指令')
    return { dimension, instruction }
  })
  if (normalized.some((item) => containsSourceSpecificTerm(source, item.instruction) || /[“”「」『』]/.test(item.instruction) || /(?:第[一二三四五六七八九十0-9]+[章节]|昨天|今天|昨夜|此刻)/.test(item.instruction))) throw new Error('偏好分析包含原文或剧情事实')
  return Array.from(new Map(normalized.map((item) => [`${item.dimension}:${item.instruction}`, item])).values())
}

/** Exactly one non-streaming provider request; callers own cost confirmation. */
export async function analyzeFeedbackPreference(input: FeedbackPreferenceInput, config: ProviderConfig, transport: HttpTransport): Promise<AnalyzedPreference[]> {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl || !config.model.trim()) throw new Error('请先完成文本模型配置')
  const target = input.targetTexts.map((text) => text.trim()).filter(Boolean).join('\n\n')
  if (!target) throw new Error('没有可分析的反馈正文')
  const body = JSON.stringify(buildChatCompletionPayload(config, {
    model: config.model, stream: false, forceNonStream: true, reasoningEffort: config.reasoningEffort,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `反馈：${input.verdict === 'up' ? '喜欢' : '不喜欢'}\n原因：${input.reason?.trim() || '未填写'}\n待分析正文：\n${target}` }],
  }))
  const response = await transport.request<unknown>({ url: `${baseUrl}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, auth: { kind: 'bearer', secretRef: config.secretRef }, timeoutMs: 30_000, body, androidTransport: 'native' })
  return parse(extractTextResponse(response.data), target)
}
