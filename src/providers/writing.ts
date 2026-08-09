import type { ContextBudget, Feedback, ProjectWorkspace, StoredParagraph, VisualPlan, WritingCharacterPlan, WritingInstructionsStructure, WritingSceneNotes, WritingStyleSample, WritingTurnResult } from '../domain/models'
import { collectOpenForeshadowings } from '../domain/foreshadowing'
import { resolveProjectIllustrationStyle } from '../domain/illustrationStyles'
import {
  hashText,
  listProjectParagraphs,
  listRecentProjectFeedback,
  listRetrievableProjectParagraphs,
  loadProjectScenes,
  type StoredScene,
} from '../data/storyDatabase'
import { heuristicModelContextTokens, lookupModelLimit } from './modelLimits'
import {
  resolveTokenEstimator,
  tokenEstimatorMetadata,
  type ResolvedTokenEstimator,
} from './tokenEstimator'
import type { HttpTransport, ProviderConfig } from './types'
import { normalizeBaseUrl } from './openAiCompatible'
import { BigramBm25Retriever, type RetrievedParagraph, type Retriever } from './retriever'

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown
    }
  }>
}

interface RawWritingResult {
  assistant_note?: unknown
  chapter_action?: unknown
  prose?: {
    chapter_title?: unknown
    paragraphs?: unknown
  }
  chapter_summary?: unknown
  scene_notes?: {
    time?: unknown
    location?: unknown
    pov_character?: unknown
    characters_present?: unknown
    events?: unknown
    state_changes?: unknown
    relationship_changes?: unknown
    knowledge_changes?: unknown
    new_foreshadowing_texts?: unknown
    resolved_foreshadowing_ids?: unknown
    /** Compatibility with model responses produced before stable ids existed. */
    clues_planted?: unknown
    clues_resolved?: unknown
    unresolved_threads?: unknown
  } | null
  visual_plan?: {
    title?: unknown
    prompt?: unknown
    style_prompt?: unknown
    negative_prompt?: unknown
    characters?: unknown
  } | null
}

const SYSTEM_PROMPT = `你是一名中文小说协作作者，同时负责给插画模型准备视觉计划。
处理创作要求时遵循以下优先级：输出格式与安全边界 > 本轮用户明确提出的要求 > 当前作品的长期创作设定 > 你自己的写作习惯。用户本轮指定的题材、视角、语气、节奏、篇幅和剧情方向，可以临时覆盖长期创作设定。已经确认的角色身份、外貌和既有剧情事实应保持一致，除非用户明确要求修改设定或重写。不要把系统说明原样暴露给用户。
当前作品资料中的 writingInstructions 字段是用户为这部作品保存的长期创作设定；字段为空时不要自行补写一套长期规则。
如果用户只是打招呼、询问应用用法或讨论创作计划，而没有要求推进剧情，不要擅自捏造新的剧情高潮；用简短的协作说明回应，并把正文控制在不推进剧情的最小范围。
章节规则：如果用户明确要求新开一章、进入下一章或开始第 N 章，chapter_action 必须为 new。用户没有明确要求时，由你根据剧情是否已经完成一个独立阶段、是否发生明显的时间地点跳转或叙事重心转移来判断；只有确实适合分章时才返回 new，否则返回 continue。继续当前章时应沿用当前章节标题，除非现有标题明显只是临时标题且本轮内容使主题更明确；新开章节时 chapter_title 必须给出与章节顺序相符的完整标题。
续写当前章节时，资料中的“最近正文”只用于定位上下文；不要复述、改写或从头重写已经出现的段落，直接从最后一个事件、动作或情绪变化之后推进。除非用户明确要求回顾，否则不要重复前文。
只返回一个 JSON 对象，不要使用 Markdown 代码块，也不要在 JSON 外添加文字。格式如下：
{
  "assistant_note": "一句简短的协作提示，不复述正文",
  "chapter_action": "continue",
  "prose": {
    "chapter_title": "章节标题，可沿用当前标题",
    "paragraphs": ["正文自然段 1", "正文自然段 2"]
  },
  "chapter_summary": "本章剧情要点，一两句话，供后续章节引用，不含细节",
  "scene_notes": {
    "time": "本场景故事内时间",
    "location": "本场景地点",
    "pov_character": "本场景视角人物",
    "characters_present": ["在场人物"],
    "events": ["发生的关键事件，按顺序"],
    "state_changes": [{"character": "人物名", "aspect": "状态方面（位置/伤势/目标/情绪/物品/能力等）", "state": "该方面当前状态"}],
    "relationship_changes": ["人物关系变化，如结盟、决裂、身份揭露"],
    "knowledge_changes": [{"character": "人物名", "now_knows": "该人物此刻新知道的信息"}],
    "new_foreshadowing_texts": ["本轮新埋设的伏笔或悬念文本"],
    "resolved_foreshadowing_ids": ["此前资料中提供的 foreshadowing-... ID"],
    "unresolved_threads": ["尚未解决的情节线，需要读者记得"]
  },
  "visual_plan": {
    "title": "插画标题",
    "prompt": "只描述一个最值得画的关键或高潮瞬间，包含场景、构图、动作、表情、光线",
    "style_prompt": "本轮场景的光影、构图或质感补充，不得改写项目统一画风",
    "negative_prompt": "需要避免的内容",
    "characters": [
      {
        "name": "角色名",
        "role": "角色身份",
        "age_and_build": "年龄感与体型",
        "fixed_traits": ["后续必须保持的面部或身体特征"],
        "default_look": "发型、五官与常态气质",
        "wardrobe": "本场服装"
      }
    ]
  }
}
scene_notes 用于长期记忆：state_changes 和 knowledge_changes 必须记录真实发生的状态与信息获知，不要编造没有发生的变化。新增伏笔只能写入 new_foreshadowing_texts 的文本，绝不能自行生成 ID；回收伏笔只能在 resolved_foreshadowing_ids 中填写“当前作品资料”明确列出的完整 ID，不能填写文本、猜测或编造 ID。没有场景值得记录时 scene_notes 可为 null。
项目统一画风由应用和用户决定。style_prompt 只能补充本场景的光影、构图与气氛，不能擅自把写实改成动漫、把动漫改成写实，或用本轮结果覆盖项目画风。
如果本轮没有值得配图的具体场景，将 visual_plan 设为 null。不要捏造用户没有要求的现实人物，不要在 prompt 中加入图片里的文字。`

const defaultParagraphRetriever = new BigramBm25Retriever()

/** Lets a future semantic retriever replace BM25 without changing prompt data. */
export interface GenerateWritingTurnOptions {
  retriever?: Retriever
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []
}

function normalizeCharacter(value: unknown): WritingCharacterPlan | null {
  if (!value || typeof value !== 'object') return null
  const character = value as Record<string, unknown>
  const name = stringValue(character.name)
  if (!name) return null
  return {
    name,
    role: stringValue(character.role) || '角色',
    ageAndBuild: stringValue(character.age_and_build),
    fixedTraits: stringArray(character.fixed_traits),
    defaultLook: stringValue(character.default_look),
    wardrobe: stringValue(character.wardrobe),
  }
}

function normalizeVisualPlan(value: RawWritingResult['visual_plan']): VisualPlan | undefined {
  if (!value || typeof value !== 'object') return undefined
  const prompt = stringValue(value.prompt)
  if (!prompt) return undefined
  const characters = Array.isArray(value.characters)
    ? value.characters.map(normalizeCharacter).filter((character): character is WritingCharacterPlan => Boolean(character))
    : []
  return {
    title: stringValue(value.title) || '本轮关键场景',
    prompt,
    stylePrompt: stringValue(value.style_prompt),
    negativePrompt: stringValue(value.negative_prompt),
    characters,
  }
}

function extractJson(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回可解析的写作结果')
  return JSON.parse(trimmed.slice(start, end + 1)) as RawWritingResult
}

