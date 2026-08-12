import type { NarrativePronoun } from '../domain/models'
import { normalizeBaseUrl } from './openAiCompatible'
import type { HttpTransport, ProviderConfig } from './types'

export interface ReferenceAppearanceAnalysis {
  narrativePronoun: NarrativePronoun
  ageAndBuild: string
  fixedTraits: string[]
  defaultLook: string
  wardrobe: string
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>
}

const ANALYSIS_PROMPT = `分析这张角色参考图，仅输出严格 JSON：
{"narrative_pronoun":"she|he|ta|name","age_and_build":"","fixed_traits":[""],"default_look":"","wardrobe":""}
只描述清晰可见的外貌、发型、服装和非敏感视觉特征。不得猜测姓名、族裔、健康状况、职业、身份、性别认同或图片中不可见的事实。narrative_pronoun 只能在画面明确时建议 she/he；不明确时用 ta。所有值用中文。`

function contentToString(content: unknown) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => typeof part === 'object' && part && 'text' in part && typeof part.text === 'string' ? part.text : '').join('')
  return ''
}

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
  const dataUrl = await referenceSourceToDataUrl(source)
  const response = await transport.request<ChatResponse>({
    url: `${baseUrl}/chat/completions`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    auth: { kind: 'bearer', secretRef: config.secretRef },
    timeoutMs: 120_000,
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: ANALYSIS_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] }],
    }),
  })
  const content = contentToString(response.data.choices?.[0]?.message?.content)
  if (!content) throw new Error('文本模型没有返回外貌识别结果')
  return parseReferenceAppearanceAnalysis(content)
}
