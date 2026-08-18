import type {
  ImageEdits,
  OutputTokenParameter,
  ProviderCapabilities,
  ProviderConfig,
  ReasoningEffortParameter,
  TextTransport,
  TokenizerStrategy,
  StructuredOutput,
  VisionInput,
} from './types'

/**
 * Single authority for provider capability resolution. Call sites read the
 * resolved result only; they never re-implement per-field decisions.
 */

export type CompatibilityPreset = 'automatic' | 'openai-official' | 'strict-relay' | 'custom'

export interface ResolvedCapabilities {
  reasoningEffortParameter: ReasoningEffortParameter
  outputTokenParameter: OutputTokenParameter
  textTransport: TextTransport
  visionInput: VisionInput
  imageEdits: ImageEdits
  maxReferenceImages?: number
  imageSizes?: string[]
  portraitSize?: string
  sceneSize?: string
  tokenizerStrategy: TokenizerStrategy
  structuredOutput: StructuredOutput
}

export const DEFAULT_RESOLVED_CAPABILITIES: ResolvedCapabilities = {
  reasoningEffortParameter: 'auto',
  outputTokenParameter: 'auto',
  textTransport: 'auto',
  visionInput: 'auto',
  imageEdits: 'auto',
  tokenizerStrategy: 'auto',
  structuredOutput: 'auto',
}

/**
 * Resolves a config's optional capabilities to a complete set. Absent fields
 * resolve to 'auto' so a legacy config (no capabilities at all) keeps exactly
 * the previous behavior. Parsing of responses always probes every supported
 * layout, so there is no responseFormat capability.
 */
export function resolveCapabilities(config: Pick<ProviderConfig, 'capabilities'>): ResolvedCapabilities {
  const c = config.capabilities
  return {
    reasoningEffortParameter: c?.reasoningEffortParameter ?? 'auto',
    outputTokenParameter: c?.outputTokenParameter ?? 'auto',
    textTransport: c?.textTransport ?? 'auto',
    visionInput: c?.visionInput ?? 'auto',
    imageEdits: c?.imageEdits ?? 'auto',
    maxReferenceImages: typeof c?.maxReferenceImages === 'number' && c.maxReferenceImages >= 0 ? c.maxReferenceImages : undefined,
    imageSizes: Array.isArray(c?.imageSizes) ? c.imageSizes.filter((size): size is string => typeof size === 'string') : undefined,
    portraitSize: typeof c?.portraitSize === 'string' ? c.portraitSize : undefined,
    sceneSize: typeof c?.sceneSize === 'string' ? c.sceneSize : undefined,
    tokenizerStrategy: c?.tokenizerStrategy ?? 'auto',
    structuredOutput: c?.structuredOutput === 'json_schema' || c?.structuredOutput === 'json_object' || c?.structuredOutput === 'prompt_only'
      ? c.structuredOutput
      : 'auto',
  }
}

/**
 * Resolves the structured-output strategy used only by the primary writing
 * turn. `auto` deliberately chooses JSON Object: it is accepted by more
 * OpenAI-compatible relays than JSON Schema while still enforcing JSON.
 */
export function resolveWritingStructuredOutput(config: Pick<ProviderConfig, 'capabilities'>): Exclude<StructuredOutput, 'auto'> {
  const strategy = resolveCapabilities(config).structuredOutput
  if (strategy !== 'auto') return strategy

  // Preserve the effective behavior promised by legacy named presets. Older
  // saved configs predate structuredOutput, but their remaining capability
  // fields still identify the official or strict-relay preset.
  const legacyPreset = presetForCapabilities(config.capabilities)
  if (legacyPreset === 'openai-official') return 'json_schema'
  if (legacyPreset === 'strict-relay') return 'prompt_only'
  return 'json_object'
}

function presetCapabilitiesObject(preset: CompatibilityPreset): ProviderCapabilities {
  switch (preset) {
    case 'openai-official':
      return {
        reasoningEffortParameter: 'supported',
        outputTokenParameter: 'auto',
        textTransport: 'stream',
        visionInput: 'supported',
        imageEdits: 'supported',
        tokenizerStrategy: 'o200k_base',
        structuredOutput: 'json_schema',
      }
    case 'strict-relay':
      return {
        reasoningEffortParameter: 'unsupported',
        outputTokenParameter: 'none',
        textTransport: 'non-stream',
        visionInput: 'unsupported',
        imageEdits: 'unsupported',
        tokenizerStrategy: 'conservative',
        structuredOutput: 'prompt_only',
      }
    case 'custom':
      // The UI drives each field; an empty object means "everything auto".
      return {}
    case 'automatic':
    default:
      // Legacy behavior: every field resolves to 'auto'.
      return {}
  }
}

function stringArraysEqual(left: string[] | undefined, right: string[] | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function capabilitiesEqual(left: ProviderCapabilities | undefined, right: ProviderCapabilities | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return (
    (left.reasoningEffortParameter ?? 'auto') === (right.reasoningEffortParameter ?? 'auto')
    && (left.outputTokenParameter ?? 'auto') === (right.outputTokenParameter ?? 'auto')
    && (left.textTransport ?? 'auto') === (right.textTransport ?? 'auto')
    && (left.visionInput ?? 'auto') === (right.visionInput ?? 'auto')
    && (left.imageEdits ?? 'auto') === (right.imageEdits ?? 'auto')
    && (left.maxReferenceImages ?? undefined) === (right.maxReferenceImages ?? undefined)
    && stringArraysEqual(left.imageSizes, right.imageSizes)
    && (left.portraitSize ?? undefined) === (right.portraitSize ?? undefined)
    && (left.sceneSize ?? undefined) === (right.sceneSize ?? undefined)
    && (left.tokenizerStrategy ?? 'auto') === (right.tokenizerStrategy ?? 'auto')
    && (left.structuredOutput ?? 'auto') === (right.structuredOutput ?? 'auto')
  )
}

/**
 * Maps a stored capabilities object back to the preset that produced it.
 * Anything not matching a preset is 'custom'. Legacy (absent) maps to
 * 'automatic'.
 */
export function presetForCapabilities(capabilities?: ProviderCapabilities): CompatibilityPreset {
  // Absent capabilities are the legacy layout and mean "everything auto".
  const normalized = capabilities ?? {}
  for (const preset of ['automatic', 'openai-official', 'strict-relay'] as const) {
    if (capabilitiesEqual(normalized, presetCapabilitiesObject(preset))) return preset
    // Configurations saved before structured output was introduced retain the
    // known preset identity, rather than unexpectedly appearing as custom.
    const presetCapabilities = presetCapabilitiesObject(preset)
    if (preset !== 'automatic' && capabilities?.structuredOutput === undefined && capabilitiesEqual(
      { ...normalized, structuredOutput: presetCapabilities.structuredOutput },
      presetCapabilities,
    )) return preset
  }
  return 'custom'
}

/**
 * Produces the capabilities object for a preset. Picking a preset replaces the
 * stored capabilities entirely; the UI then edits the object for 'custom'.
 */
export function capabilitiesForPreset(preset: CompatibilityPreset): ProviderCapabilities {
  return presetCapabilitiesObject(preset)
}
