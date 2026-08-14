import type { CharacterAsset, ProjectStyle } from '../domain/models'
import { resolveProjectIllustrationStyle } from '../domain/illustrationStyles'
import { logImagePipeline } from './imagePipelineLog'
import { generateNativeImageAsset } from './imageAssetStore'
import { normalizeBaseUrl } from './openAiCompatible'
import { resolveCapabilities } from './providerCapabilities'
import type { GeneratedImageSource, HttpTransport, NativeImagePersistenceTarget, ProviderConfig, RequestAuth } from './types'

interface ImageResponse {
  data?: Array<{
    url?: unknown
    b64_json?: unknown
  }>
}

function resolveImageUrl(url: string, providerBaseUrl: string) {
  try {
    const resolved = new URL(url, providerBaseUrl)
    return { url: resolved.toString(), usesProviderAuth: resolved.origin === new URL(providerBaseUrl).origin }
  } catch {
    throw new Error('图片模型返回的图片 URL 无效')
  }
}

type ImageResponseMode = 'b64_json' | 'url' | 'empty'

function imageResponseMode(response: ImageResponse): ImageResponseMode {
  const image = response.data?.[0]
  if (typeof image?.url === 'string' && image.url) return 'url'
  if (typeof image?.b64_json === 'string' && image.b64_json) return 'b64_json'
  return 'empty'
}

function approximateBase64Bytes(value: string) {
  const normalized = value.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding)
}

export type ImageGenerationStage = 'waiting' | 'downloading'
export type ImageGenerationStageCallback = (stage: ImageGenerationStage) => void

async function generateNativelyWhenTargeted(
  baseUrl: string,
  config: ProviderConfig,
  prompt: string,
  size: string,
  target: NativeImagePersistenceTarget | undefined,
  referenceSources?: string[],
): Promise<GeneratedImageSource | undefined> {
  if (!target) return undefined
  const stored = await generateNativeImageAsset({
    endpoint: `${baseUrl}/images/${referenceSources?.length ? 'edits' : 'generations'}`,
    model: config.model,
    prompt,
    size,
    target,
    secretRef: config.secretRef,
    referenceSources,
    responseFormat: supportsB64ResponseFormat(config.model) ? 'b64_json' : undefined,
  })
  // Undefined is the explicit Web compatibility result. A native call that
  // resolves without a URI must fail here rather than repeat a billed request.
  if (!stored) return undefined
  if (!stored.localUri) throw new Error('原生图片生成未返回本地文件')
  return { kind: 'local', localUri: stored.localUri }
}

async function imageSource(
  response: ImageResponse,
  baseUrl: string,
  config: ProviderConfig,
  transport: HttpTransport,
  onStageChange?: ImageGenerationStageCallback,
): Promise<GeneratedImageSource> {
  const image = response.data?.[0]
  if (typeof image?.url === 'string' && image.url) {
    const resolved = resolveImageUrl(image.url, baseUrl)
    const usesProviderAuth = resolved.usesProviderAuth
    const auth: RequestAuth | undefined = usesProviderAuth ? { kind: 'bearer', secretRef: config.secretRef } : undefined
    onStageChange?.('downloading')
    logImagePipeline('info', { phase: 'remote-image-ready', responseMode: 'url', usesProviderAuth })
    return { kind: 'remote', url: resolved.url, auth }
  }
  if (typeof image?.b64_json === 'string' && image.b64_json) {
    logImagePipeline('info', { phase: 'response-ready', responseMode: 'b64_json', approximateBytes: approximateBase64Bytes(image.b64_json) })
    return { kind: 'inline', dataUrl: `data:image/png;base64,${image.b64_json}` }
  }
  throw new Error('图片模型没有返回 URL 或图片数据')
}

function assertImageConfig(config: ProviderConfig) {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl) throw new Error('请先配置图片模型的 API URL')
  if (!config.model.trim()) throw new Error('请先选择图片模型')
  return baseUrl
}

