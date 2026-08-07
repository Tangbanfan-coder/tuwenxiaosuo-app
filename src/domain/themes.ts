import type { ThemePresetId } from './models'

export interface ThemePreset {
  id: ThemePresetId
  label: string
  description: string
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: 'neutral', label: '中性纸墨', description: '适合尚未确定题材的新作品' },
  { id: 'warm', label: '暖灯叙事', description: '温馨、日常与治愈题材' },
  { id: 'rainy-mystery', label: '雨夜悬念', description: '冷雨、秘密与悬疑氛围' },
  { id: 'dark-horror', label: '暗室惊惧', description: '惊悚、压迫与未知威胁' },
] as const

export function getThemePreset(id: ThemePresetId) {
  return THEME_PRESETS.find((theme) => theme.id === id) ?? THEME_PRESETS[0]
}
