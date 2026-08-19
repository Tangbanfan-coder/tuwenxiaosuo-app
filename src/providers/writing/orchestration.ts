import { resolveIllustrationMode, type ProjectWorkspace } from '../../domain/models'
import {
  listRecentPreferenceSignals,
  listRetrievableProjectParagraphs,
  loadProjectScenes,
} from '../../data/storyDatabase'
import type { HttpTransport, ProviderConfig } from '../types'
import { normalizeBaseUrl } from '../openAiCompatible'
import { resolveCapabilities, resolveWritingStructuredOutput } from '../providerCapabilities'
import { buildChatCompletionPayload, extractTextResponse, resolveTextTransport } from '../chatCompatibility'
import { BigramBm25Retriever, type Retriever } from '../retriever'
import { assertContextCapacity, type ContextBudgetPlan } from './budget'
import { buildParagraphRetrievalQuery, CONTEXT_COMPRESSION_PROFILES } from './context'
import { systemPromptForIllustrationMode } from './prompt'
import { parseWritingResult, writingResponseFormatForIllustrationMode } from './result'
import { retrieveStyleExamples } from './styleCorpus'
import { computeWritingTurnContext } from './writingTurnContext'
import { sendPrepareToWorker } from './writingTurnWorker'

const defaultParagraphRetriever = new BigramBm25Retriever()

/** Lets a future semantic retriever replace BM25 without changing prompt data. */
export interface GenerateWritingTurnOptions {
  retriever?: Retriever
  /** Receives the exact final plan prepared for this real writing request. */
  onContextPlan?: (plan: ContextBudgetPlan) => void
  /** Selected examples are reported for durable usage accounting after persistence succeeds. */
  onStyleFragmentsSelected?: (fragmentIds: string[]) => void
  /** Caller-provided cancellation for the underlying stream request. */
  signal?: AbortSignal
  /** The user message that started this turn; excluded from recent-message context so a retry does not inject the requirement twice. */
  excludeUserMessageId?: string
  /** Excludes the replaced turn from both timeline facts and paragraph retrieval. */
  regeneration?: {
    turnId: string
    proseMessageId: string
    chapterId: string
    baseParagraphCount: number
  }
}

interface PreparedWritingTurnContext {
  initialPlan: ContextBudgetPlan
  finalPlan: ContextBudgetPlan
  contextMessage: string
  rulesTruncated: boolean
  styleFragmentIds: string[]
}

function buildWritingPayload(
  workspace: ProjectWorkspace,
  userRequest: string,
  config: ProviderConfig,
  prepared: PreparedWritingTurnContext,
  stream: boolean,
  forceNonStream = false,
) {
  const configuredOutput = config.manualMaxOutputTokens ?? config.maxOutputTokens
  const illustrationMode = resolveIllustrationMode(workspace.project)
  const responseFormat = writingResponseFormatForIllustrationMode(illustrationMode, resolveWritingStructuredOutput(config))
  return buildChatCompletionPayload(config, {
    model: config.model,
    stream,
    forceNonStream,
    reasoningEffort: config.reasoningEffort,
    maxOutputTokens: configuredOutput ? prepared.initialPlan.outputReserveTokens : undefined,
    extra: {
      ...(responseFormat ? { response_format: responseFormat } : {}),
    },
    messages: [
      { role: 'system', content: systemPromptForIllustrationMode(illustrationMode) },
      { role: 'system', content: prepared.contextMessage },
      { role: 'user', content: userRequest },
    ],
  })
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
  const [storedScenes, storedParagraphs, preferenceSignals, styleExamples] = await Promise.all([
    loadProjectScenes(workspace.project.id),
    listRetrievableProjectParagraphs(workspace.project.id),
    // Only abstracted signals may reach the writing request. Feedback targets
    // themselves remain local UI/statistics records and never leak old prose.
    listRecentPreferenceSignals(workspace.project.id, 8).catch(() => []),
    retrieveStyleExamples(workspace, userRequest).catch(() => []),
  ])
  const scenes = options.regeneration
    ? storedScenes.filter((scene) => scene.turnId !== options.regeneration?.turnId)
    : storedScenes
  const paragraphs = options.regeneration
    ? storedParagraphs.filter((paragraph) => (
      paragraph.messageId !== options.regeneration?.proseMessageId
      && !(
        paragraph.sourceType === 'chapter'
        && paragraph.chapterId === options.regeneration?.chapterId
        && paragraph.index >= options.regeneration.baseParagraphCount
      )
    ))
    : storedParagraphs
  const retrievedParagraphs = await (options.retriever ?? defaultParagraphRetriever).retrieve({
    query: buildParagraphRetrievalQuery(workspace, scenes, userRequest),
    paragraphs,
    topK: CONTEXT_COMPRESSION_PROFILES.normal.retrievalTopK,
  })
  const input = {
    workspace,
    scenes,
    retrievedParagraphs,
    preferenceSignals,
    styleCorpusFragments: styleExamples.map((item) => item.fragment),
    config,
    userRequest,
    excludeUserMessageId: options.excludeUserMessageId,
  }
  // Prefer the worker so the tokenizer-bound computation stays off the main
  // thread. Falls back to in-thread computeWritingTurnContext when the worker
  // is unavailable (capability miss) or crashes mid-request (rebuilt next call).
  try {
    const workerResult = await sendPrepareToWorker(input)
    if (workerResult) return workerResult
  } catch {
    // Transient worker failure: this request falls back to main thread.
    // Worker instance is rebuilt on next call; capability is NOT downgraded.
  }
  return computeWritingTurnContext(input)
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
  const body = JSON.stringify(buildWritingPayload(workspace, userRequest, config, prepared, stream))

  const request = {
    url: `${baseUrl}/chat/completions`,
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    auth: { kind: 'bearer' as const, secretRef: config.secretRef },
    timeoutMs: 120_000,
    body,
    androidTransport: transportDecision.androidTransport,
    signal: options.signal,
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
  return {
    endpoint: `${baseUrl}/chat/completions`,
    // Android background must stay non-streaming even when the provider's
    // stream capability is enabled; the foreground service sends this body
    // over a native non-streaming request.
    body: JSON.stringify(buildWritingPayload(workspace, userRequest, config, prepared, false, true)),
  }
}

export function parseBackgroundWritingResponse(rawResponse: string) {
  let response: unknown
  try { response = JSON.parse(rawResponse) } catch { throw new Error('文本模型返回格式无效') }
  const content = extractTextResponse(response)
  if (!content.trim()) throw new Error('文本模型没有返回内容')
  return parseWritingResult(content)
}