function supportsB64ResponseFormat(model: string) {
  // DALL-E is the only explicitly known OpenAI-compatible family here. GPT
  // Image and unknown gateways may reject this optional parameter outright.
  return /^dall-e-(?:2|3)$/i.test(model.trim())
}

export type ImageOrientation = 'portrait' | 'landscape'

function aspectOf(size: string): ImageOrientation | 'square' {
  const match = /^(\d+)x(\d+)$/.exec(size.trim())
  if (!match) return 'square'
  const width = Number(match[1])
  const height = Number(match[2])
  if (width > height) return 'landscape'
  if (width < height) return 'portrait'
  return 'square'
}

/**
 * Resolves the generation size from provider capabilities instead of call-site
 * hard-coding. Manual portraitSize/sceneSize win; otherwise the supported
 * imageSizes list is used when the default is not among them; absent config
 * keeps the legacy defaults. Never silently substitutes an incompatible size.
 */
export function resolveImageSize(config: ProviderConfig, orientation: ImageOrientation, fallback: string): string {
  const caps = resolveCapabilities(config)
  const preferred = orientation === 'portrait' ? caps.portraitSize : caps.sceneSize
  const desired = (preferred ?? fallback).trim()
  const supported = caps.imageSizes?.map((size) => size.trim()).filter(Boolean) ?? []
  if (!supported.length) return desired
  if (supported.includes(desired)) return desired
  const compatible = supported.find((size) => aspectOf(size) === orientation)
  if (compatible) return compatible
  throw new Error(`图片供应商不支持${orientation === 'portrait' ? '竖版' : '横版'}尺寸；可用尺寸：${supported.join('、')}`)
}

export async function generateOpenAiImage(
  config: ProviderConfig,
  prompt: string,
  transport: HttpTransport,
  size = '1024x1536',
  onStageChange?: ImageGenerationStageCallback,
  nativeTarget?: NativeImagePersistenceTarget,
) {
  const baseUrl = assertImageConfig(config)
  onStageChange?.('waiting')
  const nativeImage = await generateNativelyWhenTargeted(baseUrl, config, prompt, size, nativeTarget)
  if (nativeImage) return nativeImage
  const requestStartedAt = Date.now()
  const response = await transport.request<ImageResponse>({
    url: `${baseUrl}/images/generations`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    auth: { kind: 'bearer', secretRef: config.secretRef },
    timeoutMs: 300_000,
    body: JSON.stringify({
      model: config.model,
      prompt,
      size,
      ...(supportsB64ResponseFormat(config.model) ? { response_format: 'b64_json' } : {}),
    }),
  })
  logImagePipeline('info', {
    phase: 'provider-complete',
    operation: 'generation',
    model: config.model,
    durationMs: Date.now() - requestStartedAt,
    responseMode: imageResponseMode(response.data),
  })
  return imageSource(response.data, baseUrl, config, transport, onStageChange)
}

async function sourceToBlob(source: string) {
  try {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.blob()
  } catch {
    throw new Error('无法读取参考图；图片 URL 可能已失效或禁止跨域访问')
  }
}