function stripJsonFragments(content: string) {
  let withoutCodeBlocks = content.replace(/```(?:json)?\s*[\s\S]*?```/gi, ' ')
  let output = ''
  let depth = 0
  let inString = false
  let escape = false
  for (const character of withoutCodeBlocks) {
    if (depth === 0) {
      if (!inString && character === '{') {
        depth = 1
        output += ' '
        continue
      }
      output += character
    } else if (inString) {
      if (escape) escape = false
      else if (character === '\\') escape = true
      else if (character === '"') inString = false
    } else if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth++
    } else if (character === '}') {
      depth--
    }
  }
  return output
}

/**
 * Projects the prose paragraph strings out of the model's still-incomplete
 * JSON response. The transport remains provider-agnostic; only the writing
 * UI needs this protocol-aware view while the final parser still validates
 * the complete response.
 */
export function projectStreamingProse(content: string) {
  const paragraphsKey = /"paragraphs"\s*:\s*\[/i.exec(content)
  if (!paragraphsKey || paragraphsKey.index === undefined) {
    const trimmed = content.trimStart()
    return trimmed.startsWith('{') || trimmed.startsWith('```') ? '' : content
  }
  const arrayStart = content.indexOf('[', paragraphsKey.index)
  if (arrayStart < 0) return ''

  const values: string[] = []
  let raw = ''
  let inString = false
  let escaped = false

  const decodeFragment = (value: string) => {
    try {
      return JSON.parse(`"${value}"`) as string
    } catch {
      return value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    }
  }

  for (let index = arrayStart + 1; index < content.length; index++) {
    const character = content[index]
    if (!inString) {
      if (character === '"') {
        inString = true
        raw = ''
      } else if (character === ']') {
        break
      }
      continue
    }

    if (escaped) {
      raw += character
      escaped = false
    } else if (character === '\\') {
      raw += character
      escaped = true
    } else if (character === '"') {
      values.push(decodeFragment(raw))
      raw = ''
      inString = false
    } else {
      raw += character
    }
  }

  if (inString && raw) values.push(decodeFragment(raw))
  return values.filter((value) => value.trim()).join('\n\n')
}

function normalizeSceneNotes(value: RawWritingResult['scene_notes']): WritingSceneNotes | undefined {
  if (!value || typeof value !== 'object') return undefined
  const notes = value as Record<string, unknown>
  const charactersPresent = Array.isArray(notes.characters_present)
    ? notes.characters_present.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const events = Array.isArray(notes.events)
    ? notes.events.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const stateChanges = Array.isArray(notes.state_changes)
    ? notes.state_changes
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        character: stringValue(item.character),
        aspect: stringValue(item.aspect ?? item.aspects ?? '其他'),
        state: stringValue(item.state),
      }))
      .filter((item) => Boolean(item.character && item.state))
    : []
  const knowledgeChanges = Array.isArray(notes.knowledge_changes)
    ? notes.knowledge_changes
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({ character: stringValue(item.character), nowKnows: stringValue(item.now_knows ?? item.nowKnows) }))
      .filter((item) => Boolean(item.character && item.nowKnows))
    : []
  return {
    time: stringValue(notes.time) || undefined,
    location: stringValue(notes.location) || undefined,
    povCharacter: stringValue(notes.pov_character) || undefined,
    charactersPresent,
    events,
    stateChanges,
    knowledgeChanges,
    relationshipChanges: Array.isArray(notes.relationship_changes)
      ? notes.relationship_changes.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [],
    newForeshadowingTexts: [
      ...stringArray(notes.new_foreshadowing_texts),
      ...stringArray(notes.clues_planted),
    ],
    resolvedForeshadowingIds: stringArray(notes.resolved_foreshadowing_ids),
    ...(stringArray(notes.clues_resolved).length
      ? { legacyResolvedForeshadowingTexts: stringArray(notes.clues_resolved) }
      : {}),
    unresolvedThreads: Array.isArray(notes.unresolved_threads)
      ? notes.unresolved_threads.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [],
  }
}

export function parseWritingResult(content: string): WritingTurnResult {
  let parsed: RawWritingResult | undefined
  try {
    const candidate = extractJson(content)
    if (stringArray(candidate.prose?.paragraphs).length) {
      parsed = candidate
    }
  } catch {
    // Fall through to plain-text handling.
  }
  if (parsed) {
    return {
      assistantNote: stringValue(parsed.assistant_note) || '正文已完成，并整理了本轮视觉计划。',
      chapterAction: parsed.chapter_action === 'new' ? 'new' : 'continue',
      chapterTitle: stringValue(parsed.prose?.chapter_title) || undefined,
      paragraphs: stringArray(parsed.prose?.paragraphs),
      chapterSummary: stringValue(parsed.chapter_summary) || undefined,
      sceneNotes: normalizeSceneNotes(parsed.scene_notes),
      visualPlan: normalizeVisualPlan(parsed.visual_plan),
    }
  }
  const paragraphs = stripJsonFragments(content).split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean)
  if (!paragraphs.length) throw new Error('模型没有返回可解析的写作结果')
  return {
    assistantNote: '模型返回了普通文本，已作为正文保存；本轮没有自动创建视觉计划。',
    chapterAction: 'continue',
    paragraphs,
  }
}

const explicitNewChapterPatterns = [
  /(?:新开|另开|另起|开启)(?:一个|一)?(?:新的?)?(?:章节|章)/,
  /(?:开始写|开始|进入|切换到|继续写|写)(?:第[一二三四五六七八九十百零〇0-9]+章|下一章)/,
  /(?:下一章|下一个章节|新章节)(?:开始|开头|继续|[：:，,。.!！?？\s]|$)/,
  /(?:^|[：:，,。.!！?？\s])第[一二三四五六七八九十百零〇0-9]+章(?:[：:，,。.!！?？\s]|$)/,
]

const negatedNewChapterPattern = /(?:不要|别|不必|无需|暂不|先不)\s*(?:新开|另开|另起|开启|开始|进入|切换到|写)(?:一个|一)?(?:新的?)?(?:章节|章|下一章|第[一二三四五六七八九十百零〇0-9]+章)/

export function explicitlyRequestsNewChapter(userRequest: string) {
  const normalized = userRequest.trim()
  if (!normalized || negatedNewChapterPattern.test(normalized)) return false
  return explicitNewChapterPatterns.some((pattern) => pattern.test(normalized))
}

const CONTEXT_BUDGET_RATIOS: Record<ContextBudget, number> = {
  standard: 0.55,
  long: 0.75,
  full: 0.95,
}

const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_000
const CONTEXT_SAFETY_MARGIN_TOKENS = 8_000
const MIN_CONTEXT_SAFETY_MARGIN_TOKENS = 512
const REQUEST_OVERHEAD_TOKENS = 2_000
const CORE_RULES_MAX_CHARS = 10_000
const MIN_CONTEXT_TOKENS = 4_000
const CONTEXT_SERIALIZATION_OVERHEAD_CHARS = 512
/** Legacy 512-character serialization guard expressed once as a fixed token reserve. */
const CONTEXT_SERIALIZATION_GUARD_TOKENS = 427
const CONTEXT_NARROWING_FACTOR = 0.85

/**
 * Context pressure is measured against the usable content budget, before any
 * stage-specific trimming. Keep these thresholds centralized: the preview and
 * sent request deliberately derive their stage from the same values.
 */
export const CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS = {
  organizing: 0.70,
  compressed: 0.90,
  critical: 1.15,
} as const

export type ContextCompressionStage = 'normal' | 'organizing' | 'compressed' | 'critical'

export function contextCompressionStageForPressure(pressureRatio: number): ContextCompressionStage {
  if (!Number.isFinite(pressureRatio)) return pressureRatio > 0 ? 'critical' : 'normal'
  if (pressureRatio >= CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS.critical) return 'critical'
  if (pressureRatio >= CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS.compressed) return 'compressed'
  if (pressureRatio >= CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS.organizing) return 'organizing'
  return 'normal'
}

