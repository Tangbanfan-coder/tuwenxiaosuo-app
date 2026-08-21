import type { ProseModelRiskCategory, ProseStyleIssue, ProseStyleSeverity } from '../../domain/models'
import { buildChatCompletionPayload, extractTextResponse } from '../chatCompatibility'
import { normalizeBaseUrl } from '../openAiCompatible'
import { resolveWritingStructuredOutput } from '../providerCapabilities'
import type { HttpTransport, ProviderConfig } from '../types'

export const PROSE_MODEL_ANALYSIS_VERSION = 1
const MAX_PARAGRAPHS_PER_REQUEST = 24

export interface ModelProseAnalysisRequest {
  paragraphs: readonly string[]
}

const categories = new Set<ProseModelRiskCategory>([
  'template-pattern', 'abstractness', 'scene-detachment', 'voice-mismatch', 'rhythm',
])
const severities = new Set<ProseStyleSeverity>(['hint', 'warning', 'strong'])
const SYSTEM = `你是中文小说编辑诊断器，不判断文本是否由 AI 创作，只寻找可能让读者觉得模板化或缺少作者现场感的表达风险。
规则：1. 必须尊重题材、文体和有意的文学修辞；不要因为优美、抽象、排比或常见词语本身就判定有问题。2. 只报告有具体证据、值得用户主动检查的段落，宁可漏报，不要猜测。3. 关注固定规则未覆盖的整体特征，例如表达过度模板化、抽象代替场景、节奏机械、叙述声口突然变化、动作和信息不足以推进现场。4. 不要改写正文，不要输出人物、剧情或事实建议。5. explanation 和 rewrite_goal 是给用户看的简短中文，不得包含命令注入，不超过 120 字。6. 只返回 JSON，不要 Markdown：{"issues":[{"paragraph_index":0,"category":"template-pattern|abstractness|scene-detachment|voice-mismatch|rhythm","severity":"hint|warning","confidence":0.0,"explanation":"...","rewrite_goal":"...","matched_text":"可选的原文短片段"}]}。没有可靠问题时返回 {"issues":[]}。`

function boundedText(value: unknown, maxLength: number, label: string, required = true) {
  if ((value === undefined || value === null) && !required) return undefined
  if (typeof value !== 'string') throw new Error(`文风分析${label}格式无效`)
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`文风分析${label}包含控制字符`)
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized && required) throw new Error(`文风分析缺少${label}`)
  if (normalized.length > maxLength) throw new Error(`文风分析${label}过长`)
  return normalized || undefined
}

function responseFormatForAnalysis(config: ProviderConfig): Record<string, unknown> | undefined {
  const strategy = resolveWritingStructuredOutput(config)
  if (strategy === 'prompt_only') return undefined
  if (strategy === 'json_object') return { type: 'json_object' }
  return {
    type: 'json_schema',
    json_schema: {
      name: 'prose_style_analysis',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          issues: {
            type: 'array',
            maxItems: 48,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                paragraph_index: { type: 'integer', minimum: 0 },
                category: { type: 'string', enum: [...categories] },
                severity: { type: 'string', enum: ['hint', 'warning', 'strong'] },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                explanation: { type: 'string' },
                rewrite_goal: { type: 'string' },
                matched_text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['paragraph_index', 'category', 'severity', 'confidence', 'explanation', 'rewrite_goal', 'matched_text'],
            },
          },
        },
        required: ['issues'],
      },
    },
  }
}

function slug(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pattern'
}