export async function editOpenAiImage(
  config: ProviderConfig,
  prompt: string,
  referenceSources: string[],
  transport: HttpTransport,
  size = '1024x1536',
  onStageChange?: ImageGenerationStageCallback,
  nativeTarget?: NativeImagePersistenceTarget,
) {
  const baseUrl = assertImageConfig(config)
  if (!referenceSources.length) return generateOpenAiImage(config, prompt, transport, size, onStageChange, nativeTarget)

  // Capability gates run before any network request (native or Web) so a
  // billed request is never sent for an unsupported feature.
  const caps = resolveCapabilities(config)
  if (caps.imageEdits === 'unsupported') {
    throw new Error('当前图片供应商不支持参考图编辑（/images/edits）。请在图片模型设置的“兼容能力”中启用参考图编辑，或改用支持参考图的服务。')
  }
  if (caps.maxReferenceImages !== undefined && referenceSources.length > caps.maxReferenceImages) {
    throw new Error(
      `参考图数量超出该图片供应商限制：当前 ${referenceSources.length} 张，上限 ${caps.maxReferenceImages} 张。请减少参考图后重试。`,
    )
  }

  try {
    onStageChange?.('waiting')
    const nativeImage = await generateNativelyWhenTargeted(baseUrl, config, prompt, size, nativeTarget, referenceSources)
    if (nativeImage) return nativeImage
    const form = new FormData()
    form.set('model', config.model)
    form.set('prompt', prompt)
    form.set('size', size)
    if (supportsB64ResponseFormat(config.model)) form.set('response_format', 'b64_json')
    for (const [index, source] of referenceSources.entries()) {
      form.append('image', await sourceToBlob(source), `reference-${index + 1}.png`)
    }

    const requestStartedAt = Date.now()
    const response = await transport.request<ImageResponse>({
      url: `${baseUrl}/images/edits`,
      method: 'POST',
      auth: { kind: 'bearer', secretRef: config.secretRef },
      timeoutMs: 300_000,
      body: form,
    })
    logImagePipeline('info', {
      phase: 'provider-complete',
      operation: 'edit',
      model: config.model,
      referenceCount: referenceSources.length,
      durationMs: Date.now() - requestStartedAt,
      responseMode: imageResponseMode(response.data),
    })
    return imageSource(response.data, baseUrl, config, transport, onStageChange)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const status = error && typeof error === 'object'
      ? Number((error as { status?: unknown }).status ?? (error as { data?: { status?: unknown } }).data?.status)
      : undefined
    // Only endpoint-level rejection (404/405/501) is evidence that the
    // upstream lacks /images/edits. Timeout, network and other provider
    // failures are not multipart compatibility issues and must not be
    // misattributed to it.
    const unsupportedEndpoint = status === 404 || status === 405 || status === 501
      || (typeof detail === 'string' && /HTTP\s+(?:40[45]|501)\b/i.test(detail))
    if (unsupportedEndpoint) {
      throw new Error(
        `参考图生图失败：该功能依赖 OpenAI 兼容的 /images/edits multipart 接口，中转服务可能不支持。原始错误：${detail}`,
        { cause: error },
      )
    }
    throw new Error(`参考图生图失败：${detail}`, { cause: error })
  }
}

export function buildCharacterPortraitPrompt(character: CharacterAsset, style?: ProjectStyle, feedback?: string) {
  const refinement = feedback?.trim() ? `\n用户对上一版的不满意点：${feedback.trim()}。据此生成优化版本。` : ''
  const resolvedStyle = resolveProjectIllustrationStyle(style)
  const preserveReferenceStyle = character.continuity.referenceStyleMode === 'reference'
    && Boolean(character.continuity.referenceImageUrl || character.continuity.localUri)
  const styleRule = preserveReferenceStyle
    ? '保留上一张参考图自身的绘制或摄影风格，不要将角色转换为项目统一画风。'
    : resolvedStyle.visualPrompt
      ? `统一使用项目画风：${resolvedStyle.visualPrompt}`
      : ''
  const styleLine = styleRule ? `\n画风规则：${styleRule}` : ''
  return `为小说角色生成一张全新原创的定妆照。单人，正面或轻微三分之二侧面，半身到全身，背景简洁，不含文字和水印。
角色：${character.name}（${character.role}）
年龄与体型：${character.identity.ageAndBuild || '按剧情合理设计'}
必须保持的身份特征：${character.identity.fixedTraits.join('、') || '面部特征清晰且可复用'}
默认外貌：${character.appearance.defaultLook || '按剧情合理设计'}
服装：${character.appearance.wardrobe || '符合角色身份'}${styleLine}
参考图仅用于确定角色的脸型和身份特征；忽略参考图中的服装、发型之外的配饰和场景，服装严格按上方“服装”描述绘制。
避免：多人、复杂背景、画面文字、遮挡面部、角色身份漂移；${resolvedStyle.negativePrompt}${refinement}`
}
