import type { ProviderConfig, ReasoningEffort } from './types'
import { resolveCapabilities } from './providerCapabilities'

/**
 * Unified chat-completions request construction and text response extraction.
 * All text call sites (writing, background writing, instruction structuring,
 * rewrite, style-corpus tagging, reference-image analysis) must use these
 * functions instead of assembling provider parameters or parsing
 * choices[0].message.content themselves.
 */

export type ChatMessage = { role: string; content: unknown }

export type TextTransportMethod = 'stream' | 'request'

export interface TextTransportIntent {
  /** Call-site default transport method; kept as-is when textTransport is 'auto'. */
  transportMethod: TextTransportMethod
  /** Android foreground channel for a 'stream' method (webview-stream needs CORS). */
  androidTransport: 'native' | 'webview-stream'
  /**
   * Android background foreground-service requests: the request may already
   * have been billed by the provider, so the body must stay non-streaming
   * regardless of the provider's stream capability.
   */
  forceNonStream?: boolean
}

export interface TextTransportDecision {
  transportMethod: TextTransportMethod
  androidTransport: 'native' | 'webview-stream'
}

/**
 * Single authority deciding how a writing turn is transported AND what the
 * request body's stream field must be. The body stream value is derived from
 * the chosen transport method (a stream() transport consumes SSE, a request()
   transport consumes plain JSON), never set independently.
 * Priority: forceNonStream (Android background) > textTransport capability >
 * call-site default.
 */
export function resolveTextTransport(config: Pick<ProviderConfig, 'capabilities'>, intent: TextTransportIntent): TextTransportDecision {
  if (intent.forceNonStream) return { transportMethod: 'request', androidTransport: 'native' }
  const caps = resolveCapabilities(config)
  if (caps.textTransport === 'stream') return { transportMethod: 'stream', androidTransport: 'webview-stream' }
  if (caps.textTransport === 'non-stream') return { transportMethod: 'request', androidTransport: 'native' }
  return { transportMethod: intent.transportMethod, androidTransport: intent.androidTransport }
}

export interface BuildChatCompletionPayloadInput {
  model: string
  messages: ChatMessage[]
  /** The user's explicit reasoning level; 'auto' means "not chosen". */
  reasoningEffort?: ReasoningEffort
  /**
   * Output-token value to send. undefined means "do not send an output token
   * parameter at all" (legacy: nothing configured or provider metadata absent).
   */
  maxOutputTokens?: number
  /**
   * Final stream value for the body. Call sites derive it from the transport
   * decision (see resolveTextTransport): a stream() transport sends true, a
   * request() transport sends false. Never set apart from the transport method.
   */
  stream: boolean
  /**
   * Hard non-streaming constraint from the call site: Android background
   * writing and every auxiliary text task (structure/rewrite/corpus/vision)
   * must stay non-streaming regardless of the provider's stream capability.
   * This is the explicit distinction from resolveTextTransport — a preset may
   * only choose the transport for the main foreground writing turn, never for
   * a call site that declares forceNonStream.
   */
  forceNonStream?: boolean
  /** Optional extra request fields merged after capability decisions. */
  extra?: Record<string, unknown>
}

/**
 * Infers the output-token parameter name from a model id. Only used when the
 * provider's outputTokenParameter capability is 'auto'. Handles vendor
 * prefixes (vendor/name), common date suffixes, underscore aliases and falls
 * back to max_tokens for unknown aliases.
 */
export function inferOutputTokenParameter(modelId: string): 'max_tokens' | 'max_completion_tokens' {
  const normalized = (modelId.trim().toLocaleLowerCase().split('/').pop() ?? '').replace(/_/g, '-')
  if (/^o[134](?:-|$)/.test(normalized)) return 'max_completion_tokens'
  if (/^gpt-5(?:\.|-|$)/.test(normalized)) return 'max_completion_tokens'
  return 'max_tokens'
}

/**
 * Builds the exact chat-completions JSON body. Capability decisions live here
 * only; no call site re-derives reasoning/output/stream behavior.
 */
