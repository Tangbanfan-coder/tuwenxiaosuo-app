import type { ProjectWorkspace, WritingInstructionsStructure, WritingStyleSample } from '../../domain/models'
import { hashText, type StoredScene } from '../../data/storyDatabase'
import { resolveTokenEstimator, type ResolvedTokenEstimator } from '../tokenEstimator'
import type { HttpTransport, ProviderConfig } from '../types'
import { normalizeBaseUrl } from '../openAiCompatible'
import { CONTEXT_NARROWING_FACTOR, contextSafetyMarginTokens, effectiveWindowTokens, estimatedTokenCount, maxOutputForRequest, outputTokenParameter } from './budget'
import { extractJson, stringValue } from './result'

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown
    }
  }>
}

export function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase()
}

export type ContextTextMeasure = (text: string) => number

export function truncateTextToBudget(value: string, maxUnits: number, keepOrder: 'tail' | 'head', measure: ContextTextMeasure) {
  if (!value || maxUnits <= 0) return ''
  if (measure(value) <= maxUnits) return value
  let lowerBound = 0
  let upperBound = value.length
  while (lowerBound < upperBound) {
    const candidateLength = Math.ceil((lowerBound + upperBound) / 2)
    const candidate = keepOrder === 'head'
      ? value.slice(0, candidateLength)
      : value.slice(value.length - candidateLength)
    if (measure(candidate) <= maxUnits) lowerBound = candidateLength
    else upperBound = candidateLength - 1
  }
  let truncated = keepOrder === 'head'
    ? value.slice(0, lowerBound)
    : value.slice(value.length - lowerBound)
  // Token merges are almost monotonic but not formally so at every boundary.
  while (truncated && measure(truncated) > maxUnits) {
    truncated = keepOrder === 'head' ? truncated.slice(0, -1) : truncated.slice(1)
  }
  return truncated
}

export function parseWritingStructureJson(value: string | undefined): (WritingInstructionsStructure & { sourceHash?: string }) | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as WritingInstructionsStructure & { sourceHash?: unknown }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.core !== 'string') return undefined
    return {
      core: parsed.core,
      sections: Array.isArray(parsed.sections)
        ? parsed.sections
          .filter((section): section is WritingInstructionsStructure['sections'][number] =>
            Boolean(section && typeof section === 'object' && typeof section.content === 'string' && section.content.trim()))
          .map((section) => ({
            id: typeof section.id === 'string' && section.id ? section.id : createShortId(),
            title: typeof section.title === 'string' && section.title.trim() ? section.title : '未分类',
            content: section.content,
            tags: Array.isArray(section.tags) ? section.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            priority: typeof section.priority === 'number' && Number.isFinite(section.priority)
              ? Math.min(5, Math.max(1, Math.floor(section.priority)))
              : 1,
          }))
        : [],
      styleSamples: Array.isArray(parsed.styleSamples)
        ? parsed.styleSamples
          .filter((sample): sample is WritingInstructionsStructure['styleSamples'][number] =>
            Boolean(sample && typeof sample === 'object' && typeof sample.content === 'string' && sample.content.trim()))
          .map((sample) => ({
            sceneType: typeof sample.sceneType === 'string' && sample.sceneType.trim() ? sample.sceneType : '日常',
            content: sample.content,
          }))
        : [],
      ...(typeof parsed.sourceHash === 'string' ? { sourceHash: parsed.sourceHash } : {}),
    }
  } catch {
    return undefined
  }
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

export function parseChapterOrder(value: string) {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value)
    return parsed > 0 ? parsed : undefined
  }
  if ([...value].every((character) => character in CHINESE_DIGITS)) {
    const parsed = Number([...value].map((character) => CHINESE_DIGITS[character]).join(''))
    return parsed > 0 ? parsed : undefined
  }
  let total = 0
  let current = 0
  for (const character of value) {
    if (character in CHINESE_DIGITS) {
      current = CHINESE_DIGITS[character]
      continue
    }
    if (character === '十') {
      total += (current || 1) * 10
      current = 0
      continue
    }
    if (character === '百') {
      total += (current || 1) * 100
      current = 0
      continue
    }
    return undefined
  }
  const parsed = total + current
  return parsed > 0 ? parsed : undefined
}

export function parseWritingStructure(project: ProjectWorkspace['project']): WritingInstructionsStructure | undefined {
  const parsed = parseWritingStructureJson(project.writingStructure)
  if (!parsed) return undefined
  if (parsed.sourceHash && parsed.sourceHash !== hashText(project.writingInstructions ?? '')) return undefined
  return {
    core: parsed.core,
    sections: parsed.sections,
    styleSamples: parsed.styleSamples,
  }
}