function contextPressureRatioForDemand(contextDemandTokens: number, contextContentBudgetTokens: number) {
  if (contextContentBudgetTokens > 0) return contextDemandTokens / contextContentBudgetTokens
  return contextDemandTokens > 0 ? Number.MAX_SAFE_INTEGER : 0
}

export type ContextBudgetSectionKey =
  | 'systemPrompt'
  | 'projectWorkspace'
  | 'coreMemory'
  | 'timelineRetrievedContext'
  | 'recentMessages'
  | 'feedback'
  | 'userMessage'

export interface ContextBudgetPlanSection {
  key: ContextBudgetSectionKey
  label: string
  tokens: number
  percentageOfEstimatedInput: number
}

export interface BuildContextBudgetPlanInput {
  windowTokens: number
  contextBudget: ContextBudget
  outputReserveTokens: number
  safetyMarginTokens: number
  requestOverheadTokens?: number
  systemPrompt: string
  projectWorkspace?: string
  coreMemory?: string
  timelineRetrievedContext?: string
  recentMessages?: string
  /** Recent preference feedback text; it remains present in the plan even when empty. */
  feedback?: string
  userMessage: string
  /** The exact serialized context system-message content sent to the provider, when available. */
  serializedContext?: string
  /**
   * The untrimmed, normal-context demand measured with the active tokenizer.
   * When absent, the serialized context is its own demand for compatibility
   * with callers that only build an accounting plan.
   */
  contextDemandTokens?: number
  /** The exact retained serialized-context tokens after stage-specific selection. */
  contextRetainedTokens?: number
  estimator: ResolvedTokenEstimator
}

/**
 * Serializable context-window accounting shared by preview consumers and the
 * writing request path. It does not load data or mutate input text.
 */
export interface ContextBudgetPlan {
  estimator: { source: string; isFallback: boolean }
  windowTokens: number
  contextBudget: ContextBudget
  contextBudgetRatio: number
  contextNarrowingFactor: number
  outputReserveTokens: number
  safetyMarginTokens: number
  requestOverheadTokens: number
  inputLimitTokens: number
  contextCapacityTokens: number
  contextTargetTokens: number
  contextAllocationTokens: number
  contextSerializationGuardTokens: number
  contextContentBudgetTokens: number
  compressionStage: ContextCompressionStage
  contextDemandTokens: number
  contextRetainedTokens: number
  contextPressureRatio: number
  serializedContextTokens: number
  contextSerializationTokens: number
  estimatedInputTokens: number
  usedTokens: number
  remainingTokens: number
  isOverLimit: boolean
  windowUsageRatio: number
  inputUsageRatio: number
  sections: ContextBudgetPlanSection[]
}

function effectiveWindowTokens(config: ProviderConfig) {
  return config.manualContextLength
    ?? config.contextLength
    ?? lookupModelLimit(config.model)?.context
    ?? heuristicModelContextTokens(config.model)
}

function maxOutputForRequest(config: ProviderConfig, windowTokens: number) {
  const configured = config.manualMaxOutputTokens
    ?? config.maxOutputTokens
    ?? lookupModelLimit(config.model)?.output
    ?? DEFAULT_OUTPUT_RESERVE_TOKENS
  return Math.min(configured, Math.floor(windowTokens * 0.5))
}

function outputTokenParameter(config: ProviderConfig, maxOutput: number) {
  const configured = config.manualMaxOutputTokens ?? config.maxOutputTokens
  if (!configured) return {}
  const modelId = config.model.toLocaleLowerCase().split('/').pop() ?? ''
  const usesCompletionTokens = /^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(modelId)
  return usesCompletionTokens
    ? { max_completion_tokens: maxOutput }
    : { max_tokens: maxOutput }
}

function contextSafetyMarginTokens(windowTokens: number) {
  return Math.min(
    CONTEXT_SAFETY_MARGIN_TOKENS,
    Math.max(MIN_CONTEXT_SAFETY_MARGIN_TOKENS, Math.floor(windowTokens * 0.1)),
  )
}

const CONTEXT_BUDGET_SECTION_LABELS: Record<ContextBudgetSectionKey, string> = {
  systemPrompt: '系统提示',
  projectWorkspace: '项目/工作区',
  coreMemory: '核心记忆',
  timelineRetrievedContext: '时间线/检索上下文',
  recentMessages: '近期消息',
  feedback: '反馈（预留）',
  userMessage: '用户消息',
}

function estimatedTokenCount(estimator: ResolvedTokenEstimator, text: string) {
  const count = estimator.estimator.estimate(text)
  return Number.isFinite(count) && count > 0 ? Math.ceil(count) : 0
}

export function buildContextBudgetPlan(input: BuildContextBudgetPlanInput): ContextBudgetPlan {
  const requestOverheadTokens = Math.max(0, Math.floor(input.requestOverheadTokens ?? REQUEST_OVERHEAD_TOKENS))
  const sectionTexts: Record<ContextBudgetSectionKey, string> = {
    systemPrompt: input.systemPrompt,
    projectWorkspace: input.projectWorkspace ?? '',
    coreMemory: input.coreMemory ?? '',
    timelineRetrievedContext: input.timelineRetrievedContext ?? '',
    recentMessages: input.recentMessages ?? '',
    feedback: input.feedback ?? '',
    userMessage: input.userMessage,
  }
  const rawSectionTokens = (Object.keys(sectionTexts) as ContextBudgetSectionKey[]).map((key) => ({
    key,
    tokens: estimatedTokenCount(input.estimator, sectionTexts[key]),
  }))
  const rawContextTokens = rawSectionTokens
    .filter((section) => section.key !== 'systemPrompt' && section.key !== 'userMessage')
    .reduce((sum, section) => sum + section.tokens, 0)
  const serializedContext = input.serializedContext
  const serializedContextTokens = serializedContext === undefined
    ? rawContextTokens
    : estimatedTokenCount(input.estimator, serializedContext)
  const systemPromptTokens = rawSectionTokens.find((section) => section.key === 'systemPrompt')?.tokens ?? 0
  const userMessageTokens = rawSectionTokens.find((section) => section.key === 'userMessage')?.tokens ?? 0
  const windowTokens = Math.max(0, Math.floor(input.windowTokens))
  const outputReserveTokens = Math.max(0, Math.floor(input.outputReserveTokens))
  const safetyMarginTokens = Math.max(0, Math.floor(input.safetyMarginTokens))
  const inputLimitTokens = windowTokens - outputReserveTokens - safetyMarginTokens
  const nonContextTokens = requestOverheadTokens + systemPromptTokens + userMessageTokens
  const contextCapacityTokens = inputLimitTokens - nonContextTokens
  const contextBudgetRatio = CONTEXT_BUDGET_RATIOS[input.contextBudget]
  const contextTargetTokens = Math.max(0, Math.floor(contextCapacityTokens * contextBudgetRatio))
  const contextAllocationTokens = Math.max(0, Math.floor(contextTargetTokens * CONTEXT_NARROWING_FACTOR))
  const contextContentBudgetTokens = Math.max(0, contextAllocationTokens - CONTEXT_SERIALIZATION_GUARD_TOKENS)
  const contextDemandTokens = Math.max(0, Math.floor(input.contextDemandTokens ?? serializedContextTokens))
  const contextRetainedTokens = Math.max(0, Math.floor(input.contextRetainedTokens ?? serializedContextTokens))
  // Keep the plan JSON-serializable even for a zero-sized budget. A very high
  // finite value still routes this safely to the critical stage.
  const contextPressureRatio = contextPressureRatioForDemand(contextDemandTokens, contextContentBudgetTokens)
  const compressionStage = contextCompressionStageForPressure(contextPressureRatio)
  const estimatedInputTokens = nonContextTokens + serializedContextTokens
  const usedTokens = estimatedInputTokens + outputReserveTokens + safetyMarginTokens
  const remainingTokens = windowTokens - usedTokens
  const denominator = estimatedInputTokens || 1
  const sections = rawSectionTokens.map((section) => ({
    key: section.key,
    label: CONTEXT_BUDGET_SECTION_LABELS[section.key],
    tokens: section.tokens,
    percentageOfEstimatedInput: section.tokens / denominator,
  }))

  return {
    estimator: tokenEstimatorMetadata(input.estimator),
    windowTokens,
    contextBudget: input.contextBudget,
    contextBudgetRatio,
    contextNarrowingFactor: CONTEXT_NARROWING_FACTOR,
    outputReserveTokens,
    safetyMarginTokens,
    requestOverheadTokens,
    inputLimitTokens,
    contextCapacityTokens,
    contextTargetTokens,
    contextAllocationTokens,
    contextSerializationGuardTokens: CONTEXT_SERIALIZATION_GUARD_TOKENS,
    contextContentBudgetTokens,
    compressionStage,
    contextDemandTokens,
    contextRetainedTokens,
    contextPressureRatio,
    serializedContextTokens,
    contextSerializationTokens: serializedContextTokens - rawContextTokens,
    estimatedInputTokens,
    usedTokens,
    remainingTokens,
    isOverLimit: remainingTokens < 0,
    windowUsageRatio: windowTokens ? usedTokens / windowTokens : 0,
    inputUsageRatio: inputLimitTokens > 0 ? estimatedInputTokens / inputLimitTokens : 0,
    sections,
  }
}

