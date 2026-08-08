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