export function selectInstructionSections(structure: WritingInstructionsStructure | undefined, latestScene: StoredScene | undefined, userRequest: string, limit: number) {
  if (!structure || !structure.sections.length) return []
  const sceneEntities = new Set(
    latestScene
      ? [latestScene.notes.location, latestScene.notes.povCharacter, ...latestScene.notes.charactersPresent]
        .filter((value): value is string => Boolean(value)).map(normalizeText)
      : [],
  )
  const requestText = normalizeText(userRequest)
  const scored = structure.sections
    .map((section) => {
      const text = normalizeText([section.title, section.content, ...section.tags].join(' '))
      const entityHits = Array.from(sceneEntities).filter((entity) => entity.length >= 2 && text.includes(entity)).length
      const requestHits = Array.from(requestText ? Array.from(new Set<string>(requestText.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [])) : []).filter((gram) => text.includes(gram)).length
      return { section, score: entityHits * 3 + requestHits * 2 + section.priority }
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
  return scored.map((item) => item.section)
}

export function selectStyleSamples(structure: WritingInstructionsStructure | undefined, userRequest: string, limit: number) {
  if (!structure || !structure.styleSamples.length) return []
  const requestText = normalizeText(userRequest)
  const scored = structure.styleSamples
    .map((sample) => {
      const text = normalizeText(sample.sceneType)
      const hits = Array.from(new Set<string>(requestText.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [])).filter((gram) => text.includes(gram)).length
      return { sample, score: hits }
    })
    .sort((left, right) => right.score - left.score)
  const ranked = scored.length ? scored : structure.styleSamples.map((sample) => ({ sample, score: 0 }))
  return ranked.slice(0, limit).map((item) => item.sample)
}


export function contentToString(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text
    return ''
  }).join('')
}

const STRUCTURE_CHUNK_PROMPT = `你是小说创作设定整理助手。用户会提供一篇长设定的一部分片段，请只从这个片段中提取结构化信息，只返回一个 JSON 对象，不要使用 Markdown 代码块，也不要在 JSON 外添加文字：
{
  "core_fragments": ["本片段中属于核心规则的条目，如：必须/禁止/绝对/不要 类要求，每条一句话"],
  "sections": [
    {
      "title": "分类标题，如：世界历史/魔法体系/国家与组织/人物档案/地点设定/物品设定/社会制度/剧情规划",
      "content": "本片段中该分类下的设定内容，保留细节",
      "tags": ["检索关键词，3-6 个"],
      "priority": 1
    }
  ],
  "style_samples": [
    {
      "scene_type": "打斗/感情/悬疑/日常/景物/对话 等场景类型",
      "content": "本片段中能体现文风的原句片段"
    }
  ]
}
要求：只提取片段中真实存在的内容，不要编造；sections 的 content 不得省略片段中的具体设定；没有对应内容时返回空数组。`

const STRUCTURE_CHUNK_SIZE = 8_000
export const WRITING_STRUCTURE_CORE_LIMIT = 2_000
const STRUCTURE_CHUNK_RETRIES = 2
const STRUCTURE_REQUEST_OVERHEAD_TOKENS = 512
const STRUCTURE_TOKEN_PROBE_CHARS = 1_024
const STRUCTURE_TOKEN_CORRECTION_ATTEMPTS = 2

interface StructureChunkResult {
  coreFragments: string[]
  sections: Array<{ title: string; content: string; tags: string[]; priority: number }>
  styleSamples: Array<{ sceneType: string; content: string }>
}

function tokenBudgetedChunkEnd(source: string, start: number, maximumEnd: number, maxTokens: number, estimator: ResolvedTokenEstimator) {
  const maximumLength = maximumEnd - start
  if (maximumLength <= 0) return start

  const probeLength = Math.min(STRUCTURE_TOKEN_PROBE_CHARS, maximumLength)
  const probeTokens = estimatedTokenCount(estimator, source.slice(start, start + probeLength))
  let candidateLength = probeTokens > 0
    ? Math.floor((probeLength * maxTokens) / probeTokens)
    : maximumLength
  candidateLength = Math.max(1, Math.min(maximumLength, candidateLength))

  let end = start + candidateLength
  let candidateTokens = estimatedTokenCount(estimator, source.slice(start, end))
  for (let attempt = 0; candidateTokens > maxTokens && attempt < STRUCTURE_TOKEN_CORRECTION_ATTEMPTS; attempt++) {
    candidateLength = Math.max(1, Math.floor((candidateLength * maxTokens) / candidateTokens))
    end = start + candidateLength
    candidateTokens = estimatedTokenCount(estimator, source.slice(start, end))
  }
  if (candidateTokens <= maxTokens) return end

  // Highly uneven text can defeat the local proportional estimate. Keep the
  // expensive binary search as a rare exact fallback, never as the normal path.
  let lowerBound = 0
  let upperBound = candidateLength - 1
  while (lowerBound < upperBound) {
    const candidate = Math.ceil((lowerBound + upperBound) / 2)
    if (estimatedTokenCount(estimator, source.slice(start, start + candidate)) <= maxTokens) lowerBound = candidate
    else upperBound = candidate - 1
  }
  return start + lowerBound
}

