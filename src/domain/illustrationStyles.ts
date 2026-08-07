import type { IllustrationStylePresetId, ProjectStyle } from './models'

export interface IllustrationStylePreset {
  id: IllustrationStylePresetId
  label: string
  description: string
  visualPrompt: string
  negativePrompt: string
}

export const DEFAULT_ILLUSTRATION_STYLE_ID: IllustrationStylePresetId = 'realistic-cinematic'

export const ILLUSTRATION_STYLE_PRESETS: readonly IllustrationStylePreset[] = [
  {
    id: 'realistic-cinematic',
    label: '写实电影感',
    description: '真实材质、自然光影与镜头叙事',
    visualPrompt: '写实电影感，真实材质与自然人体结构，统一的电影级光影和镜头语言，角色外貌连续。',
    negativePrompt: '避免动漫线稿、塑料质感、过度磨皮、画面文字、水印、角色外貌漂移。',
  },
  {
    id: 'anime',
    label: '日系二次元',
    description: '清晰线稿、赛璐璐上色与统一角色设计',
    visualPrompt: '日系二次元动画风格，清晰稳定的角色线稿，精致赛璐璐上色，统一的人物比例、五官设计与色彩体系。',
    negativePrompt: '避免真人摄影质感、三维塑料感、五官写实化、画面文字、水印、角色设计漂移。',
  },
  {
    id: 'manga',
    label: '黑白漫画',
    description: '黑白线稿、网点与分镜张力',
    visualPrompt: '黑白漫画风格，富有表现力的墨线、网点阴影和强烈分镜构图，人物造型在各场景中保持一致。',
    negativePrompt: '避免彩色渲染、照片质感、灰雾脏污、画面文字、水印、角色外貌漂移。',
  },
  {
    id: 'watercolor',
    label: '水彩绘本',
    description: '纸张肌理、透明水色与柔和边缘',
    visualPrompt: '水彩绘本风格，透明叠染的水彩色块、自然纸张肌理、柔和边缘和富有呼吸感的留白，角色设计统一。',
    negativePrompt: '避免硬边三维渲染、照片锐化、厚重油画笔触、画面文字、水印、角色外貌漂移。',
  },
  {
    id: 'oil-painting',
    label: '厚涂油画',
    description: '厚重笔触、绘画质感与戏剧光影',
    visualPrompt: '厚涂油画风格，可见而克制的笔触、丰富颜料层次和戏剧性光影，人物结构准确且角色身份稳定。',
    negativePrompt: '避免扁平赛璐璐、像素块、过度照片锐化、画面文字、水印、角色外貌漂移。',
  },
  {
    id: 'pixel-art',
    label: '像素艺术',
    description: '有限色板、清晰像素块与复古游戏感',
    visualPrompt: '精细像素艺术风格，有限而统一的色板，清晰像素块和复古游戏画面构图，角色轮廓与标志性特征可辨认。',
    negativePrompt: '避免平滑照片纹理、抗锯齿模糊、矢量线稿、画面文字、水印、角色设计漂移。',
  },
  {
    id: 'custom',
    label: '自定义画风',
    description: '自由描述作品需要的统一视觉语言',
    visualPrompt: '',
    negativePrompt: '避免画面文字、水印、低清晰度、角色外貌和视觉风格无意漂移。',
  },
] as const

export function getIllustrationStylePreset(id?: IllustrationStylePresetId) {
  return ILLUSTRATION_STYLE_PRESETS.find((style) => style.id === id)
    ?? ILLUSTRATION_STYLE_PRESETS.find((style) => style.id === DEFAULT_ILLUSTRATION_STYLE_ID)!
}

export function resolveProjectIllustrationStyle(style?: ProjectStyle) {
  const legacyPrompt = style?.visualPrompt?.trim() ?? ''
  const id = style?.illustrationStyleId
    ?? (legacyPrompt ? 'custom' : DEFAULT_ILLUSTRATION_STYLE_ID)
  const preset = getIllustrationStylePreset(id)
  const customPrompt = style?.customVisualPrompt?.trim() || (id === 'custom' ? legacyPrompt : '')

  return {
    id,
    label: preset.label,
    description: id === 'custom' && customPrompt ? customPrompt : preset.description,
    customPrompt,
    visualPrompt: id === 'custom' ? (customPrompt || getIllustrationStylePreset(DEFAULT_ILLUSTRATION_STYLE_ID).visualPrompt) : preset.visualPrompt,
    negativePrompt: id === 'custom' ? (style?.negativePrompt?.trim() || preset.negativePrompt) : preset.negativePrompt,
  }
}
