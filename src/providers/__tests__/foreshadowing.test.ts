import { describe, expect, it } from 'vitest'
import type { ProjectWorkspace } from '../../domain/models'
import type { StoredScene } from '../../data/storyDatabase'
import { buildProjectContext, parseWritingResult } from '../writing'

function workspace(): ProjectWorkspace {
  return {
    project: {
      id: 'project-foreshadowing',
      title: '伏笔测试作品',
      themeId: 'neutral',
      autoIllustrate: false,
      createdAt: 0,
      updatedAt: 0,
      lastOpenedAt: 0,
    },
    messages: [],
    chapters: [],
    characters: [],
    illustrations: [],
  }
}

function scene(overrides: Partial<StoredScene> = {}): StoredScene {
  return {
    id: 'scene-1',
    projectId: 'project-foreshadowing',
    order: 1,
    createdAt: 1,
    excerpt: '',
    notes: {
      time: undefined,
      location: undefined,
      povCharacter: undefined,
      charactersPresent: [],
      events: [],
      stateChanges: [],
      relationshipChanges: [],
      knowledgeChanges: [],
      foreshadowingPlanted: [{ id: 'foreshadowing-known-id', text: '祖传铜钥匙' }],
      resolvedForeshadowingIds: [],
      unresolvedThreads: [],
    },
    ...overrides,
  }
}

describe('stable foreshadowing model contract', () => {
  it('separates new text from resolved ids even when the prose changes wording', () => {
    const result = parseWritingResult(JSON.stringify({
      assistant_note: '已推进剧情。',
      chapter_action: 'continue',
      prose: {
        chapter_title: '第一章',
        paragraphs: ['林昭终于认出那枚钥匙并非普通遗物。'],
      },
      scene_notes: {
        new_foreshadowing_texts: ['窗外反复响起的钟声'],
        resolved_foreshadowing_ids: ['foreshadowing-known-id'],
      },
    }))

    expect(result.sceneNotes?.newForeshadowingTexts).toEqual(['窗外反复响起的钟声'])
    expect(result.sceneNotes?.resolvedForeshadowingIds).toEqual(['foreshadowing-known-id'])
    expect(result.sceneNotes?.legacyResolvedForeshadowingTexts).toBeUndefined()
  })

  it('keeps obsolete text-only model fields explicitly on the compatibility path', () => {
    const result = parseWritingResult(JSON.stringify({
      assistant_note: '已推进剧情。',
      chapter_action: 'continue',
      prose: { paragraphs: ['旧模型格式仍可保存。'] },
      scene_notes: {
        clues_planted: ['旧格式的新伏笔'],
        clues_resolved: ['旧格式的已核销文本'],
      },
    }))

    expect(result.sceneNotes?.newForeshadowingTexts).toEqual(['旧格式的新伏笔'])
    expect(result.sceneNotes?.resolvedForeshadowingIds).toEqual([])
    expect(result.sceneNotes?.legacyResolvedForeshadowingTexts).toEqual(['旧格式的已核销文本'])
  })

  it('places each open durable id beside its text in the next prompt context', () => {
    const context = buildProjectContext(workspace(), [scene()], 50_000, '继续写')

    expect(context.context).toContain('[foreshadowing-known-id] 祖传铜钥匙')
    expect(context.context).toContain('仅可按 ID 核销')
  })
})

describe('writing result recovery', () => {
  it('keeps every metadata field from a complete structured response', () => {
    const result = parseWritingResult(JSON.stringify({
      assistant_note: '本轮推进完成。',
      chapter_action: 'new',
      prose: { chapter_title: '第二章', paragraphs: ['第一段正文。'] },
      chapter_summary: '章节摘要。',
      scene_notes: { events: ['发生了事件'] },
      visual_plan: {
        title: '雨夜', prompt: '雨夜的街道', action: '撑伞冲进雨中', body_language: '压低肩膀快步前行',
        expression: '神情紧绷', gaze: '看向巷口灯光', camera: '中景侧拍', motion: '雨水沿伞沿坠落',
        scene_anchor: { key: 'old-street-night', location: '旧城街道', time_period: '夜晚', fixed_elements: ['石板路', '巷口路灯'], lighting: '路灯侧光', palette: '冷蓝色' },
        characters: [],
      },
    }))

    expect(result).toMatchObject({
      assistantNote: '本轮推进完成。',
      chapterAction: 'new',
      chapterTitle: '第二章',
      paragraphs: ['第一段正文。'],
      chapterSummary: '章节摘要。',
      visualPlan: {
        title: '雨夜', prompt: '雨夜的街道', action: '撑伞冲进雨中', bodyLanguage: '压低肩膀快步前行',
        expression: '神情紧绷', gaze: '看向巷口灯光', camera: '中景侧拍', motion: '雨水沿伞沿坠落',
        sceneAnchor: { key: 'old-street-night', location: '旧城街道', timePeriod: '夜晚', fixedElements: ['石板路', '巷口路灯'] },
      },
    })
    expect(result.sceneNotes?.events).toEqual(['发生了事件'])
  })

  it('recovers only completed prose paragraphs when trailing structured JSON is truncated', () => {
    const result = parseWritingResult('{"assistant_note":"说明","prose":{"chapter_title":"第一章","paragraphs":["完整第一段。","完整第二段。","未完成的半句')

    expect(result).toMatchObject({
      chapterAction: 'continue',
      paragraphs: ['完整第一段。', '完整第二段。'],
    })
    expect(result.chapterTitle).toBeUndefined()
    expect(result.sceneNotes).toBeUndefined()
    expect(result.visualPlan).toBeUndefined()
  })

  it('does not treat JSON metadata as prose when no prose paragraphs are available', () => {
    expect(() => parseWritingResult('{"assistant_note":"只是说明","scene_notes":{"events":["事件"]}}'))
      .toThrow('模型没有返回可解析的写作结果')
  })

  it('keeps ordinary non-JSON text on the compatibility path', () => {
    expect(parseWritingResult('第一段普通文本。\n\n第二段普通文本。')).toMatchObject({
      paragraphs: ['第一段普通文本。', '第二段普通文本。'],
      chapterAction: 'continue',
    })
  })
})