function preferredStructureChunkEnd(source: string, start: number, end: number, maxTokens: number, estimator: ResolvedTokenEstimator) {
  if (end >= source.length) return end
  const minimumBoundary = start + Math.floor((end - start) * 0.6)
  let boundary = -1
  let boundaryLength = 0
  for (const separator of ['\n\n', '\n', '。', '！', '？']) {
    const candidate = source.lastIndexOf(separator, end - 1)
    if (candidate >= minimumBoundary && candidate > boundary) {
      boundary = candidate
      boundaryLength = separator.length
    }
  }
  if (boundary < minimumBoundary) return end
  const preferredEnd = boundary + boundaryLength
  return estimatedTokenCount(estimator, source.slice(start, preferredEnd)) <= maxTokens ? preferredEnd : end
}

function finalizedStructureChunk(source: string, start: number, end: number, maxTokens: number, estimator: ResolvedTokenEstimator) {
  const chunk = source.slice(start, end).trim()
  if (estimatedTokenCount(estimator, chunk) <= maxTokens) return { end, chunk }

  // Trimming may theoretically alter a boundary merge. Correct only that
  // exceptional case so every emitted chunk remains within the real budget.
  let lowerBound = 0
  let upperBound = end - start - 1
  while (lowerBound < upperBound) {
    const candidateLength = Math.ceil((lowerBound + upperBound) / 2)
    const candidate = source.slice(start, start + candidateLength).trim()
    if (estimatedTokenCount(estimator, candidate) <= maxTokens) lowerBound = candidateLength
    else upperBound = candidateLength - 1
  }
  const safeEnd = start + lowerBound
  return { end: safeEnd, chunk: source.slice(start, safeEnd).trim() }
}

function splitStructureSource(source: string, maxTokens: number, estimator: ResolvedTokenEstimator) {
  const chunks: string[] = []
  let start = 0
  while (start < source.length) {
    const maximumEnd = Math.min(source.length, start + STRUCTURE_CHUNK_SIZE)
    let end = tokenBudgetedChunkEnd(source, start, maximumEnd, maxTokens, estimator)
    if (end <= start) {
      // A single code unit can exceed an exotic custom tokenizer's budget; retain it to guarantee progress.
      end = Math.min(source.length, start + 1)
    }
    end = preferredStructureChunkEnd(source, start, end, maxTokens, estimator)
    const finalized = finalizedStructureChunk(source, start, end, maxTokens, estimator)
    end = finalized.end
    const chunk = finalized.chunk
    if (chunk) chunks.push(chunk)
    if (end <= start) break
    start = end
  }
  return chunks
}

function parseStructureChunk(content: string): StructureChunkResult {
  const parsed = extractJson(content) as unknown as { core_fragments?: unknown; sections?: unknown; style_samples?: unknown }
  const result: StructureChunkResult = {
    coreFragments: Array.isArray(parsed.core_fragments)
      ? parsed.core_fragments.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : [],
    sections: Array.isArray(parsed.sections)
      ? parsed.sections
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((item) => ({
          title: stringValue(item.title) || '未分类',
          content: stringValue(item.content),
          tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
          priority: typeof item.priority === 'number' ? Math.min(5, Math.max(1, Math.floor(item.priority))) : 1,
        }))
        .filter((section) => Boolean(section.content))
      : [],
    styleSamples: Array.isArray(parsed.style_samples)
      ? parsed.style_samples
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((item) => ({ sceneType: stringValue(item.scene_type) || '日常', content: stringValue(item.content) }))
        .filter((sample) => Boolean(sample.content))
      : [],
  }
  if (!result.coreFragments.length && !result.sections.length && !result.styleSamples.length) {
    throw new Error('模型返回了空的结构化结果')
  }
  return result
}