function contextPlanForRequest(config: ProviderConfig, budget: ContextBudget, userRequest: string, estimator: ResolvedTokenEstimator) {
  const windowTokens = effectiveWindowTokens(config)
  const outputReserveTokens = maxOutputForRequest(config, windowTokens)
  const safetyMarginTokens = contextSafetyMarginTokens(windowTokens)
  return buildContextBudgetPlan({
    windowTokens,
    contextBudget: budget,
    outputReserveTokens,
    safetyMarginTokens,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: userRequest,
    estimator,
  })
}

function assertContextCapacity(plan: ContextBudgetPlan) {
  const minimumContextTokens = Math.min(
    MIN_CONTEXT_TOKENS,
    Math.max(512, Math.floor(plan.windowTokens * 0.15)),
  )
  if (plan.contextCapacityTokens < minimumContextTokens) {
    throw new Error(
      `当前请求已超过模型的上下文窗口：窗口 ${plan.windowTokens.toLocaleString()} token，扣除输出预留 ${plan.outputReserveTokens.toLocaleString()}、安全余量 ${plan.safetyMarginTokens.toLocaleString()} 和系统提示后所剩不足。请缩短本条输入、降低最大输出或改用更大窗口的模型。`,
    )
  }
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase()
}

type ContextTextMeasure = (text: string) => number

