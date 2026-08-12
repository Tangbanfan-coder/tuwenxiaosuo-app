import type { CharacterAsset, IllustrationAsset, ProjectStyle } from '../domain/models'
import { resolveProjectIllustrationStyle } from '../domain/illustrationStyles'

function referenceRule(character: CharacterAsset, index: number) {
  const preserveReferenceStyle = character.continuity.referenceStyleMode === 'reference'
  const styleNote = preserveReferenceStyle
    ? '保留该角色在参考图中的绘制或摄影风格，不要把该角色转换为作品统一画风；场景、动作和镜头仍须按当前剧情重新设计。'
    : '必须重新渲染为作品统一画风。'
  return `参考图 ${index + 1}（${character.name}）只用于身份、五官、发型和稳定外貌特征；禁止复制原图的姿势、眼神方向、构图、镜头距离或背景。${styleNote}`
}

/**
 * Builds the only prompt sent to the image model for a story illustration.
 * Reference images establish identity; the scene itself is always reconstructed.
 */
export function buildIllustrationPrompt(
  illustration: IllustrationAsset,
  style: ProjectStyle | undefined,
  referenceCharacters: CharacterAsset[],
  usesSceneReference = false,
) {
  const illustrationStyle = resolveProjectIllustrationStyle(style)
  const direction = [
    illustration.action && `动作：${illustration.action}`,
    illustration.bodyLanguage && `身体与手势：${illustration.bodyLanguage}`,
    illustration.expression && `表情：${illustration.expression}`,
    illustration.gaze && `视线目标：${illustration.gaze}`,
    illustration.camera && `镜头：${illustration.camera}`,
    illustration.motion && `动态线索：${illustration.motion}`,
  ].filter(Boolean)
  const negativeRules = [
    illustrationStyle.negativePrompt,
    illustration.sceneNegativePrompt,
    '僵硬站姿、冻结微笑、只转动眼球、瞳孔与视线不一致、四肢或手指异常、照搬参考图构图',
  ].filter(Boolean).join('；')
  const sceneReferenceIndex = referenceCharacters.length + 1
  const sceneAnchor = illustration.sceneAnchor
    ? `场景连续性锚点：地点=${illustration.sceneAnchor.location}；时间段=${illustration.sceneAnchor.timePeriod}；固定结构与物件=${illustration.sceneAnchor.fixedElements.join('、')}；光线=${illustration.sceneAnchor.lighting || '沿用既定光线'}；色调=${illustration.sceneAnchor.palette || '沿用既定色调'}。`
    : undefined
  const sceneReferenceRule = usesSceneReference
    ? `参考图 ${sceneReferenceIndex} 是上一张同一连续场景插画，只用于保持空间结构、固定物件的位置与材质、环境光线和色调。严禁复制其中人物的姿势、表情、视线、动作或镜头；人物必须按本轮画面导演重新表演，镜头允许变化。`
    : undefined

  return [
    `当前剧情画面：${illustration.prompt}`,
    direction.length ? `画面导演：\n${direction.join('\n')}` : '画面导演：以剧情中的可见动作、自然表情、明确视线与动态线索重构瞬间。',
    `作品基础画风（用于场景、环境和未指定保留参考画风的角色）：${illustrationStyle.visualPrompt || '遵循当前作品的既定视觉风格'}`,
    illustration.sceneStylePrompt && `本场景补充：${illustration.sceneStylePrompt}。如果与作品统一画风冲突，以作品统一画风为准。`,
    sceneAnchor,
    (referenceCharacters.length || sceneReferenceRule) && `参考图规则：\n${[...referenceCharacters.map(referenceRule), sceneReferenceRule].filter(Boolean).join('\n')}\n从零重构本轮人物表演；没有人物参考图的其他角色同样使用作品统一画风。`,
    `避免：${negativeRules}`,
  ].filter(Boolean).join('\n')
}
