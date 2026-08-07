import type { ProviderConfig, ProviderSettings, ProviderSlot } from './types'

const SETTINGS_KEY = 'illustrated-story-chat.provider-settings.v1'

const DEFAULT_TEXT_PROVIDER: ProviderConfig = {
  id: 'custom-text',
  name: '自定义文本接口',
  baseUrl: '',
  model: '',
  protocol: 'openai-compatible',
  secretRef: 'provider:text',
}

const DEFAULT_IMAGE_PROVIDER: ProviderConfig = {
  id: 'custom-image',
  name: '自定义图片接口',
  baseUrl: '',
  model: '',
  protocol: 'openai-compatible',
  secretRef: 'provider:image',
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  text: DEFAULT_TEXT_PROVIDER,
  image: DEFAULT_IMAGE_PROVIDER,
  textProviders: [DEFAULT_TEXT_PROVIDER],
  imageProviders: [DEFAULT_IMAGE_PROVIDER],
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
    image: cloneProvider(DEFAULT_IMAGE_PROVIDER),
    textProviders: [cloneProvider(DEFAULT_TEXT_PROVIDER)],
    imageProviders: [cloneProvider(DEFAULT_IMAGE_PROVIDER)],
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ProviderSettings>
    const text = isProviderConfig(parsed.text) ? { ...DEFAULT_TEXT_PROVIDER, ...parsed.text } : cloneProvider(DEFAULT_TEXT_PROVIDER)
    const image = isProviderConfig(parsed.image) ? { ...DEFAULT_IMAGE_PROVIDER, ...parsed.image } : cloneProvider(DEFAULT_IMAGE_PROVIDER)
    return {
      text,
      image,
      textProviders: normalizeProviderList(parsed.textProviders, text),
      imageProviders: normalizeProviderList(parsed.imageProviders, image),
    }
  } catch {
    return {
      text: cloneProvider(DEFAULT_TEXT_PROVIDER),
      image: cloneProvider(DEFAULT_IMAGE_PROVIDER),
      textProviders: [cloneProvider(DEFAULT_TEXT_PROVIDER)],
      imageProviders: [cloneProvider(DEFAULT_IMAGE_PROVIDER)],
    }
  }
}

export function saveProviderSettings(settings: ProviderSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
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