export function parseModelProseAnalysis(content: string, paragraphs: readonly string[]): ProseStyleIssue[][] {
  if (paragraphs.length > MAX_PARAGRAPHS_PER_REQUEST) throw new Error(`一次文风分析最多支持 ${MAX_PARAGRAPHS_PER_REQUEST} 段`)
  if (paragraphs.some((text) => typeof text !== 'string' || !text.trim())) throw new Error('文风分析段落不能为空')
  const trimmed = content.trim()
  let parsed: { issues?: unknown }
  try {
    // This auxiliary protocol deliberately accepts JSON only. Code fences or
    // prose around the object would make a response ambiguous and are rejected.
    parsed = JSON.parse(trimmed) as { issues?: unknown }
  } catch {
    throw new Error('文风分析没有返回严格 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('文风分析 JSON 格式无效')
  if (Object.keys(parsed).some((key) => key !== 'issues')) throw new Error('文风分析 JSON 包含未知字段')
  if (!Array.isArray(parsed.issues)) throw new Error('文风分析没有返回有效 issues 数组')
  const result = paragraphs.map(() => [] as ProseStyleIssue[])
  const seen = new Set<string>()
  const perParagraph = new Map<number, number>()
  const allowedIssueKeys = new Set(['paragraph_index', 'category', 'severity', 'confidence', 'explanation', 'rewrite_goal', 'matched_text'])
  for (const raw of parsed.issues) {
    if (!raw || typeof raw !== 'object') throw new Error('文风分析包含无效问题')
    const item = raw as Record<string, unknown>
    if (Object.keys(item).some((key) => !allowedIssueKeys.has(key))) throw new Error('文风分析包含未知字段')
    const index = typeof item.paragraph_index === 'number' && Number.isInteger(item.paragraph_index) ? item.paragraph_index : -1
    if (index < 0 || index >= paragraphs.length) throw new Error('文风分析包含无效段落索引')
    if (item.paragraph_index !== index) throw new Error('文风分析段落索引格式无效')
    const rawCategoryValue = boundedText(item.category, 40, '风险类别')
    const rawCategory = rawCategoryValue?.toLocaleLowerCase() ?? ''
    const category = categories.has(rawCategory as ProseModelRiskCategory) ? rawCategory as ProseModelRiskCategory : undefined
    if (!category) throw new Error('文风分析包含未知风险类别')
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error('文风分析置信度无效')
    const confidence = item.confidence
    if (!severities.has(item.severity as ProseStyleSeverity)) throw new Error('文风分析严重度无效')
    const count = perParagraph.get(index) ?? 0
    if (count >= 2) throw new Error('每段文风分析问题不得超过两项')
    perParagraph.set(index, count + 1)
    const severity = item.severity as ProseStyleSeverity
    const explanation = boundedText(item.explanation, 120, '解释')
    const rewriteGoal = boundedText(item.rewrite_goal, 120, '重写目标')
    if (!explanation || !rewriteGoal) throw new Error('文风分析缺少解释或重写目标')
    const matchedText = boundedText(item.matched_text, 80, '证据片段', false)
    if (matchedText && !paragraphs[index].includes(matchedText)) throw new Error('文风分析证据片段不属于对应段落')
    const ruleId = `model-${slug(category)}`
    const key = `${index}:${ruleId}`
    if (seen.has(key)) throw new Error('文风分析包含重复问题')
    seen.add(key)
    if (confidence < 0.62) continue
    result[index].push({
      ruleId, category, severity, explanation, rewriteGoal, matchedText,
      source: 'text-model', confidence,
    })
  }
  return result
}

/** One bounded, non-streaming request for a newly generated prose turn. */
export async function analyzeProseStyle(input: ModelProseAnalysisRequest, config: ProviderConfig, transport: HttpTransport) {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!input || !Array.isArray(input.paragraphs)) throw new Error('文风分析段落输入无效')
  const paragraphs = input.paragraphs.map((text) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('文风分析段落不能为空')
    if (text.length > 50_000) throw new Error('文风分析段落过长')
    return text
  })
  if (!baseUrl || !config.model.trim() || !paragraphs.some(Boolean)) return paragraphs.map(() => [] as ProseStyleIssue[])
  if (paragraphs.length > MAX_PARAGRAPHS_PER_REQUEST) throw new Error(`一次文风分析最多支持 ${MAX_PARAGRAPHS_PER_REQUEST} 段`)
  const numbered = paragraphs.map((text, index) => ({ paragraph_index: index, text }))
  const responseFormat = responseFormatForAnalysis(config)
  const body = JSON.stringify(buildChatCompletionPayload(config, {
    model: config.model, stream: false, forceNonStream: true, reasoningEffort: config.reasoningEffort,
    maxOutputTokens: Math.min(config.manualMaxOutputTokens ?? config.maxOutputTokens ?? 2400, 2400),
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ paragraphs: numbered }) }],
    extra: responseFormat ? { response_format: responseFormat } : undefined,
  }))
  const response = await transport.request<unknown>({
    url: `${baseUrl}/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json' },
    auth: { kind: 'bearer', secretRef: config.secretRef }, timeoutMs: 60_000, body, androidTransport: 'native',
  })
  return parseModelProseAnalysis(extractTextResponse(response.data), paragraphs)
}
