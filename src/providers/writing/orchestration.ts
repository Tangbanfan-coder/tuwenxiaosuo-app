import type { ProjectWorkspace } from '../../domain/models'
import {
  listProjectParagraphs,
  listRecentProjectFeedback,
  listRetrievableProjectParagraphs,
  loadProjectScenes,
} from '../../data/storyDatabase'
import { resolveTokenEstimator } from '../tokenEstimator'
import type { HttpTransport, ProviderConfig } from '../types'
import { normalizeBaseUrl } from '../openAiCompatible'
import { BigramBm25Retriever, type Retriever } from '../retriever'
import {
  assertContextCapacity,
  buildContextBudgetPlan,
  contextCompressionStageForPressure,
  contextPlanForRequest,
  contextPressureRatioForDemand,
  estimatedTokenCount,
  outputTokenParameter,
  type ContextBudgetPlan,
} from './budget'
import {
  buildParagraphRetrievalQuery,
  CONTEXT_COMPRESSION_PROFILES,
  buildProjectContextForTokenBudget,
  buildUntrimmedProjectContextForDemand,
  resolveRecentFeedbackContextSources,
} from './context'
import { contentToString } from './instructions'
import { SYSTEM_PROMPT } from './prompt'
import { parseWritingResult } from './result'

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown
    }
  }>
}

const defaultParagraphRetriever = new BigramBm25Retriever()

/** Lets a future semantic retriever replace BM25 without changing prompt data. */
export interface GenerateWritingTurnOptions {
  retriever?: Retriever
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