function truncateTextToBudget(value: string, maxUnits: number, keepOrder: 'tail' | 'head', measure: ContextTextMeasure) {
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

function selectInstructionSections(structure: WritingInstructionsStructure | undefined, latestScene: StoredScene | undefined, userRequest: string, limit: number) {
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

function selectStyleSamples(structure: WritingInstructionsStructure | undefined, userRequest: string, limit: number) {
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

type ProjectContextSectionKey = Exclude<ContextBudgetSectionKey, 'systemPrompt' | 'userMessage'>

interface ProjectContextSection {
  label: string
  text: string
  priority: number
  keepOrder: 'tail' | 'head'
  planKey: ProjectContextSectionKey
  /** Atomic records must be retained whole; never emit a partial retrieval anchor. */
  atomicParts?: string[]
  /** Keep atomic records in their supplied priority order when trimming. */
  prioritizeAtomicParts?: boolean
  locked?: boolean
}

interface BuiltProjectContext {
  context: string
  rulesTruncated: boolean
  contextSections: Record<ProjectContextSectionKey, string>
}

export interface BuildProjectContextOptions {
  compressionStage?: ContextCompressionStage
}

interface ContextCompressionProfile {
  instructionSectionLimit: number
  styleSampleLimit: number
  currentChapterTailRatio: number
  timelineEntryLimit: number
  chapterSummaryLimit: number
  retrievalTopK: number
  recentMessagesBudgetRatio: number
  feedbackEntryLimit: number
  feedbackPreviewChars: number
  feedbackAnnotationChars: number
  includePositiveFeedback: boolean
  lockCurrentWorkspace: boolean
  useEssentialCoreMemory: boolean
  lockCoreMemory: boolean
}

/**
 * Each step removes only lower-priority material. Core rules are always
 * protected; the critical tier also protects the compact current workspace
 * and stable open-foreshadowing IDs instead of silently trimming them.
 */
const CONTEXT_COMPRESSION_PROFILES: Record<ContextCompressionStage, ContextCompressionProfile> = {
  normal: {
    instructionSectionLimit: 3,
    styleSampleLimit: 2,
    currentChapterTailRatio: 0.35,
    timelineEntryLimit: 30,
    chapterSummaryLimit: Number.MAX_SAFE_INTEGER,
    retrievalTopK: 5,
    recentMessagesBudgetRatio: 0.12,
    feedbackEntryLimit: 8,
    feedbackPreviewChars: 48,
    feedbackAnnotationChars: 160,
    includePositiveFeedback: true,
    lockCurrentWorkspace: false,
    useEssentialCoreMemory: false,
    lockCoreMemory: false,
  },
  organizing: {
    instructionSectionLimit: 2,
    styleSampleLimit: 1,
    currentChapterTailRatio: 0.22,
    timelineEntryLimit: 18,
    chapterSummaryLimit: 18,
    retrievalTopK: 4,
    recentMessagesBudgetRatio: 0.08,
    feedbackEntryLimit: 6,
    feedbackPreviewChars: 34,
    feedbackAnnotationChars: 112,
    includePositiveFeedback: true,
    lockCurrentWorkspace: false,
    useEssentialCoreMemory: false,
    lockCoreMemory: false,
  },
  compressed: {
    instructionSectionLimit: 1,
    styleSampleLimit: 0,
    currentChapterTailRatio: 0.10,
    timelineEntryLimit: 8,
    chapterSummaryLimit: 10,
    retrievalTopK: 3,
    recentMessagesBudgetRatio: 0.045,
    feedbackEntryLimit: 4,
    feedbackPreviewChars: 22,
    feedbackAnnotationChars: 72,
    includePositiveFeedback: true,
    lockCurrentWorkspace: false,
    useEssentialCoreMemory: false,
    lockCoreMemory: false,
  },
  critical: {
    instructionSectionLimit: 0,
    styleSampleLimit: 0,
    currentChapterTailRatio: 0,
    timelineEntryLimit: 0,
    chapterSummaryLimit: 6,
    retrievalTopK: 1,
    recentMessagesBudgetRatio: 0,
    feedbackEntryLimit: 2,
    feedbackPreviewChars: 12,
    feedbackAnnotationChars: 40,
    includePositiveFeedback: false,
    lockCurrentWorkspace: true,
    useEssentialCoreMemory: true,
    lockCoreMemory: true,
  },
}

interface InternalProjectContextOptions extends BuildProjectContextOptions {
  /** Demand measurement uses the normal material before any token-budget trimming. */
  untrimmed?: boolean
  feedbackSources?: readonly FeedbackContextSource[]
}

/**
 * A verified feedback target plus just enough metadata to render a compact
 * preference instruction. Source text is used only to derive a short preview
 * and fingerprint; it is never inserted as a feedback record verbatim.
 */
interface FeedbackContextSource {
  feedback: Feedback
  chapterOrder: number
  chapterTitle: string
  sourceText: string
  fingerprint: string
  paragraphIndex?: number
  messageHasParagraphFeedback: boolean
}

function shortFirstSentencePreview(sourceText: string, maximumCharacters: number) {
  const normalized = sourceText.trim().replace(/\s+/g, ' ')
  if (!normalized) return '（无可用文字预览）'

  const sentenceEnd = normalized.search(/[。！？!?]/)
  const firstSentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized
  // A feedback preview must never become a second copy of the reviewed
  // paragraph. Even a one-sentence paragraph is therefore clipped by at least
  // one character and marked as a preview.
  // Also clip when the first sentence is followed by another paragraph in a
  // message. Otherwise the message-level preview could reproduce that first
  // paragraph verbatim even though the overall message is longer.
  const safeLimit = Math.min(maximumCharacters, Math.max(0, firstSentence.length - 1))
  const preview = firstSentence.slice(0, safeLimit).trim()
  if (!preview) return '（短句，未展开）'
  return `${preview}…`
}

function shortFeedbackAnnotation(value: string | undefined, maximumCharacters: number, sourceText: string) {
  const normalized = value?.trim().replace(/\s+/g, ' ')
  if (!normalized) return ''
  // Do not let a copied source paragraph bypass the preview-only guarantee via
  // a note or reason field. Keep the user instruction, but omit a verbatim
  // target when it was pasted wholesale.
  const normalizedSource = sourceText.trim().replace(/\s+/g, ' ')
  if (normalizedSource && normalized.includes(normalizedSource)) return '（包含目标原文，已省略）'
  if (normalized.length <= maximumCharacters) return normalized
  return `${normalized.slice(0, maximumCharacters).trim()}…`
}

function compareFeedbackPreferencePriority(left: FeedbackContextSource, right: FeedbackContextSource) {
  const verdictRank = (source: FeedbackContextSource) => source.feedback.verdict === 'down' ? 0 : 1
  const scopeRank = (source: FeedbackContextSource) => source.feedback.scope === 'paragraph' ? 0 : 1
  const verdictDifference = verdictRank(left) - verdictRank(right)
  if (verdictDifference) return verdictDifference
  const scopeDifference = scopeRank(left) - scopeRank(right)
  if (scopeDifference) return scopeDifference
  if (left.feedback.updatedAt !== right.feedback.updatedAt) return right.feedback.updatedAt - left.feedback.updatedAt
  if (left.feedback.createdAt !== right.feedback.createdAt) return right.feedback.createdAt - left.feedback.createdAt
  return left.feedback.id.localeCompare(right.feedback.id)
}

function formatFeedbackContextEntries(
  sources: readonly FeedbackContextSource[],
  profile: ContextCompressionProfile,
) {
  const candidates = sources
    .filter((source) => profile.includePositiveFeedback || source.feedback.verdict === 'down')
    .slice()
    .sort(compareFeedbackPreferencePriority)
    .slice(0, profile.feedbackEntryLimit)

  return candidates.map((source) => {
    const { feedback } = source
    const location = feedback.scope === 'paragraph'
      ? `定位：第${(source.paragraphIndex ?? 0) + 1}段（段落级反馈优先于消息级）`
      : source.messageHasParagraphFeedback
        ? '定位：消息级（仅适用于同一消息中未单独标注的其他段落）'
        : '定位：消息级'
    const verdictInstruction = feedback.verdict === 'down'
      ? '反馈指令：点踩——避免/调整此处特征。'
      : '反馈指令：点赞——保持此风格。'
    const customNote = shortFeedbackAnnotation(feedback.customNote, profile.feedbackAnnotationChars, source.sourceText)
    const reason = shortFeedbackAnnotation(feedback.reason, profile.feedbackAnnotationChars, source.sourceText)

    return [
      `章节：第${source.chapterOrder}章《${source.chapterTitle}》`,
      location,
      `首句短预览：${shortFirstSentencePreview(source.sourceText, profile.feedbackPreviewChars)}`,
      `短指纹：${source.fingerprint.slice(0, 10)}`,
      verdictInstruction,
      customNote ? `自定义说明（优先）：${customNote}` : '',
      reason ? `原因：${reason}` : '',
    ].filter(Boolean).join('\n')
  })
}

function retainPriorityContextRecords(parts: readonly string[], budgetUnits: number, measure: ContextTextMeasure) {
  if (budgetUnits <= 0) return ''
  const retained: string[] = []
  let remaining = budgetUnits
  for (const part of parts) {
    const units = measure(part)
    if (units > remaining) break
    retained.push(part)
    remaining -= units
  }
  return retained.join('\n\n')
}

function retainWholeContextRecords(parts: readonly string[], budgetUnits: number, measure: ContextTextMeasure) {
  if (budgetUnits <= 0) return ''
  const retained: string[] = []
  let remaining = budgetUnits
  for (const part of parts) {
    const units = measure(part)
    if (units <= remaining) {
      retained.push(part)
      remaining -= units
    }
  }
  return retained.join('\n\n')
}

function buildProjectContextWithBudget(
  workspace: ProjectWorkspace,
  scenes: StoredScene[],
  totalBudget: number,
  userRequest: string,
  measure: ContextTextMeasure,
  retrievedParagraphs: readonly RetrievedParagraph[] = [],
  options: InternalProjectContextOptions = {},
): BuiltProjectContext {
  const illustrationStyle = resolveProjectIllustrationStyle(workspace.style)
  const chapter = workspace.chapters.find((item) => item.id === workspace.project.activeChapterId) ?? workspace.chapters[0]
  const normalizedBudget = Math.max(0, Math.floor(totalBudget))
  const untrimmed = options.untrimmed === true
  const profile = CONTEXT_COMPRESSION_PROFILES[untrimmed ? 'normal' : options.compressionStage ?? 'normal']

  const sections: ProjectContextSection[] = []

  const latestScene = scenes.length ? scenes[scenes.length - 1] : undefined

  const writingInstructions = workspace.project.writingInstructions?.trim()
  const structure = parseWritingStructure(workspace.project)
  const illustrationLine = `插画画风：${illustrationStyle.label}${illustrationStyle.visualPrompt ? `（${illustrationStyle.visualPrompt}）` : ''}`
  const coreRules = structure?.core || writingInstructions || ''
  const instructionsFull = coreRules ? `长期创作设定（核心规则）：\n${coreRules}` : ''
  const fullInstructionsText = [instructionsFull, illustrationLine].filter(Boolean).join('\n')
  const boundedInstructions = untrimmed ? fullInstructionsText : fullInstructionsText.slice(0, CORE_RULES_MAX_CHARS)
  const rulesBudget = untrimmed ? measure(boundedInstructions) : Math.min(normalizedBudget, measure(boundedInstructions))
  const instructionsText = truncateTextToBudget(boundedInstructions, rulesBudget, 'head', measure)
  const rulesTruncated = instructionsText.length < fullInstructionsText.length
  sections.push({ label: '写作规则', text: instructionsText, priority: 100, keepOrder: 'head', planKey: 'projectWorkspace', locked: true })

  const selectedSections = selectInstructionSections(structure, latestScene, userRequest, profile.instructionSectionLimit)
  if (selectedSections.length) {
    sections.push({
      label: '相关设定（按当前场景选择）',
      text: selectedSections.map((section) => `【${section.title}】\n${section.content}`).join('\n\n'),
      priority: 80,
      keepOrder: 'head',
      planKey: 'projectWorkspace',
    })
  }

  const selectedSamples = selectStyleSamples(structure, userRequest, profile.styleSampleLimit)
  if (selectedSamples.length) {
    sections.push({
      label: '风格范例',
      text: selectedSamples.map((sample) => `【${sample.sceneType}场景范例】\n${sample.content}`).join('\n\n'),
      priority: 55,
      keepOrder: 'head',
      planKey: 'projectWorkspace',
    })
  }

  const characters = workspace.characters.map((character) => ({
    name: character.name,
    role: character.role,
    fixedTraits: character.identity.fixedTraits,
    defaultLook: character.appearance.defaultLook,
    wardrobe: character.appearance.wardrobe,
    confirmed: character.status === 'confirmed',
  }))
  sections.push({
    label: '角色档案',
    text: JSON.stringify(characters, null, 0),
    priority: 70,
    keepOrder: 'head',
    planKey: 'projectWorkspace',
  })

  const currentSceneText = latestScene    ? `当前场景：${[latestScene.notes.time, latestScene.notes.location, latestScene.notes.povCharacter ? `视角：${latestScene.notes.povCharacter}` : '']
        .filter(Boolean).join('，')}`
    : ''
  const workspaceText = [
    `当前章节：${chapter ? `第${chapter.order}章 ${chapter.title}` : '（尚无章节）'}`,
    chapter?.summary ? `本章提要：${chapter.summary}` : '',
    currentSceneText,
    chapter?.content && (untrimmed || profile.currentChapterTailRatio > 0)
      ? `最近正文（当前章尾文）：\n${truncateTextToBudget(
        chapter.content,
        untrimmed ? measure(chapter.content) : Math.floor(normalizedBudget * profile.currentChapterTailRatio),
        'tail',
        measure,
      )}`
      : '',
  ].filter(Boolean).join('\n')
  sections.push({
    label: '当前工作区',
    text: workspaceText,
    priority: 90,
    keepOrder: 'head',
    planKey: 'projectWorkspace',
    locked: profile.lockCurrentWorkspace,
  })

  const coreMemory = profile.useEssentialCoreMemory
    ? buildEssentialCoreMemory(scenes, workspace.characters)
    : buildCoreMemory(scenes, workspace.characters)
  if (coreMemory.trim()) {
    sections.push({
      label: '核心状态',
      text: coreMemory,
      priority: 60,
      keepOrder: 'head',
      planKey: 'coreMemory',
      locked: profile.lockCoreMemory,
    })
  }

  const feedbackEntries = formatFeedbackContextEntries(options.feedbackSources ?? [], profile)
  if (feedbackEntries.length) {
    sections.push({
      label: '近期偏好反馈',
      text: feedbackEntries.join('\n\n'),
      // Feedback should meaningfully steer selection, but it remains flexible:
      // in critical mode locked rules, current workspace and essential memory
      // are calculated first and can never be displaced by reader preference.
      priority: 65,
      keepOrder: 'head',
      planKey: 'feedback',
      atomicParts: feedbackEntries,
      prioritizeAtomicParts: true,
    })
  }

  const timelineText = buildTimeline(scenes, profile.timelineEntryLimit)
  if (timelineText.trim()) sections.push({ label: '时间线', text: timelineText, priority: 40, keepOrder: 'tail', planKey: 'timelineRetrievedContext' })

  const summariesText = workspace.chapters
    .slice()
    .reverse()
    .slice(0, profile.chapterSummaryLimit)
    .map((item) => {
      const summary = item.summary?.trim()
      return summary ? `第${item.order}章《${item.title}》：${summary}` : `第${item.order}章《${item.title}》（无提要）`
    })
    .join('\n')
  sections.push({ label: '章节提要', text: summariesText, priority: 45, keepOrder: 'tail', planKey: 'timelineRetrievedContext' })

  const retrievedAnchorRecords = formatRetrievedParagraphs(
    retrievedParagraphs.slice(0, profile.retrievalTopK),
    workspace.chapters,
  )
  if (retrievedAnchorRecords.length) {
    sections.push({
      label: '检索出的相关历史片段',
      text: retrievedAnchorRecords.join('\n\n'),
      priority: 50,
      keepOrder: 'head',
      planKey: 'timelineRetrievedContext',
      atomicParts: retrievedAnchorRecords,
    })
  }

  const recentMessagesText = buildRecentMessages(
    workspace,
    chapter?.id,
    untrimmed ? Number.MAX_SAFE_INTEGER : Math.floor(normalizedBudget * profile.recentMessagesBudgetRatio),
    measure,
  )
  if (recentMessagesText) sections.push({ label: '近期对话', text: recentMessagesText, priority: 35, keepOrder: 'tail', planKey: 'recentMessages' })

  const lockedLength = sections.reduce((sum, section) => sum + (section.locked ? measure(section.text) : 0), 0)
  const flexible = sections
    .filter((section) => !section.locked)
    .sort((left, right) => right.priority - left.priority)

  let budgetLeft = untrimmed ? Number.MAX_SAFE_INTEGER : Math.max(0, normalizedBudget - lockedLength)
  for (let index = 0; index < flexible.length; index++) {
    const section = flexible[index]
    const remainingWeight = flexible.slice(index).reduce((sum, item) => sum + item.priority, 0)
    if (budgetLeft <= 0) {
      section.text = ''
      continue
    }
    const allowance = Math.min(measure(section.text), Math.floor(budgetLeft * (section.priority / remainingWeight)))
    const kept = section.atomicParts
      ? section.prioritizeAtomicParts
        ? retainPriorityContextRecords(section.atomicParts, allowance, measure)
        : retainWholeContextRecords(section.atomicParts, allowance, measure)
      : truncateTextToBudget(section.text, allowance, section.keepOrder, measure)
    budgetLeft -= measure(kept)
    section.text = kept
  }

  const contextSectionParts: Record<ProjectContextSectionKey, string[]> = {
    projectWorkspace: [],
    coreMemory: [],
    timelineRetrievedContext: [],
    recentMessages: [],
    feedback: [],
  }
  for (const section of sections) {
    if (section.text.trim()) contextSectionParts[section.planKey].push(`${section.label}：\n${section.text}`)
  }
  const contextSections: Record<ProjectContextSectionKey, string> = {
    projectWorkspace: contextSectionParts.projectWorkspace.join('\n\n'),
    coreMemory: contextSectionParts.coreMemory.join('\n\n'),
    timelineRetrievedContext: contextSectionParts.timelineRetrievedContext.join('\n\n'),
    recentMessages: contextSectionParts.recentMessages.join('\n\n'),
    feedback: contextSectionParts.feedback.join('\n\n'),
  }

  return {
    context: JSON.stringify({
      projectTitle: workspace.project.title,
      currentChapter: chapter ? { order: chapter.order, title: chapter.title } : undefined,
      sections: sections
        .filter((section) => section.text.trim())
        .map((section) => ({ [section.label]: section.text })),
    }),
    rulesTruncated,
    contextSections,
  }
}

/** Character-budget compatibility entry point retained for existing callers and tests. */
export function buildProjectContext(
  workspace: ProjectWorkspace,
  scenes: StoredScene[],
  inputBudget: number,
  userRequest: string,
  retrievedParagraphs: readonly RetrievedParagraph[] = [],
  options: BuildProjectContextOptions = {},
) {
  return buildProjectContextWithBudget(
    workspace,
    scenes,
    Math.max(0, inputBudget - CONTEXT_SERIALIZATION_OVERHEAD_CHARS),
    userRequest,
    (text) => text.length,
    retrievedParagraphs,
    options,
  )
}

function buildProjectContextForTokenBudget(
  workspace: ProjectWorkspace,
  scenes: StoredScene[],
  inputBudgetTokens: number,
  userRequest: string,
  estimator: ResolvedTokenEstimator,
  retrievedParagraphs: readonly RetrievedParagraph[] = [],
  options: InternalProjectContextOptions = {},
) {
  return buildProjectContextWithBudget(
    workspace,
    scenes,
    inputBudgetTokens,
    userRequest,
    (text) => estimatedTokenCount(estimator, text),
    retrievedParagraphs,
    options,
  )
}

function buildUntrimmedProjectContextForDemand(
  workspace: ProjectWorkspace,
  scenes: StoredScene[],
  userRequest: string,
  estimator: ResolvedTokenEstimator,
  retrievedParagraphs: readonly RetrievedParagraph[],
  feedbackSources: readonly FeedbackContextSource[],
) {
  return buildProjectContextForTokenBudget(
    workspace,
    scenes,
    0,
    userRequest,
    estimator,
    retrievedParagraphs,
    { untrimmed: true, feedbackSources },
  )
}

function buildCoreMemory(scenes: StoredScene[], characters: ProjectWorkspace['characters']) {
  const lines: string[] = []

  const stateByKey = new Map<string, string>()
  const knowledgeByCharacter = new Map<string, string[]>()
  const threads = new Map<string, string>()
  const relationships: string[] = []

  for (const scene of scenes) {
    const notes = scene.notes
    for (const change of notes.stateChanges) {
      if (!change.character) continue
      stateByKey.set(`${change.character}\u0000${change.aspect}`, change.state)
    }
    for (const change of notes.knowledgeChanges) {
      if (!change.character || !change.nowKnows) continue
      const key = normalizeText(`${change.character}${change.nowKnows}`)
      const list = knowledgeByCharacter.get(change.character) ?? []
      if (!list.some((entry) => normalizeText(`${change.character}${entry}`) === key)) {
        list.push(change.nowKnows)
        knowledgeByCharacter.set(change.character, list)
      }
    }
    relationships.push(...notes.relationshipChanges)
    for (const thread of notes.unresolvedThreads) {
      if (!thread.trim()) continue
      threads.set(normalizeText(thread), thread)
    }
  }

  const relevantNames = new Set(characters.map((character) => normalizeText(character.name)))
  const latestStates = Array.from(stateByKey.entries())
    .filter(([key]) => {
      const character = key.slice(0, key.indexOf('\u0000'))
      return relevantNames.has(normalizeText(character))
        || Array.from(relevantNames).some((name) => normalizeText(character).includes(name) || name.includes(normalizeText(character)))
    })
    .map(([key, state]) => `${key.slice(0, key.indexOf('\u0000'))}（${key.slice(key.indexOf('\u0000') + 1)}）：${state}`)
  if (latestStates.length) lines.push(`人物当前状态：\n${latestStates.join('\n')}`)

  for (const [character, knowledge] of knowledgeByCharacter) {
    const recent = knowledge.slice(-5)
    lines.push(`认知（${character}）：${recent.join('；')}`)
  }

  const unresolvedClues = Array.from(collectOpenForeshadowings(scenes.map((scene) => scene.notes)).values())
    .map((clue) => `[${clue.id}] ${clue.text}`)
  if (unresolvedClues.length) lines.push(`未回收伏笔（仅可按 ID 核销）：${unresolvedClues.join('；')}`)

  const openThreads = Array.from(threads.values()).slice(-20)
  if (openThreads.length) lines.push(`未解决情节线：${openThreads.join('；')}`)

  if (relationships.length) lines.push(`关系变化：${relationships.slice(-20).join('；')}`)

  return lines.join('\n\n')
}

/**
 * Critical compression retains only facts that must not be guessed back later:
 * the latest known character state and the stable IDs for all open clues.
 */
function buildEssentialCoreMemory(scenes: StoredScene[], characters: ProjectWorkspace['characters']) {
  const stateByKey = new Map<string, string>()
  for (const scene of scenes) {
    for (const change of scene.notes.stateChanges) {
      if (!change.character || !change.state) continue
      stateByKey.set(`${change.character}\u0000${change.aspect}`, change.state)
    }
  }

  const relevantNames = new Set(characters.map((character) => normalizeText(character.name)))
  const stateLines = Array.from(stateByKey.entries())
    .filter(([key]) => {
      if (!relevantNames.size) return true
      const character = key.slice(0, key.indexOf('\u0000'))
      return relevantNames.has(normalizeText(character))
        || Array.from(relevantNames).some((name) => normalizeText(character).includes(name) || name.includes(normalizeText(character)))
    })
    .map(([key, state]) => `${key.slice(0, key.indexOf('\u0000'))}（${key.slice(key.indexOf('\u0000') + 1)}）：${state}`)

  const openForeshadowings = Array.from(collectOpenForeshadowings(scenes.map((scene) => scene.notes)).values())
    .map((foreshadowing) => `[${foreshadowing.id}] ${foreshadowing.text}`)

  return [
    stateLines.length ? `人物当前状态：\n${stateLines.join('\n')}` : '',
    openForeshadowings.length ? `未回收伏笔（仅可按 ID 核销）：${openForeshadowings.join('；')}` : '',
  ].filter(Boolean).join('\n\n')
}

function buildTimeline(scenes: StoredScene[], entryLimit = 30) {
  const timeline = scenes
    .map((scene) => {
      const notes = scene.notes
      if (!notes.time && !notes.location && !notes.events.length) return undefined
      return `${notes.time || '某时'}@${notes.location || '某地'}：${notes.events.join('；')}`
    })
    .filter((line): line is string => Boolean(line))
  return entryLimit > 0 ? timeline.slice(-entryLimit).join('\n') : ''
}

function buildRecentMessages(
  workspace: ProjectWorkspace,
  currentChapterId: string | undefined,
  budgetUnits: number,
  measure: ContextTextMeasure,
) {
  const lines: string[] = []
  let remaining = budgetUnits
  for (let index = workspace.messages.length - 1; index >= 0; index--) {
    const message = workspace.messages[index]
    if (message.kind === 'notice') continue
    if (message.kind === 'prose' && message.chapterId === currentChapterId) continue
    const content = message.kind === 'prose' ? message.paragraphs?.join('\n\n') ?? '' : message.text ?? message.title ?? ''
    if (!content) continue
    const contentUnits = measure(content)
    if (contentUnits > remaining) {
      if (lines.length === 0) lines.push(truncateTextToBudget(content, remaining, 'tail', measure))
      break
    }
    lines.push(content)
    remaining -= contentUnits
    if (remaining <= 0) break
  }
  return lines.reverse().join('\n\n')
}

function formatRetrievedParagraphs(
  paragraphs: readonly RetrievedParagraph[],
  chapters: ProjectWorkspace['chapters'],
) {
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]))
  return paragraphs.map((paragraph) => {
    const chapter = chapterById.get(paragraph.chapterId)
    const chapterLocation = chapter
      ? `第${chapter.order}章《${chapter.title}》`
      : `章节 ID：${paragraph.chapterId}`
    const location = `段落 ID：${paragraph.paragraphId}\n位置：${chapterLocation}，第${paragraph.paragraphIndex + 1}段`
      + (paragraph.messageId ? `，消息 ID：${paragraph.messageId}` : '')
    return `${location}\n原文：${paragraph.text}`
  })
}

