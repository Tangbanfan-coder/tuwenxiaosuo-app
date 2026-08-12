import { describe, expect, it } from 'vitest'
import type { CharacterAsset, IllustrationAsset, ProjectStyle } from '../domain/models'
import { buildIllustrationPrompt } from './illustrationPrompt'

const illustration: IllustrationAsset = {
  id: 'illustration-1', projectId: 'project-1', title: '阳台晨光', prompt: '林染在阳台迎接清晨',
  action: '抬手拨开被风吹来的窗帘', bodyLanguage: '身体微微前倾，重心落在前脚', expression: '忍不住露出松弛的笑意',
  gaze: '越过栏杆望向刚亮起的天空', camera: '中近景，略低机位', motion: '发梢、裙摆和窗帘被晨风带起',
  referenceCharacterIds: ['character-1'], status: 'planned', createdAt: 1, updatedAt: 1,
}

const character: CharacterAsset = {
  id: 'character-1', projectId: 'project-1', name: '林染', role: '主角', identity: { ageAndBuild: '', fixedTraits: [] },
  appearance: { defaultLook: '', wardrobe: '' }, continuity: { revision: 0, referenceImageUrl: 'data:image/png;base64,test', referenceStyleMode: 'reference' },
  portraitStatus: 'confirmed', status: 'confirmed', createdAt: 1, updatedAt: 1,
}

const style: ProjectStyle = {
  id: 'style-1', projectId: 'project-1', presetId: 'neutral', illustrationStyleId: 'anime',
  visualPrompt: '干净的日系动画画风', negativePrompt: '低清晰度', updatedAt: 1,
}

describe('buildIllustrationPrompt', () => {
  it('combines concrete visual direction with project style and reference reconstruction rules', () => {
    const prompt = buildIllustrationPrompt(illustration, style, [character])

    expect(prompt).toContain('动作：抬手拨开被风吹来的窗帘')
    expect(prompt).toContain('身体与手势：身体微微前倾')
    expect(prompt).toContain('表情：忍不住露出松弛的笑意')
    expect(prompt).toContain('视线目标：越过栏杆')
    expect(prompt).toContain('镜头：中近景')
    expect(prompt).toContain('动态线索：发梢、裙摆')
    expect(prompt).toContain('禁止复制原图的姿势、眼神方向、构图、镜头距离或背景')
    expect(prompt).toContain('从零重构本轮人物表演')
    expect(prompt).toContain('不要把该角色转换为作品统一画风')
    expect(prompt).toContain('场景、动作和镜头仍须按当前剧情重新设计')
    expect(prompt).toContain('僵硬站姿、冻结微笑、只转动眼球')
  })

  it('separates the scene reference from character identity references', () => {
    const prompt = buildIllustrationPrompt({
      ...illustration,
      sceneAnchor: {
        key: 'balcony-night', location: '公寓阳台', timePeriod: '夜晚',
        fixedElements: ['白色栏杆', '右侧落地门'], lighting: '室内暖光从右侧照出', palette: '蓝金色',
      },
    }, style, [character], true)

    expect(prompt).toContain('参考图 1（林染）只用于身份、五官、发型和稳定外貌特征')
    expect(prompt).toContain('参考图 2 是上一张同一连续场景插画')
    expect(prompt).toContain('只用于保持空间结构、固定物件的位置与材质、环境光线和色调')
    expect(prompt).toContain('严禁复制其中人物的姿势、表情、视线、动作或镜头')
    expect(prompt).toContain('固定结构与物件=白色栏杆、右侧落地门')
  })
})