export function buildChatCompletionPayload(config: ProviderConfig, input: BuildChatCompletionPayloadInput): Record<string, unknown> {
  const caps = resolveCapabilities(config)
  const payload: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
  }

  // The stream field mirrors the transport method already chosen by the call
  // site (via resolveTextTransport). No capability override happens here:
  // a request() transport cannot consume an SSE response, so non-streaming
  // call sites (structure/rewrite/corpus/vision) must never be flipped.
  payload.stream = input.forceNonStream ? false : input.stream

  if (caps.reasoningEffortParameter !== 'unsupported' && input.reasoningEffort && input.reasoningEffort !== 'auto') {
    payload.reasoning_effort = input.reasoningEffort
  }

  if (input.maxOutputTokens !== undefined && input.maxOutputTokens > 0) {
    const mode = caps.outputTokenParameter === 'auto'
      ? inferOutputTokenParameter(input.model)
      : caps.outputTokenParameter
    if (mode === 'max_tokens') payload.max_tokens = input.maxOutputTokens
    else if (mode === 'max_completion_tokens') payload.max_completion_tokens = input.maxOutputTokens
    // 'none' sends no output-token parameter.
  }

  return { ...payload, ...(input.extra ?? {}) }
}

/**
 * Extracts the raw text of a non-streaming content field WITHOUT trimming.
 * The returned string keeps leading/trailing whitespace and newlines; call
 * sites decide emptiness with their own trim() before parsing. Streaming
 * deltas must never lose a lone space or newline chunk.
 */
function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined
  if (!Array.isArray(content)) return undefined
  const parts = content.flatMap((part) => {
    if (part && typeof part === 'object' && 'text' in part && typeof (part as Record<string, unknown>).text === 'string') {
      return [(part as Record<string, unknown>).text as string]
    }
    return []
  })
  return parts.join('') || undefined
}

/**
 * Normalizes a non-streaming provider response into plain text. Supported
 * layouts, probed in order:
 *   1. choices[0].message.content (string or array of { text })
 *   2. top-level output_text
 *   3. top-level generated_text
 *   4. output[].content[].text (Responses-style)
 * Returns the text verbatim (whitespace preserved; trim is only used to test
 * whether a field is empty). Throws an explicit "unsupported structure" error
 * when no layout is recognized.
 */
export function extractTextResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') throw new Error('当前响应结构不受支持：接口没有返回可识别的文本内容。')
  const root = payload as Record<string, unknown>

  const choices = Array.isArray(root.choices) ? root.choices : []
  const firstChoice = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : undefined
  const message = firstChoice?.message && typeof firstChoice.message === 'object' ? firstChoice.message as Record<string, unknown> : undefined
  if (message) {
    const fromContent = textFromContent(message.content)
    if (fromContent) return fromContent
  }

  if (typeof root.output_text === 'string' && root.output_text.trim()) return root.output_text
  if (typeof root.generated_text === 'string' && root.generated_text.trim()) return root.generated_text

  const output = Array.isArray(root.output) ? root.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const rowContent = Array.isArray(row.content) ? row.content : []
    const textParts = rowContent.flatMap((part) => {
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
        return [(part as Record<string, unknown>).text as string]
      }
      return []
    })
    if (textParts.length) return textParts.join('')
  }

  throw new Error('当前响应结构不受支持：无法从接口响应中识别正文文本。请检查供应商兼容设置。')
}

/**
 * Extracts text from one streaming SSE delta payload, VERBATIM: a leading
 * space (" world"), a lone space (" ") or a newline delta must survive
 * untouched so the assembled stream equals the model output. An empty string
 * delta (no content) yields '' and is skipped by the transport.
 */
export function extractStreamingTextDelta(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const root = payload as { choices?: Array<{ delta?: { content?: unknown } }> }
  const content = root.choices?.[0]?.delta?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      if (part && typeof part === 'object' && 'text' in part && typeof (part as Record<string, unknown>).text === 'string') {
        return [(part as Record<string, unknown>).text as string]
      }
      return []
    }).join('')
  }
  return ''
}
