import { Tiktoken } from 'js-tiktoken/lite'
import o200kBase from 'js-tiktoken/ranks/o200k_base'

/**
 * Minimal synchronous token-counting contract. Callers that need provenance
 * should keep the accompanying ResolvedTokenEstimator rather than extending
 * this interface with provider-specific details.
 */
export interface TokenEstimator {
  estimate(text: string): number
}

export type TokenEstimatorSource = 'o200k_base' | 'chars-per-token' | 'conservative' | 'custom'

export interface TokenEstimatorMetadata {
  source: TokenEstimatorSource
  /** True only when the legacy character heuristic is being used. */
  isFallback: boolean
}

export interface ResolvedTokenEstimator extends TokenEstimatorMetadata {
  estimator: TokenEstimator
}

/**
 * Kept public so a future non-OpenAI-compatible provider can register a
 * tokenizer without changing writing-budget callers.
 */
export interface TokenEstimatorContext {
  protocol?: string
  providerId?: string
  model?: string
  /** Provider capability: 'conservative' over-estimates, 'o200k_base' forces o200k. */
  tokenizerStrategy?: 'auto' | 'o200k_base' | 'conservative'
}

export type TokenEstimatorFactory = (context: TokenEstimatorContext) => ResolvedTokenEstimator
export type TokenEstimatorMatcher = (context: TokenEstimatorContext) => boolean

interface TokenEncoder {
  encode(text: string): ArrayLike<number>
}

export interface OpenAiCompatibleTokenEstimatorOptions {
  /** Primarily useful for a host-specific tokenizer adapter or failure tests. */
  createEncoder?: () => TokenEncoder
}

export const FALLBACK_CHARS_PER_TOKEN = 1.2

let sharedO200kEncoder: TokenEncoder | undefined
let sharedO200kEncoderError: unknown
const registeredFactories: Array<{ matcher: TokenEstimatorMatcher; factory: TokenEstimatorFactory }> = []

function fallbackTokenCount(text: string) {
  return text ? Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN) : 0
}

function defaultO200kEncoder(): TokenEncoder {
  if (sharedO200kEncoder) return sharedO200kEncoder
  if (sharedO200kEncoderError) throw sharedO200kEncoderError
  try {
    sharedO200kEncoder = new Tiktoken(o200kBase)
    return sharedO200kEncoder
  } catch (error) {
    sharedO200kEncoderError = error
    throw error
  }
}

export function createFallbackTokenEstimator(): ResolvedTokenEstimator {
  return {
    estimator: { estimate: fallbackTokenCount },
    source: 'chars-per-token',
    isFallback: true,
  }
}

/**
 * Conservative char-based upper bound, used when a provider declares
 * tokenizerStrategy 'conservative' (e.g. strict relays whose real tokenizer
 * is unknown). Source of the coefficient: for Chinese text o200k_base
 * typically measures 0.6-1.2 tokens per character; 1.5 tokens/char is a
 * deliberate, testable upper bound that leaves margin instead of guessing.
 */
export const CONSERVATIVE_TOKENS_PER_CHAR = 1.5

export function createConservativeTokenEstimator(): ResolvedTokenEstimator {
  return {
    estimator: {
      estimate(text: string) {
        return text ? Math.ceil(text.length * CONSERVATIVE_TOKENS_PER_CHAR) : 0
      },
    },
    source: 'conservative',
    isFallback: false,
  }
}

/**
 * OpenAI-compatible APIs expose diverse model families, but their token usage
 * is consistently best approximated by o200k_base until a provider-specific
 * tokenizer is registered. The adapter remains synchronous for browser use.
 */
export function createOpenAiCompatibleTokenEstimator(
  options: OpenAiCompatibleTokenEstimatorOptions = {},
): ResolvedTokenEstimator {
  const fallback = createFallbackTokenEstimator()
  let encoder: TokenEncoder
  try {
    encoder = (options.createEncoder ?? defaultO200kEncoder)()
  } catch {
    return fallback
  }

  let fellBackDuringEstimate = false
  const resolved: ResolvedTokenEstimator = {
    estimator: {
      estimate(text: string) {
        try {
          const tokenCount = encoder.encode(text).length
          if (!Number.isFinite(tokenCount) || tokenCount < 0) throw new Error('Tokenizer returned an invalid token count')
          return tokenCount
        } catch {
          fellBackDuringEstimate = true
          return fallback.estimator.estimate(text)
        }
      },
    },
    get source() {
      return fellBackDuringEstimate ? fallback.source : 'o200k_base'
    },
    get isFallback() {
      return fellBackDuringEstimate
    },
  }
  return resolved
}

/** Register a more precise tokenizer for a future provider/model family. */
export function registerTokenEstimator(matcher: TokenEstimatorMatcher, factory: TokenEstimatorFactory) {
  const registration = { matcher, factory }
  registeredFactories.unshift(registration)
  return () => {
    const index = registeredFactories.indexOf(registration)
    if (index >= 0) registeredFactories.splice(index, 1)
  }
}

/**
 * Resolve a tokenizer once per request/preview so the same estimator can be
 * shared by UI budget previews and request assembly.
 */
export function resolveTokenEstimator(context: TokenEstimatorContext = {}): ResolvedTokenEstimator {
  for (const { matcher, factory } of registeredFactories) {
    try {
      if (matcher(context)) return factory(context)
    } catch {
      // A custom adapter must never prevent the legacy fallback from keeping a request safe.
      return createFallbackTokenEstimator()
    }
  }
  if (context.tokenizerStrategy === 'conservative') return createConservativeTokenEstimator()
  if (context.protocol === 'openai-compatible') return createOpenAiCompatibleTokenEstimator()
  return createFallbackTokenEstimator()
}

/** Capture mutable fallback state after all estimates for a plan have run. */
export function tokenEstimatorMetadata(estimator: ResolvedTokenEstimator): TokenEstimatorMetadata {
  return { source: estimator.source, isFallback: estimator.isFallback }
}
