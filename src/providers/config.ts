import type { ProviderConfig, ProviderSettings, ProviderSlot } from './types'

const SETTINGS_KEY = 'illustrated-story-chat.provider-settings.v1'

export const JBB_IMAGE_PRESET: ProviderConfig = {
  id: 'jbb-image',
  name: 'JBB Image',
  baseUrl: 'https://jbbt.cc/v1',
  model: 'gpt-image-2',
  protocol: 'openai-compatible',
  secretRef: 'provider:image',
}

const DEFAULT_TEXT_PROVIDER: ProviderConfig = {
  id: 'custom-text',
  name: '自定义文本接口',
  baseUrl: '',
  model: '',
  protocol: 'openai-compatible',
  secretRef: 'provider:text',
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  text: DEFAULT_TEXT_PROVIDER,
  image: JBB_IMAGE_PRESET,
  textProviders: [DEFAULT_TEXT_PROVIDER],
  imageProviders: [JBB_IMAGE_PRESET],
}

function cloneProvider(provider: ProviderConfig): ProviderConfig {
  return { ...provider }
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<ProviderConfig>
  return typeof provider.id === 'string' && typeof provider.name === 'string' && typeof provider.baseUrl === 'string'
    && typeof provider.model === 'string' && typeof provider.secretRef === 'string'
}

function normalizeProviderList(value: unknown, active: ProviderConfig) {
  const list = Array.isArray(value) ? value.filter(isProviderConfig).map(cloneProvider) : []
  if (!list.some((provider) => provider.id === active.id)) list.unshift(cloneProvider(active))
  return list.length ? list : [cloneProvider(active)]
}

export function loadProviderSettings(): ProviderSettings {
  const raw = localStorage.getItem(SETTINGS_KEY)
  if (!raw) return {
    text: cloneProvider(DEFAULT_TEXT_PROVIDER),
    image: cloneProvider(JBB_IMAGE_PRESET),
    textProviders: [cloneProvider(DEFAULT_TEXT_PROVIDER)],
    imageProviders: [cloneProvider(JBB_IMAGE_PRESET)],
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ProviderSettings>
    const text = isProviderConfig(parsed.text) ? { ...DEFAULT_TEXT_PROVIDER, ...parsed.text } : cloneProvider(DEFAULT_TEXT_PROVIDER)
    const image = isProviderConfig(parsed.image) ? { ...JBB_IMAGE_PRESET, ...parsed.image } : cloneProvider(JBB_IMAGE_PRESET)
    return {
      text,
      image,
      textProviders: normalizeProviderList(parsed.textProviders, text),
      imageProviders: normalizeProviderList(parsed.imageProviders, image),
    }
  } catch {
    return {
      text: cloneProvider(DEFAULT_TEXT_PROVIDER),
      image: cloneProvider(JBB_IMAGE_PRESET),
      textProviders: [cloneProvider(DEFAULT_TEXT_PROVIDER)],
      imageProviders: [cloneProvider(JBB_IMAGE_PRESET)],
    }
  }
}

export function saveProviderSettings(settings: ProviderSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function applyPreset(slot: 'image', preset: 'jbb'): ProviderConfig {
  if (slot === 'image' && preset === 'jbb') return { ...JBB_IMAGE_PRESET }
  throw new Error('未知的模型预设')
}

export function createProviderConfig(slot: ProviderSlot): ProviderConfig {
  const id = crypto.randomUUID()
  return {
    id: `custom-${slot}-${id}`,
    name: slot === 'text' ? '新的文本供应商' : '新的图片供应商',
    baseUrl: '',
    model: '',
    protocol: 'openai-compatible',
    secretRef: `provider:${slot}:${id}`,
  }
}
