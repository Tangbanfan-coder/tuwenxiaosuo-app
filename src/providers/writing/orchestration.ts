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
import { resolveCapabilities } from '../providerCapabilities'
import { buildChatCompletionPayload, extractTextResponse, resolveTextTransport } from '../chatCompatibility'
import { BigramBm25Retriever, type Retriever } from '../retriever'
import {
  assertContextCapacity,
  buildContextBudgetPlan,
  contextCompressionStageForPressure,
  contextPlanForRequest,
  contextPressureRatioForDemand,
  estimatedTokenCount,
  type ContextBudgetPlan,
} from './budget'
import {
  buildParagraphRetrievalQuery,
  CONTEXT_COMPRESSION_PROFILES,
  buildProjectContextForTokenBudget,
  buildUntrimmedProjectContextForDemand,
  resolveRecentFeedbackContextSources,
} from './context'
import { SYSTEM_PROMPT } from './prompt'
import { parseWritingResult } from './result'
import { retrieveStyleExamples } from './styleCorpus'

const defaultParagraphRetriever = new BigramBm25Retriever()

/** Lets a future semantic retriever replace BM25 without changing prompt data. */
export interface GenerateWritingTurnOptions {
  retriever?: Retriever
  /** Receives the exact final plan prepared for this real writing request. */
  onContextPlan?: (plan: ContextBudgetPlan) => void
  /** Selected examples are reported for durable usage accounting after persistence succeeds. */
  onStyleFragmentsSelected?: (fragmentIds: string[]) => void
}

interface PreparedWritingTurnContext {
  initialPlan: ContextBudgetPlan
  finalPlan: ContextBudgetPlan
  contextMessage: string
  rulesTruncated: boolean
  styleFragmentIds: string[]
}

/**
 * Builds the exact context payload and token plan used by a writing turn.
 * The request path owns this work so retrieval, trimming and serialized
 * context accounting cannot drift from the eventual provider request.
 */
async function prepareWritingTurnContext(
  workspace: ProjectWorkspace,
  userRequest: string,
  config: ProviderConfig,
  options: GenerateWritingTurnOptions,
): Promise<PreparedWritingTurnContext> {
  const contextBudget = workspace.project.contextBudget ?? 'standard'
  const estimator = resolveTokenEstimator({ protocol: config.protocol, providerId: config.id, model: config.model, tokenizerStrategy: resolveCapabilities(config).tokenizerStrategy })
  const initialPlan = contextPlanForRequest(config, contextBudget, userRequest, estimator)

  const [scenes, paragraphs, recentFeedback, projectParagraphs, styleExamples] = await Promise.all([
    loadProjectScenes(workspace.project.id),
    listRetrievableProjectParagraphs(workspace.project.id),
    // Feedback is supplementary preference context. A workspace can briefly
    // outlive a deleted project during UI refresh, so preserve the writing
    // path with an empty feedback section rather than failing the whole turn.
    listRecentProjectFeedback(workspace.project.id, 8).catch(() => []),
    listProjectParagraphs(workspace.project.id),
    retrieveStyleExamples(workspace, userRequest).catch(() => []),
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
    styleExamples.map((item) => item.fragment),
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
    { compressionStage, feedbackSources, styleCorpusFragments: styleExamples.map((item) => item.fragment) },
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

  return { initialPlan, finalPlan, contextMessage, rulesTruncated, styleFragmentIds: styleExamples.map((item) => item.fragment.id) }
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

  const prepared = await prepareWritingTurnContext(workspace, userRequest, config, options)
  options.onContextPlan?.(prepared.finalPlan)
  assertContextCapacity(prepared.finalPlan)
  if (prepared.rulesTruncated) {
    throw new Error('局部创作设定超过核心预算，本轮已阻止生成。请在“局部创作设定”中精简核心规则，或将完整设定拆成按场景加载的分类章节。')
  }
  if (prepared.finalPlan.isOverLimit) {
    throw new Error('最终请求的输入仍超过模型上下文窗口（本地估算 token 校验未通过，估算可能与模型真实分词存在偏差），请缩短本条输入或改用更大窗口的模型。')
  }
  options.onStyleFragmentsSelected?.(prepared.styleFragmentIds)

  // One decision drives both the body stream field and the actual transport
  // method, so a stream body is always consumed by a stream() transport and a
  // non-stream body by request() — never mismatched.
  const transportDecision = resolveTextTransport(config, {
    transportMethod: onDelta ? 'stream' : 'request',
    androidTransport: config.androidStreamingEnabled ? 'webview-stream' : 'native',
  })
  const stream = transportDecision.transportMethod === 'stream'
  const configuredOutput = config.manualMaxOutputTokens ?? config.maxOutputTokens
  const body = JSON.stringify(buildChatCompletionPayload(config, {
    model: config.model,
    stream,
    reasoningEffort: config.reasoningEffort,
    maxOutputTokens: configuredOutput ? prepared.initialPlan.outputReserveTokens : undefined,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: prepared.contextMessage },
      { role: 'user', content: userRequest },
    ],
  }))

  const request = {
    url: `${baseUrl}/chat/completions`,
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    auth: { kind: 'bearer' as const, secretRef: config.secretRef },
    timeoutMs: 120_000,
    body,
    androidTransport: transportDecision.androidTransport,
  }

  let content: string
  if (stream) {
    content = await transport.stream(request, onDelta)
  } else {
    const response = await transport.request<unknown>(request)
    content = extractTextResponse(response.data)
  }

  if (!content.trim()) throw new Error('文本模型没有返回内容')
  return parseWritingResult(content)
}

