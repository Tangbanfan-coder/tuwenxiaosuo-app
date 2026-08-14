import type { NarrativePronoun } from '../domain/models'
import { normalizeBaseUrl } from './openAiCompatible'
import { resolveCapabilities } from './providerCapabilities'
import { buildChatCompletionPayload, extractTextResponse } from './chatCompatibility'
import type { HttpTransport, ProviderConfig } from './types'

export interface ReferenceAppearanceAnalysis {
  narrativePronoun: NarrativePronoun
  ageAndBuild: string
  fixedTraits: string[]
  defaultLook: string
  wardrobe: string
}

const ANALYSIS_PROMPT = `分析这张角色参考图，仅输出严格 JSON：
{"narrative_pronoun":"she|he|ta|name","age_and_build":"","fixed_traits":[""],"default_look":"","wardrobe":""}
只描述清晰可见的外貌、发型、服装和非敏感视觉特征。不得猜测姓名、族裔、健康状况、职业、身份、性别认同或图片中不可见的事实。narrative_pronoun 只能在画面明确时建议 she/he；不明确时用 ta。所有值用中文。`

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function pronoun(value: unknown): NarrativePronoun {
  return value === 'she' || value === 'he' || value === 'ta' || value === 'name' ? value : 'ta'
}

export function parseReferenceAppearanceAnalysis(content: string): ReferenceAppearanceAnalysis {
  let value: unknown
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('外貌识别没有返回有效 JSON')
  try { value = JSON.parse(trimmed.slice(start, end + 1)) } catch { throw new Error('外貌识别没有返回有效 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('外貌识别返回格式无效')
  const record = value as Record<string, unknown>
  const analysis = {
    narrativePronoun: pronoun(record.narrative_pronoun),
    ageAndBuild: text(record.age_and_build),
    fixedTraits: Array.isArray(record.fixed_traits) ? record.fixed_traits.map(text).filter(Boolean).slice(0, 12) : [],
    defaultLook: text(record.default_look),
    wardrobe: text(record.wardrobe),
  }
  if (!analysis.ageAndBuild && !analysis.fixedTraits.length && !analysis.defaultLook && !analysis.wardrobe) {
    throw new Error('外貌识别没有返回可确认的角色特征')
  }
  return analysis
}

async function referenceSourceToDataUrl(source: string) {
  if (source.startsWith('data:image/')) return source
  try {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取参考图'))
      reader.onerror = () => reject(new Error('无法读取参考图'))
      reader.readAsDataURL(blob)
    })
  } catch {
    throw new Error('无法读取参考图，请重新导入原图后重试')
  }
}

export async function analyzeReferenceImage(
  source: string,
  config: ProviderConfig,
  transport: HttpTransport,
): Promise<ReferenceAppearanceAnalysis> {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl || !config.model.trim()) throw new Error('请先配置可识图的文本模型')
  // Vision capability gate: reject before any network request, not after billing.
  if (resolveCapabilities(config).visionInput === 'unsupported') {
    throw new Error('当前文本模型不支持视觉输入（识图）。请在文本模型设置的“兼容能力”中启用视觉输入，或改用支持识图的模型。')
  }
  const dataUrl = await referenceSourceToDataUrl(source)
  const response = await transport.request<unknown>({
    url: `${baseUrl}/chat/completions`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    auth: { kind: 'bearer', secretRef: config.secretRef },
    timeoutMs: 120_000,
    body: JSON.stringify(buildChatCompletionPayload(config, {
      model: config.model,
      // Auxiliary task: hard non-streaming, never overridden by a stream preset.
      stream: false,
      forceNonStream: true,
      reasoningEffort: config.reasoningEffort,
      messages: [{ role: 'user', content: [
        { type: 'text', text: ANALYSIS_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] }],
    })),
  })
  const content = extractTextResponse(response.data)
  if (!content.trim()) throw new Error('文本模型没有返回外貌识别结果')
  return parseReferenceAppearanceAnalysis(content)
}