function resolveRecentFeedbackContextSources(
  feedback: readonly Feedback[],
  workspace: ProjectWorkspace,
  projectParagraphs: readonly StoredParagraph[],
): FeedbackContextSource[] {
  const chapterById = new Map(workspace.chapters.map((chapter) => [chapter.id, chapter]))
  const messageById = new Map(
    workspace.messages
      .filter((message) => message.projectId === workspace.project.id && message.kind === 'prose')
      .map((message) => [message.id, message]),
  )
  const paragraphById = new Map(projectParagraphs.map((paragraph) => [paragraph.id, paragraph]))
  const messageIdsWithParagraphFeedback = new Set(
    feedback.filter((item) => item.scope === 'paragraph').map((item) => item.messageId),
  )

  return feedback.flatMap((item) => {
    if (item.projectId !== workspace.project.id) return []
    const chapter = chapterById.get(item.chapterId)
    const message = messageById.get(item.messageId)
    if (!chapter || !message || message.chapterId !== item.chapterId) return []

    if (item.scope === 'message') {
      const sourceText = message.paragraphs?.filter((paragraph) => Boolean(paragraph?.trim())).join('\n\n')
        || message.text?.trim()
        || ''
      if (!sourceText) return []
      return [{
        feedback: item,
        chapterOrder: chapter.order,
        chapterTitle: chapter.title,
        sourceText,
        fingerprint: hashText(sourceText),
        messageHasParagraphFeedback: messageIdsWithParagraphFeedback.has(item.messageId),
      }]
    }

    const paragraph = item.paragraphId ? paragraphById.get(item.paragraphId) : undefined
    if (
      !paragraph
      || paragraph.projectId !== workspace.project.id
      || paragraph.sourceType !== 'message'
      || paragraph.messageId !== item.messageId
      || paragraph.chapterId !== item.chapterId
      || (item.paragraphIndex !== undefined && paragraph.index !== item.paragraphIndex)
      || (item.paragraphFingerprint !== undefined && paragraph.fingerprint !== item.paragraphFingerprint)
      || !paragraph.text.trim()
    ) return []

    return [{
      feedback: item,
      chapterOrder: chapter.order,
      chapterTitle: chapter.title,
      sourceText: paragraph.text,
      fingerprint: paragraph.fingerprint,
      paragraphIndex: paragraph.index,
      messageHasParagraphFeedback: true,
    }]
  })
}