function mergeStructureChunks(chunks: StructureChunkResult[]): WritingInstructionsStructure {
  const coreLines: string[] = []
  const seenCore = new Set<string>()
  const sectionsByTitle = new Map<string, { title: string; content: string; tags: string[]; priority: number }>()
  const styleSamples: WritingStyleSample[] = []
  const seenSamples = new Set<string>()

  for (const chunk of chunks) {
    for (const fragment of chunk.coreFragments) {
      const key = normalizeText(fragment)
      if (!fragment.trim() || seenCore.has(key)) continue
      seenCore.add(key)
      coreLines.push(fragment.trim())
    }
    for (const section of chunk.sections) {
      if (!section.content?.trim()) continue
      const existing = sectionsByTitle.get(section.title)
      if (existing) {
        existing.content = `${existing.content}\n${section.content.trim()}`
        existing.priority = Math.max(existing.priority, section.priority ?? 1)
        for (const tag of section.tags ?? []) {
          if (typeof tag === 'string' && !existing.tags.includes(tag)) existing.tags.push(tag)
        }
      } else {
        sectionsByTitle.set(section.title, {
          title: section.title || '未分类',
          content: section.content.trim(),
          tags: Array.isArray(section.tags) ? section.tags.filter((tag): tag is string => typeof tag === 'string') : [],
          priority: typeof section.priority === 'number' ? Math.min(5, Math.max(1, Math.floor(section.priority))) : 1,
        })
      }
    }
    for (const sample of chunk.styleSamples) {
      if (!sample.content?.trim()) continue
      const key = normalizeText(sample.content)
      if (seenSamples.has(key)) continue
      seenSamples.add(key)
      styleSamples.push({ sceneType: sample.sceneType || '日常', content: sample.content.trim() })
    }
  }

  return {
    core: coreLines.join('\n'),
    sections: Array.from(sectionsByTitle.values()).map((section) => ({
      id: createShortId(),
      title: section.title,
      content: section.content,
      tags: section.tags.slice(0, 8),
      priority: section.priority,
    })),
    styleSamples: styleSamples.slice(0, 4),
  }
}

function planWritingInstructionStructure(source: string, config: ProviderConfig) {
  const windowTokens = effectiveWindowTokens(config)
  const maxOutput = Math.min(maxOutputForRequest(config, windowTokens), 4_096)
  const safetyMarginTokens = contextSafetyMarginTokens(windowTokens)
  const estimator = resolveTokenEstimator({ protocol: config.protocol, providerId: config.id, model: config.model })
  const promptTokens = STRUCTURE_REQUEST_OVERHEAD_TOKENS + estimatedTokenCount(estimator, STRUCTURE_CHUNK_PROMPT)
  const availableChunkTokens = windowTokens - maxOutput - safetyMarginTokens - promptTokens
  if (availableChunkTokens < 512) {
    throw new Error('当前模型窗口不足以整理长期创作设定，请降低最大输出或改用更大窗口的模型。')
  }
  const chunkTokenBudget = Math.max(1, Math.floor(availableChunkTokens * CONTEXT_NARROWING_FACTOR))
  const chunks = splitStructureSource(source, chunkTokenBudget, estimator)
  if (!chunks.length) throw new Error('长期创作设定为空，无法整理')
  return { chunks, maxOutput }
}

export function estimateWritingInstructionStructureCalls(source: string, config: ProviderConfig) {
  return planWritingInstructionStructure(source, config).chunks.length
}

export async function structureWritingInstructions(
  source: string,
  config: ProviderConfig,
  transport: HttpTransport,
): Promise<WritingInstructionsStructure> {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl) throw new Error('请先配置文本模型的 API URL')
  if (!config.model.trim()) throw new Error('请先选择文本模型')

  const { chunks, maxOutput } = planWritingInstructionStructure(source, config)

  const results: StructureChunkResult[] = []
  for (let index = 0; index < chunks.length; index++) {
    let result: StructureChunkResult | undefined
    let lastError: unknown
    for (let attempt = 0; attempt < STRUCTURE_CHUNK_RETRIES; attempt++) {
      try {
        const request = {
          url: `${baseUrl}/chat/completions`,
          method: 'POST' as const,
          headers: { 'Content-Type': 'application/json' },
          auth: { kind: 'bearer' as const, secretRef: config.secretRef },
          timeoutMs: 120_000,
          body: JSON.stringify({
            model: config.model,
            stream: false,
            ...outputTokenParameter(config, maxOutput),
            messages: [
              { role: 'system', content: STRUCTURE_CHUNK_PROMPT },
              { role: 'user', content: chunks[index] },
            ],
          }),
        }
        const response = await transport.request<ChatCompletionResponse>(request)
        const content = contentToString(response.data.choices?.[0]?.message?.content)
        if (!content.trim()) throw new Error('模型没有返回内容')
        result = parseStructureChunk(content)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!result) {
      const reason = lastError instanceof Error ? lastError.message : '未知错误'
      throw new Error(`第 ${index + 1}/${chunks.length} 段设定整理失败：${reason}`)
    }
    results.push(result)
  }

  return mergeStructureChunks(results)
}

function createShortId() {
  return Math.random().toString(36).slice(2, 10)
}
