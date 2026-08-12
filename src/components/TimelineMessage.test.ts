import { describe, expect, it } from 'vitest'
import { illustrationDirectionItems, illustrationGenerationStageText } from './TimelineMessage'

describe('illustrationGenerationStageText', () => {
  it('keeps the in-memory image delivery phases concise and distinct', () => {
    expect(illustrationGenerationStageText('waiting')).toBe('正在等待图片生成')
    expect(illustrationGenerationStageText('downloading')).toBe('正在接收图片')
    expect(illustrationGenerationStageText('saving')).toBe('正在保存到手机')
    expect(illustrationGenerationStageText('validating')).toBe('正在校验文件')
  })
})

describe('illustrationDirectionItems', () => {
  it('shows the same concrete director fields that are sent to image generation', () => {
    expect(illustrationDirectionItems({
      id: 'illustration-1', projectId: 'project-1', title: '晨光', prompt: '女孩推开窗户',
      action: '抬手拨开窗帘', bodyLanguage: '身体前倾', expression: '自然地笑', gaze: '看向窗外',
      camera: '中近景', motion: '发梢被风吹起', referenceCharacterIds: [], status: 'planned', createdAt: 1, updatedAt: 1,
    })).toEqual([
      ['场景', '女孩推开窗户'],
      ['动作', '抬手拨开窗帘'],
      ['身体与手势', '身体前倾'],
      ['表情', '自然地笑'],
      ['视线目标', '看向窗外'],
      ['镜头', '中近景'],
      ['动态线索', '发梢被风吹起'],
    ])
  })
})