function buildParagraphRetrievalQuery(workspace: ProjectWorkspace, scenes: StoredScene[], userRequest: string) {
  const chapter = workspace.chapters.find((item) => item.id === workspace.project.activeChapterId) ?? workspace.chapters[0]
  const latestScene = scenes.at(-1)
  const entities = latestScene
    ? [latestScene.notes.povCharacter, latestScene.notes.location, ...latestScene.notes.charactersPresent]
    : []
  return [userRequest, chapter?.title, ...entities]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n')
}

function contentToString(content: unknown) {
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

interface PreparedWritingTurnContext {
  initialPlan: ContextBudgetPlan
  finalPlan: ContextBudgetPlan
  contextMessage: string
  rulesTruncated: boolean
}

/**
 * Builds the exact context payload and token plan used by a writing turn.
 * Preview callers deliberately use this same path so retrieval, trimming and
 * serialized-context accounting cannot drift from the eventual request.
 */
async function prepareWritingTurnContext(
  workspace: ProjectWorkspace,
  userRequest: string,
  config: ProviderConfig,
  options: GenerateWritingTurnOptions,
  enforceInitialCapacity = false,
): Promise<PreparedWritingTurnContext> {
  const contextBudget = workspace.project.contextBudget ?? 'standard'
  const estimator = resolveTokenEstimator({ protocol: config.protocol, providerId: config.id, model: config.model })
  const initialPlan = contextPlanForRequest(config, contextBudget, userRequest, estimator)

  const [scenes, paragraphs, recentFeedback, projectParagraphs] = await Promise.all([
    loadProjectScenes(workspace.project.id),
    listRetrievableProjectParagraphs(workspace.project.id),
    // Feedback is supplementary preference context. A workspace can briefly
    // outlive a deleted project during UI refresh, so preserve the writing
    // path with an empty feedback section rather than failing the whole turn.
    listRecentProjectFeedback(workspace.project.id, 8).catch(() => []),
    listProjectParagraphs(workspace.project.id),
  ])
  const feedbackSources = resolveRecentFeedbackContextSources(recentFeedback, workspace, projectParagraphs)
  const retrievedParagraphs = await (options.retriever ?? defaultParagraphRetriever).retrieve({
    query: buildParagraphRetrievalQuery(workspace, scenes, userRequest),
    paragraphs,
    topK: CONTEXT_COMPRESSION_PROFILES.normal.retrievalTopK,
  })
  // Measure the rich, untrimmed normal context before deciding which material
  // to tighten. This is intentionally based on tokenizer output, never text
  // length or the already-trimmed final payload.
  const rawContext = buildUntrimmedProjectContextForDemand(
    workspace,
    scenes,
    userRequest,
    estimator,
    retrievedParagraphs,
    feedbackSources,
  )
  const contextDemandTokens = estimatedTokenCount(estimator, `当前作品资料：${rawContext.context}`)
  const compressionStage = contextCompressionStageForPressure(
    contextPressureRatioForDemand(contextDemandTokens, initialPlan.contextContentBudgetTokens),
  )
  const { context, rulesTruncated, contextSections } = buildProjectContextForTokenBudget(
    workspace,
    scenes,
    initialPlan.contextContentBudgetTokens,
    userRequest,
    estimator,
    retrievedParagraphs,
    { compressionStage, feedbackSources },
  )
  const contextMessage = `当前作品资料：${context}`
  const finalPlan = buildContextBudgetPlan({
    windowTokens: initialPlan.windowTokens,
    contextBudget,
    outputReserveTokens: initialPlan.outputReserveTokens,
    safetyMarginTokens: initialPlan.safetyMarginTokens,
    systemPrompt: SYSTEM_PROMPT,
    projectWorkspace: contextSections.projectWorkspace,
    coreMemory: contextSections.coreMemory,
    timelineRetrievedContext: contextSections.timelineRetrievedContext,
    recentMessages: contextSections.recentMessages,
    feedback: contextSections.feedback,
    userMessage: userRequest,
    serializedContext: contextMessage,
    contextDemandTokens,
    contextRetainedTokens: estimatedTokenCount(estimator, contextMessage),
    estimator,
  })

  if (enforceInitialCapacity) assertContextCapacity(finalPlan)

  return { initialPlan, finalPlan, contextMessage, rulesTruncated }
}

/**
 * Produces the real writing-turn budget without sending a provider request.
 * It shares retrieval, context trimming and final serialization with
 * generateWritingTurn so UI feedback is representative of the sent turn.
 */
export async function previewWritingTurnBudget(
  workspace: ProjectWorkspace,
  userRequest: string,
  config: ProviderConfig,
  options: GenerateWritingTurnOptions = {},
): Promise<ContextBudgetPlan> {
  if (!config.model.trim()) throw new Error('请先选择文本模型')
  const prepared = await prepareWritingTurnContext(workspace, userRequest, config, options)
  return prepared.finalPlan
}

export async function generateWritingTurn(
  workspace: ProjectWorkspace,
  userRequest: string,
  config: ProviderConfig,
  transport: HttpTransport,
  onDelta?: (delta: string) => void,
  options: GenerateWritingTurnOptions = {},
) {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl) throw new Error('请先配置文本模型的 API URL')
  if (!config.model.trim()) throw new Error('请先选择文本模型')

  const prepared = await prepareWritingTurnContext(workspace, userRequest, config, options, true)
  if (prepared.rulesTruncated) {
    throw new Error('长期创作设定超过核心预算，本轮已阻止生成。请在“长期创作设定”中精简核心规则，或将完整设定拆成按场景加载的分类章节。')
  }
  if (prepared.finalPlan.isOverLimit) {
    throw new Error('最终请求的输入仍超过模型上下文窗口（真实 token 硬校验未通过），请缩短本条输入或改用更大窗口的模型。')
  }

  const body = JSON.stringify({
    model: config.model,
    stream: true,
    ...outputTokenParameter(config, prepared.initialPlan.outputReserveTokens),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: prepared.contextMessage },
      { role: 'user', content: userRequest },
    ],
  })

  const request = {
    url: `${baseUrl}/chat/completions`,
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    auth: { kind: 'bearer' as const, secretRef: config.secretRef },
    timeoutMs: 120_000,
    body,
    androidTransport: config.androidStreamingEnabled ? 'webview-stream' as const : 'native' as const,
  }

  let content: string
  if (onDelta) {
    content = await transport.stream(request, onDelta)
  } else {
    const response = await transport.request<ChatCompletionResponse>(request)
    content = contentToString(response.data.choices?.[0]?.message?.content)
  }

  if (!content.trim()) throw new Error('文本模型没有返回内容')
  return parseWritingResult(content)
}