/** Builds the same validated OpenAI-compatible request but keeps it non-streaming for Android foreground service execution. */
export async function prepareBackgroundWritingRequest(
  workspace: ProjectWorkspace,
  userRequest: string,
  config: ProviderConfig,
  options: GenerateWritingTurnOptions = {},
) {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl) throw new Error('请先配置文本模型的 API URL')
  if (!config.model.trim()) throw new Error('请先选择文本模型')
  const prepared = await prepareWritingTurnContext(workspace, userRequest, config, options)
  options.onContextPlan?.(prepared.finalPlan)
  assertContextCapacity(prepared.finalPlan)
  if (prepared.rulesTruncated) throw new Error('局部创作设定超过核心预算，本轮已阻止生成。请在“局部创作设定”中精简核心规则，或将完整设定拆成按场景加载的分类章节。')
  if (prepared.finalPlan.isOverLimit) throw new Error('最终请求的输入仍超过模型上下文窗口（本地估算 token 校验未通过，估算可能与模型真实分词存在偏差），请缩短本条输入或改用更大窗口的模型。')
  options.onStyleFragmentsSelected?.(prepared.styleFragmentIds)
  const configuredOutput = config.manualMaxOutputTokens ?? config.maxOutputTokens
  return {
    endpoint: `${baseUrl}/chat/completions`,
    body: JSON.stringify(buildChatCompletionPayload(config, {
      model: config.model,
      // Android background must stay non-streaming even when the provider's
      // stream capability is enabled; the foreground service sends this body
      // over a native non-streaming request.
      stream: false,
      forceNonStream: true,
      reasoningEffort: config.reasoningEffort,
      maxOutputTokens: configuredOutput ? prepared.initialPlan.outputReserveTokens : undefined,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: prepared.contextMessage },
        { role: 'user', content: userRequest },
      ],
    })),
  }
}

export function parseBackgroundWritingResponse(rawResponse: string) {
  let response: unknown
  try { response = JSON.parse(rawResponse) } catch { throw new Error('文本模型返回格式无效') }
  const content = extractTextResponse(response)
  if (!content.trim()) throw new Error('文本模型没有返回内容')
  return parseWritingResult(content)
}
