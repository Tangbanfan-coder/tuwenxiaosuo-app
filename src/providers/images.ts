import type { CharacterAsset, ProjectStyle } from '../domain/models'
import { resolveProjectIllustrationStyle } from '../domain/illustrationStyles'
import { normalizeBaseUrl } from './openAiCompatible'
import type { HttpTransport, ProviderConfig } from './types'

interface ImageResponse {
  data?: Array<{
    url?: unknown
    b64_json?: unknown
  }>
}

function imageSource(response: ImageResponse) {
  const image = response.data?.[0]
  if (typeof image?.url === 'string' && image.url) return image.url
  if (typeof image?.b64_json === 'string' && image.b64_json) return `data:image/png;base64,${image.b64_json}`
  throw new Error('图片模型没有返回 URL 或图片数据')
}

function assertImageConfig(config: ProviderConfig) {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl) throw new Error('请先配置图片模型的 API URL')
  if (!config.model.trim()) throw new Error('请先选择图片模型')
  return baseUrl
}

export async function generateOpenAiImage(
  config: ProviderConfig,
  prompt: string,
  transport: HttpTransport,
  size = '1024x1536',
) {
  const baseUrl = assertImageConfig(config)
  const response = await transport.request<ImageResponse>({
    url: `${baseUrl}/images/generations`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    auth: { kind: 'bearer', secretRef: config.secretRef },
    timeoutMs: 180_000,
    body: JSON.stringify({ model: config.model, prompt, size }),
  })
  return imageSource(response.data)
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
) {
  const baseUrl = assertImageConfig(config)
  if (!referenceSources.length) return generateOpenAiImage(config, prompt, transport, size)

  const form = new FormData()
  form.set('model', config.model)
  form.set('prompt', prompt)
  form.set('size', size)
  for (const [index, source] of referenceSources.entries()) {
    form.append('image', await sourceToBlob(source), `reference-${index + 1}.png`)
  }

  const response = await transport.request<ImageResponse>({
    url: `${baseUrl}/images/edits`,
    method: 'POST',
    auth: { kind: 'bearer', secretRef: config.secretRef },
    timeoutMs: 180_000,
    body: form,
  })
  return imageSource(response.data)
}

export function buildCharacterPortraitPrompt(character: CharacterAsset, style?: ProjectStyle, feedback?: string) {
  const refinement = feedback?.trim() ? `\n用户对上一版的不满意点：${feedback.trim()}。据此生成优化版本。` : ''
  const resolvedStyle = resolveProjectIllustrationStyle(style)
  const preserveReferenceStyle = character.continuity.referenceStyleMode === 'reference' && Boolean(character.continuity.referenceImageUrl)
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
