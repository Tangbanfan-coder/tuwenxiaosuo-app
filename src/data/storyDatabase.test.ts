import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chapter, ConversationMessage, FeedbackTargetInput, StoryProject, SummaryVersion, UpsertFeedbackInput, WritingSceneNotes, WritingTurnResult } from '../domain/models'
import { collectOpenForeshadowings } from '../domain/foreshadowing'
import { createParagraphFingerprint, normalizeText } from '../domain/paragraphs'
import {
  StoryDatabase,
  beginWritingTurn,
  completeWritingTurn,
  createProject,
  deleteProject,
  failWritingTurn,
  hashText,
  initializeStoryDatabase,
  listChapterSummaryVersions,
  listMessageFeedback,
  listProjectParagraphs,
  listRecentProjectFeedback,
  loadProjectScenes,
  removeFeedback,
  restoreChapterSummaryVersion,
  storyDatabase,
  toggleFeedback,
  upsertFeedback,
  upsertChapterParagraphs,
} from './storyDatabase'

const project: StoryProject = {
  id: 'project-1',
  title: '段落库测试作品',
  themeId: 'neutral',
  autoIllustrate: false,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
}

const writingResult: WritingTurnResult = {
  assistantNote: '正文已完成。',
  chapterAction: 'new',
  chapterTitle: '第一章',
  paragraphs: ['第一段正文。', '第二段正文。'],
}

function sceneNotes(overrides: Partial<WritingSceneNotes> = {}): WritingSceneNotes {
  return {
    time: undefined,
    location: undefined,
    povCharacter: undefined,
    charactersPresent: [],
    events: [],
    stateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    newForeshadowingTexts: [],
    resolvedForeshadowingIds: [],
    unresolvedThreads: [],
    ...overrides,
  }
}

function writingResultWithSceneNotes(
  notes: WritingSceneNotes,
  chapterAction: WritingTurnResult['chapterAction'] = 'continue',
  paragraphs = ['本轮正文。'],
): WritingTurnResult {
  return {
    assistantNote: '正文已完成。',
    chapterAction,
    chapterTitle: '伏笔测试章节',
    paragraphs,
    sceneNotes: notes,
  }
}

async function completeScene(
  notes: WritingSceneNotes,
  chapterAction: WritingTurnResult['chapterAction'] = 'continue',
  paragraphs?: string[],
) {
  const [userMessage, notice] = await beginWritingTurn(project.id, '继续写作', false)
  await completeWritingTurn(project.id, userMessage.id, notice.id, writingResultWithSceneNotes(notes, chapterAction, paragraphs), false)
  const scenes = await loadProjectScenes(project.id)
  const scene = scenes.at(-1)
  if (!scene) throw new Error('预期写作完成后已保存场景')
  return scene
}

async function clearStoryDatabase() {
  await Promise.all([
    storyDatabase.feedback.clear(),
    storyDatabase.paragraphs.clear(),
    storyDatabase.summaryVersions.clear(),
    storyDatabase.projects.clear(),
    storyDatabase.messages.clear(),
    storyDatabase.chapters.clear(),
    storyDatabase.characters.clear(),
    storyDatabase.illustrations.clear(),
    storyDatabase.styles.clear(),
    storyDatabase.scenes.clear(),
  ])
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  await clearStoryDatabase()
  await storyDatabase.projects.add({ ...project })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('project defaults', () => {
  it('initializes an empty project library without creating an unnamed project', async () => {
    await clearStoryDatabase()

    await initializeStoryDatabase()

    expect(await storyDatabase.projects.count()).toBe(0)
  })

  it('creates new projects with the unconstrained illustration style', async () => {
    await clearStoryDatabase()

    const created = await createProject('自由画风测试')
    const style = await storyDatabase.styles.where('projectId').equals(created.id).first()

    expect(style?.illustrationStyleId).toBe('unconstrained')
    expect(style?.visualPrompt).toBe('')
  })
})

describe('paragraph fingerprint', () => {
  it('normalizes whitespace, punctuation variants, and empty text deterministically', () => {
    const withFormatting = '  “风” \r\n 来了。  '
    const canonical = '"风" 来了.'

    expect(normalizeText(withFormatting)).toBe(canonical)
    expect(createParagraphFingerprint(withFormatting)).toBe(createParagraphFingerprint(canonical))
    expect(createParagraphFingerprint(' \t\n ')).toBe(hashText(''))
  })
})

describe('StoryDatabase v3 migration', () => {
  it('backfills message and chapter paragraphs directly from v2 records', async () => {
    const name = `paragraph-migration-${Date.now()}-${Math.random()}`
    const legacy = new Dexie(name)
    let upgraded: StoryDatabase | undefined

    try {
      legacy.version(2).stores({
        projects: 'id, updatedAt, lastOpenedAt',
        messages: 'id, projectId, [projectId+order], createdAt',
        chapters: 'id, projectId, [projectId+order], updatedAt',
        characters: 'id, projectId, [projectId+createdAt], status',
        illustrations: 'id, projectId, [projectId+createdAt], status',
        styles: 'id, &projectId, updatedAt',
        scenes: 'id, projectId, [projectId+order], createdAt',
      })
      await legacy.open()

      const legacyMessage: ConversationMessage = {
        id: 'message-v2',
        projectId: 'project-v2',
        chapterId: 'chapter-v2',
        kind: 'prose',
        order: 1,
        createdAt: 10,
        paragraphs: ['旧消息第一段。', '旧消息第二段。'],
        status: 'ready',
      }
      const legacyChapter: Chapter = {
        id: 'chapter-v2',
        projectId: 'project-v2',
        title: '旧章节',
        order: 1,
        content: '旧章节第一段。\n\n旧章节第二段。',
        status: 'draft',
        createdAt: 11,
        updatedAt: 12,
      }
      await legacy.table<ConversationMessage, string>('messages').add(legacyMessage)
      await legacy.table<Chapter, string>('chapters').add(legacyChapter)
      legacy.close()

      upgraded = new StoryDatabase(name)
      await upgraded.open()
      const paragraphs = await upgraded.paragraphs.where('projectId').equals('project-v2').toArray()
      const messageParagraphs = paragraphs.filter((paragraph) => paragraph.sourceType === 'message')
      const chapterParagraphs = paragraphs.filter((paragraph) => paragraph.sourceType === 'chapter')

      expect(messageParagraphs).toHaveLength(2)
      expect(messageParagraphs[0]).toMatchObject({
        id: 'paragraph-message-message-v2-0',
        messageId: 'message-v2',
        chapterId: 'chapter-v2',
        fingerprint: createParagraphFingerprint('旧消息第一段。'),
        createdAt: 10,
      })
      expect(chapterParagraphs).toHaveLength(2)
      expect(chapterParagraphs.every((paragraph) => paragraph.id.includes(hashText(legacyChapter.content)))).toBe(true)
      expect(chapterParagraphs.every((paragraph) => paragraph.createdAt === 12)).toBe(true)
    } finally {
      legacy.close()
      upgraded?.close()
      await Dexie.delete(name)
    }
  })
})

describe('StoryDatabase v4 foreshadowing migration', () => {
  it('upgrades legacy strings deterministically and preserves ambiguous or unmatched resolutions', async () => {
    const name = `foreshadowing-migration-${Date.now()}-${Math.random()}`
    const legacy = new Dexie(name)
    let upgraded: StoryDatabase | undefined

    try {
      legacy.version(3).stores({
        projects: 'id, updatedAt, lastOpenedAt',
        messages: 'id, projectId, [projectId+order], createdAt',
        chapters: 'id, projectId, [projectId+order], updatedAt',
        characters: 'id, projectId, [projectId+createdAt], status',
        illustrations: 'id, projectId, [projectId+createdAt], status',
        styles: 'id, &projectId, updatedAt',
        scenes: 'id, projectId, [projectId+order], createdAt',
        paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      })
      await legacy.open()
      await legacy.table('scenes').bulkAdd([
        {
          id: 'scene-v3-plant',
          projectId: 'project-v3',
          order: 1,
          createdAt: 1,
          notes: {
            time: undefined,
            location: undefined,
            povCharacter: undefined,
            charactersPresent: [],
            events: [],
            stateChanges: [],
            relationshipChanges: [],
            knowledgeChanges: [],
            cluesPlanted: ['旧钥匙', '同名线索', '同名线索'],
            cluesResolved: [],
            unresolvedThreads: [],
          },
          excerpt: '',
        },
        {
          id: 'scene-v3-resolve',
          projectId: 'project-v3',
          order: 2,
          createdAt: 2,
          notes: {
            time: undefined,
            location: undefined,
            povCharacter: undefined,
            charactersPresent: [],
            events: [],
            stateChanges: [],
            relationshipChanges: [],
            knowledgeChanges: [],
            cluesPlanted: [],
            cluesResolved: ['  旧钥匙  ', '同名线索', '不存在的伏笔'],
            unresolvedThreads: [],
          },
          excerpt: '',
        },
      ])
      legacy.close()

      upgraded = new StoryDatabase(name)
      await upgraded.open()
      const scenes = await upgraded.scenes.where('projectId').equals('project-v3').sortBy('order')
      const planted = scenes[0]?.notes.foreshadowingPlanted
      const resolved = scenes[1]?.notes

      expect(planted).toEqual([
        { id: 'foreshadowing-legacy-scene-v3-plant-0', text: '旧钥匙' },
        { id: 'foreshadowing-legacy-scene-v3-plant-1', text: '同名线索' },
        { id: 'foreshadowing-legacy-scene-v3-plant-2', text: '同名线索' },
      ])
      expect(resolved?.resolvedForeshadowingIds).toEqual(['foreshadowing-legacy-scene-v3-plant-0'])
      expect(resolved?.legacyUnmatchedResolvedForeshadowingTexts).toEqual(['同名线索', '不存在的伏笔'])
      expect((scenes[0]?.notes as unknown as Record<string, unknown>).cluesPlanted).toBeUndefined()
      expect((scenes[1]?.notes as unknown as Record<string, unknown>).cluesResolved).toBeUndefined()
    } finally {
      legacy.close()
      upgraded?.close()
      await Dexie.delete(name)
    }
  })
})

describe('StoryDatabase v5-v6 summary version and feedback schema migrations', () => {
  it('backfills non-empty summaries with only exact current chapter paragraph IDs and preserves legacy rows', async () => {
    const name = `summary-version-migration-${Date.now()}-${Math.random()}`
    const legacy = new Dexie(name)
    let upgraded: StoryDatabase | undefined

    const summarizedChapter: Chapter = {
      id: 'chapter-v4-summary',
      projectId: 'project-v4',
      title: '有提要章节',
      order: 1,
      content: '迁移章节第一段。\n\n迁移章节第二段。',
      status: 'draft',
      summary: '已有章节提要。',
      createdAt: 10,
      updatedAt: 11,
    }
    const noParagraphChapter: Chapter = {
      id: 'chapter-v4-no-paragraph',
      projectId: 'project-v4',
      title: '无段落记录章节',
      order: 2,
      content: '只有章节内容，没有段落记录。',
      status: 'draft',
      summary: '没有段落锚点的提要。',
      createdAt: 12,
      updatedAt: 13,
    }
    const blankSummaryChapter: Chapter = {
      id: 'chapter-v4-empty-summary',
      projectId: 'project-v4',
      title: '空提要章节',
      order: 3,
      content: '空提要不能创建版本。',
      status: 'draft',
      summary: '',
      createdAt: 14,
      updatedAt: 15,
    }
    const summarizedHash = hashText(summarizedChapter.content)
    const expectedParagraphIds = [
      `paragraph-chapter-${summarizedChapter.id}-${summarizedHash}-0`,
      `paragraph-chapter-${summarizedChapter.id}-${summarizedHash}-1`,
    ]

    try {
      legacy.version(4).stores({
        projects: 'id, updatedAt, lastOpenedAt',
        messages: 'id, projectId, [projectId+order], createdAt',
        chapters: 'id, projectId, [projectId+order], updatedAt',
        characters: 'id, projectId, [projectId+createdAt], status',
        illustrations: 'id, projectId, [projectId+createdAt], status',
        styles: 'id, &projectId, updatedAt',
        scenes: 'id, projectId, [projectId+order], createdAt',
        paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      })
      await legacy.open()
      await legacy.table<Chapter, string>('chapters').bulkAdd([summarizedChapter, noParagraphChapter, blankSummaryChapter])
      await legacy.table('paragraphs').bulkAdd([
        {
          id: expectedParagraphIds[0],
          projectId: summarizedChapter.projectId,
          sourceType: 'chapter',
          chapterId: summarizedChapter.id,
          index: 0,
          text: '迁移章节第一段。',
          fingerprint: createParagraphFingerprint('迁移章节第一段。'),
          createdAt: 11,
        },
        {
          id: expectedParagraphIds[1],
          projectId: summarizedChapter.projectId,
          sourceType: 'chapter',
          chapterId: summarizedChapter.id,
          index: 1,
          text: '迁移章节第二段。',
          fingerprint: createParagraphFingerprint('迁移章节第二段。'),
          createdAt: 11,
        },
        {
          // Same paragraph text but an old content hash: it must not be bound by text.
          id: `paragraph-chapter-${summarizedChapter.id}-${hashText('过期内容')}-0`,
          projectId: summarizedChapter.projectId,
          sourceType: 'chapter',
          chapterId: summarizedChapter.id,
          index: 0,
          text: '迁移章节第一段。',
          fingerprint: createParagraphFingerprint('迁移章节第一段。'),
          createdAt: 9,
        },
      ])
      legacy.close()

      upgraded = new StoryDatabase(name)
      await upgraded.open()

      expect(upgraded.verno).toBe(6)
      expect(await upgraded.feedback.count()).toBe(0)
      const versions = await upgraded.summaryVersions.where('projectId').equals('project-v4').toArray()
      const migrated = versions.find((version) => version.chapterId === summarizedChapter.id)
      const withoutParagraphs = versions.find((version) => version.chapterId === noParagraphChapter.id)

      expect(versions).toHaveLength(2)
      expect(migrated).toMatchObject({
        projectId: summarizedChapter.projectId,
        chapterId: summarizedChapter.id,
        version: 1,
        summary: summarizedChapter.summary,
        sourceContentHash: summarizedHash,
        sourceParagraphIds: expectedParagraphIds,
        reason: 'migration',
        createdAt: summarizedChapter.updatedAt,
      })
      expect(withoutParagraphs).toMatchObject({
        projectId: noParagraphChapter.projectId,
        chapterId: noParagraphChapter.id,
        version: 1,
        summary: noParagraphChapter.summary,
        sourceContentHash: hashText(noParagraphChapter.content),
        sourceParagraphIds: [],
        reason: 'migration',
      })
      expect(versions.some((version) => version.chapterId === blankSummaryChapter.id)).toBe(false)

      expect(await upgraded.chapters.get(summarizedChapter.id)).toMatchObject(summarizedChapter)
      expect(await upgraded.chapters.get(noParagraphChapter.id)).toMatchObject(noParagraphChapter)
      expect(await upgraded.paragraphs.get(`paragraph-chapter-${summarizedChapter.id}-${hashText('过期内容')}-0`)).toBeDefined()
    } finally {
      legacy.close()
      upgraded?.close()
      await Dexie.delete(name)
    }
  })
})

describe('stable foreshadowing persistence', () => {
  it('assigns local ids immediately and resolves only known ids idempotently', async () => {
    const firstScene = await completeScene(sceneNotes({
      newForeshadowingTexts: ['同名线索', '同名线索', '“银色钥匙”'],
    }), 'new')
    const [first, second, silverKey] = firstScene.notes.foreshadowingPlanted

    expect(first?.id).toMatch(/^foreshadowing-/)
    expect(second?.id).toMatch(/^foreshadowing-/)
    expect(silverKey?.id).toMatch(/^foreshadowing-/)
    expect(new Set([first?.id, second?.id, silverKey?.id]).size).toBe(3)

    const resolutionScene = await completeScene(sceneNotes({
      // The prose may use new wording; only the durable id determines closure.
      resolvedForeshadowingIds: [first!.id, first!.id, 'foreshadowing-forged-id'],
    }), 'continue', ['林昭终于认出那枚钥匙并非普通遗物。'])
    expect(resolutionScene.notes.resolvedForeshadowingIds).toEqual([first!.id])

    const afterStableResolution = collectOpenForeshadowings((await loadProjectScenes(project.id)).map((scene) => scene.notes))
    expect(afterStableResolution.has(first!.id)).toBe(false)
    expect(afterStableResolution.has(second!.id)).toBe(true)
    expect(afterStableResolution.has(silverKey!.id)).toBe(true)

    const fuzzyLegacyAttempt = await completeScene(sceneNotes({
      legacyResolvedForeshadowingTexts: ['银色钥匙的锈迹'],
    }))
    expect(fuzzyLegacyAttempt.notes.resolvedForeshadowingIds).toEqual([])
    expect(fuzzyLegacyAttempt.notes.legacyUnmatchedResolvedForeshadowingTexts).toEqual(['银色钥匙的锈迹'])

    const exactLegacyResolution = await completeScene(sceneNotes({
      legacyResolvedForeshadowingTexts: ['  "银色钥匙"  '],
    }))
    expect(exactLegacyResolution.notes.resolvedForeshadowingIds).toEqual([silverKey!.id])

    const remaining = collectOpenForeshadowings((await loadProjectScenes(project.id)).map((scene) => scene.notes))
    expect(Array.from(remaining.keys())).toEqual([second!.id])
  })
})

describe('chapter summary versions', () => {
  async function completeWithSummary(
    chapterAction: WritingTurnResult['chapterAction'],
    paragraphs: string[],
    chapterSummary: string,
  ) {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写作', false)
    await completeWritingTurn(project.id, userMessage.id, notice.id, {
      assistantNote: '正文已完成。',
      chapterAction,
      chapterTitle: '摘要版本测试章节',
      paragraphs,
      chapterSummary,
    }, false)
  }

  it('stores generated summaries atomically, deduplicates an unchanged source, and increments versions for changes', async () => {
    await completeWithSummary('new', ['第一段正文。'], '第一版提要。')

    const chapter = (await storyDatabase.chapters.where('projectId').equals(project.id).toArray())[0]
    if (!chapter) throw new Error('预期已创建章节')
    const firstVersions = await listChapterSummaryVersions(project.id, chapter.id)
    const chapterParagraphIds = (await listProjectParagraphs(project.id))
      .filter((paragraph) => paragraph.sourceType === 'chapter' && paragraph.chapterId === chapter.id)
      .sort((left, right) => left.index - right.index)
      .map((paragraph) => paragraph.id)

    expect(chapter.summary).toBe('第一版提要。')
    expect(firstVersions).toHaveLength(1)
    expect(firstVersions[0]).toMatchObject({
      version: 1,
      summary: '第一版提要。',
      sourceContentHash: hashText(chapter.content),
      sourceParagraphIds: chapterParagraphIds,
      reason: 'generation',
    })

    // No prose means the chapter content hash is unchanged, so the same model
    // summary must not create a duplicate version.
    await completeWithSummary('continue', [], '第一版提要。')
    expect(await listChapterSummaryVersions(project.id, chapter.id)).toHaveLength(1)

    await completeWithSummary('continue', ['第二段正文。'], '第一版提要。')
    await completeWithSummary('continue', [], '第二版提要。')
    const versions = await listChapterSummaryVersions(project.id, chapter.id)

    expect(versions.map((version) => version.version)).toEqual([1, 2, 3])
    expect(versions[1]).toMatchObject({ summary: '第一版提要。', reason: 'generation' })
    expect(versions[1]?.sourceContentHash).not.toBe(versions[0]?.sourceContentHash)
    expect(versions[2]).toMatchObject({ summary: '第二版提要。', reason: 'generation' })
  })

  it('rolls a chapter summary update back when version persistence fails', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '开始写作', false)
    const summaryWrite = vi.spyOn(storyDatabase.summaryVersions, 'add').mockRejectedValueOnce(new Error('summary version write failed'))

    try {
      await expect(completeWritingTurn(project.id, userMessage.id, notice.id, {
        assistantNote: '正文已完成。',
        chapterAction: 'new',
        chapterTitle: '会回滚的章节',
        paragraphs: ['不会留下的正文。'],
        chapterSummary: '不会留下的提要。',
      }, false)).rejects.toThrow('summary version write failed')
    } finally {
      summaryWrite.mockRestore()
    }

    expect(await storyDatabase.chapters.count()).toBe(0)
    expect(await storyDatabase.summaryVersions.count()).toBe(0)
    expect((await storyDatabase.messages.toArray()).some((message) => message.kind === 'prose')).toBe(false)
    expect(await storyDatabase.messages.get(userMessage.id)).toMatchObject({ chapterId: undefined })
    expect(await storyDatabase.messages.get(notice.id)).toMatchObject({
      chapterId: undefined,
      text: '正在创作正文…',
      status: 'pending',
    })
  })

  it('restores only a version owned by the requested project and chapter while preserving old versions', async () => {
    const otherProject: StoryProject = {
      ...project,
      id: 'project-2',
      title: '另一部作品',
    }
    await storyDatabase.projects.add(otherProject)

    const chapter: Chapter = {
      id: 'summary-chapter-1',
      projectId: project.id,
      title: '第一章',
      order: 1,
      content: '第一章正文。',
      status: 'draft',
      summary: '当前提要。',
      createdAt: 10,
      updatedAt: 20,
    }
    const siblingChapter: Chapter = {
      ...chapter,
      id: 'summary-chapter-2',
      title: '第二章',
      order: 2,
      content: '第二章正文。',
    }
    const foreignChapter: Chapter = {
      ...chapter,
      id: 'summary-chapter-foreign',
      projectId: otherProject.id,
      title: '外部章节',
      content: '外部章节正文。',
    }
    await storyDatabase.chapters.bulkAdd([chapter, siblingChapter, foreignChapter])
    const chapterParagraphs = await upsertChapterParagraphs(chapter)

    const sourceVersion: SummaryVersion = {
      id: 'summary-version-source',
      projectId: project.id,
      chapterId: chapter.id,
      version: 1,
      summary: '需要恢复的历史提要。',
      sourceContentHash: hashText(chapter.content),
      sourceParagraphIds: chapterParagraphs.map((paragraph) => paragraph.id),
      reason: 'generation',
      createdAt: 21,
    }
    const siblingVersion: SummaryVersion = {
      id: 'summary-version-sibling',
      projectId: project.id,
      chapterId: siblingChapter.id,
      version: 1,
      summary: '同项目另一章提要。',
      sourceContentHash: hashText(siblingChapter.content),
      sourceParagraphIds: [],
      reason: 'generation',
      createdAt: 22,
    }
    const foreignVersion: SummaryVersion = {
      id: 'summary-version-foreign',
      projectId: otherProject.id,
      chapterId: foreignChapter.id,
      version: 1,
      summary: '另一部作品提要。',
      sourceContentHash: hashText(foreignChapter.content),
      sourceParagraphIds: [],
      reason: 'generation',
      createdAt: 23,
    }
    await storyDatabase.summaryVersions.bulkAdd([sourceVersion, siblingVersion, foreignVersion])
    const originalSource = await storyDatabase.summaryVersions.get(sourceVersion.id)

    const restored = await restoreChapterSummaryVersion(project.id, chapter.id, sourceVersion.id)
    const versions = await listChapterSummaryVersions(project.id, chapter.id)

    expect((await storyDatabase.chapters.get(chapter.id))?.summary).toBe(sourceVersion.summary)
    expect(restored).toMatchObject({
      projectId: project.id,
      chapterId: chapter.id,
      version: 2,
      summary: sourceVersion.summary,
      sourceContentHash: sourceVersion.sourceContentHash,
      sourceParagraphIds: sourceVersion.sourceParagraphIds,
      reason: 'restore',
      restoredFromId: sourceVersion.id,
    })
    expect(versions).toHaveLength(2)
    expect(versions[0]).toEqual(originalSource)
    expect(await storyDatabase.summaryVersions.get(sourceVersion.id)).toEqual(originalSource)

    await expect(restoreChapterSummaryVersion(project.id, chapter.id, siblingVersion.id)).rejects.toThrow('摘要版本不属于当前章节')
    await expect(restoreChapterSummaryVersion(project.id, chapter.id, foreignVersion.id)).rejects.toThrow('摘要版本不属于当前章节')
    await expect(restoreChapterSummaryVersion(otherProject.id, chapter.id, sourceVersion.id)).rejects.toThrow('章节不存在或不属于当前作品')
    expect(await listChapterSummaryVersions(project.id, chapter.id)).toHaveLength(2)
  })
})

describe('paragraph persistence', () => {
  it('writes a prose message and its paragraph rows in one transaction', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '请开始写作', false)

    await completeWritingTurn(project.id, userMessage.id, notice.id, writingResult, false)

    const proseMessage = (await storyDatabase.messages.toArray()).find((message) => message.kind === 'prose')
    const paragraphs = await listProjectParagraphs(project.id)
    const messageParagraphs = paragraphs.filter((paragraph) => paragraph.sourceType === 'message')

    expect(proseMessage?.paragraphs).toEqual(writingResult.paragraphs)
    expect(messageParagraphs.map((paragraph) => paragraph.text)).toEqual(writingResult.paragraphs)
    expect(messageParagraphs.every((paragraph) => paragraph.messageId === proseMessage?.id)).toBe(true)
  })

  it('rolls the prose message back when its paragraph write fails', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '请开始写作', false)
    const paragraphWrite = vi.spyOn(storyDatabase.paragraphs, 'bulkPut').mockRejectedValueOnce(new Error('paragraph write failed'))

    try {
      await expect(completeWritingTurn(project.id, userMessage.id, notice.id, writingResult, false)).rejects.toThrow('paragraph write failed')
    } finally {
      paragraphWrite.mockRestore()
    }

    expect((await storyDatabase.messages.toArray()).some((message) => message.kind === 'prose')).toBe(false)
    expect(await storyDatabase.paragraphs.count()).toBe(0)
  })

  it('keeps prior chapter versions and is idempotent for unchanged content', async () => {
    const firstVersion: Chapter = {
      id: 'chapter-1',
      projectId: project.id,
      title: '第一章',
      order: 1,
      content: '第一段。\n\n第二段。',
      status: 'draft',
      createdAt: 20,
      updatedAt: 20,
    }
    await storyDatabase.chapters.add(firstVersion)

    await upsertChapterParagraphs(firstVersion)
    await upsertChapterParagraphs(firstVersion)
    const firstRows = (await listProjectParagraphs(project.id)).filter((paragraph) => paragraph.sourceType === 'chapter')

    expect(firstRows).toHaveLength(2)
    expect(firstRows.every((paragraph) => paragraph.id.includes(hashText(firstVersion.content)))).toBe(true)

    const secondVersion = {
      ...firstVersion,
      content: '第一段修订版。',
      updatedAt: 30,
    }
    await storyDatabase.chapters.update(secondVersion.id, { content: secondVersion.content, updatedAt: secondVersion.updatedAt })
    await upsertChapterParagraphs(secondVersion)
    const allRows = (await listProjectParagraphs(project.id)).filter((paragraph) => paragraph.sourceType === 'chapter')

    expect(allRows).toHaveLength(3)
    expect(allRows.some((paragraph) => paragraph.id.includes(hashText(firstVersion.content)))).toBe(true)
    expect(allRows.some((paragraph) => paragraph.id.includes(hashText(secondVersion.content)))).toBe(true)
  })

  it('deletes paragraph rows with the project', async () => {
    await storyDatabase.paragraphs.add({
      id: 'paragraph-message-message-1-0',
      projectId: project.id,
      sourceType: 'message',
      messageId: 'message-1',
      chapterId: 'chapter-1',
      index: 0,
      text: '需要级联删除的段落。',
      fingerprint: createParagraphFingerprint('需要级联删除的段落。'),
      createdAt: 1,
    })
    await storyDatabase.summaryVersions.add({
      id: 'summary-version-delete-1',
      projectId: project.id,
      chapterId: 'chapter-1',
      version: 1,
      summary: '需要级联删除的提要。',
      sourceContentHash: hashText('需要级联删除的章节内容。'),
      sourceParagraphIds: [],
      reason: 'generation',
      createdAt: 1,
    })
    await storyDatabase.feedback.add({
      id: 'feedback-delete-1',
      projectId: project.id,
      messageId: 'message-1',
      chapterId: 'chapter-1',
      scope: 'message',
      targetKey: JSON.stringify([project.id, 'message-1', 'chapter-1', 'message', null]),
      verdict: 'up',
      createdAt: 1,
      updatedAt: 1,
    })

    await deleteProject(project.id)

    expect(await storyDatabase.projects.get(project.id)).toBeUndefined()
    expect(await storyDatabase.paragraphs.where('projectId').equals(project.id).count()).toBe(0)
    expect(await storyDatabase.summaryVersions.where('projectId').equals(project.id).count()).toBe(0)
    expect(await storyDatabase.feedback.where('projectId').equals(project.id).count()).toBe(0)
  })
})

describe('failed writing turn persistence', () => {
  it('atomically preserves partial prose as a failed message without changing chapters or scenes', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写作', false)

    await failWritingTurn(notice.id, '模型没有返回可解析的写作结果', '第一段未完成正文。\n\n第二段仍在生成')

    const messages = await storyDatabase.messages.where('projectId').equals(project.id).sortBy('order')
    const failedNotice = messages.find((message) => message.id === notice.id)
    const draft = messages.find((message) => message.kind === 'prose')
    expect(failedNotice).toMatchObject({ status: 'failed' })
    expect(failedNotice?.text).toContain('已保留模型已经返回的未完成草稿')
    expect(draft).toMatchObject({
      status: 'failed',
      paragraphs: ['第一段未完成正文。', '第二段仍在生成'],
      order: notice.order + 1,
    })
    expect(userMessage.chapterId).toBeUndefined()
    expect(await storyDatabase.chapters.count()).toBe(0)
    expect(await storyDatabase.scenes.count()).toBe(0)
    expect(await storyDatabase.paragraphs.count()).toBe(0)
  })
})

describe('scene ordering', () => {
  it('uses the previous maximum order plus one even when timestamps are identical', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      await completeScene(sceneNotes(), 'new', ['第一轮。'])
      await completeScene(sceneNotes(), 'continue', ['第二轮。'])

      const scenes = await loadProjectScenes(project.id)
      expect(scenes.map((scene) => scene.order)).toEqual([1, 2])
    } finally {
      now.mockRestore()
    }
  })
})

describe('feedback persistence', () => {
  async function seedFeedbackTarget() {
    const chapter: Chapter = {
      id: 'feedback-chapter-1',
      projectId: project.id,
      title: '反馈测试章节',
      order: 1,
      content: '第一段正文。\n\n第二段正文。',
      status: 'draft',
      createdAt: 10,
      updatedAt: 10,
    }
    const message: ConversationMessage = {
      id: 'feedback-prose-message-1',
      projectId: project.id,
      chapterId: chapter.id,
      kind: 'prose',
      order: 1,
      createdAt: 11,
      paragraphs: ['第一段正文。', '第二段正文。'],
      status: 'ready',
    }
    const siblingMessage: ConversationMessage = {
      ...message,
      id: 'feedback-prose-message-2',
      order: 2,
      createdAt: 12,
      paragraphs: ['另一条正文消息。'],
    }
    await storyDatabase.chapters.add(chapter)
    await storyDatabase.messages.bulkAdd([message, siblingMessage])
    await storyDatabase.paragraphs.bulkAdd(message.paragraphs!.map((text, index) => ({
      id: `paragraph-message-${message.id}-${index}`,
      projectId: project.id,
      sourceType: 'message' as const,
      messageId: message.id,
      chapterId: chapter.id,
      index,
      text,
      fingerprint: createParagraphFingerprint(text),
      createdAt: message.createdAt,
    })))

    const messageTarget: FeedbackTargetInput = {
      projectId: project.id,
      messageId: message.id,
      chapterId: chapter.id,
      scope: 'message',
    }
    const paragraphTarget: FeedbackTargetInput = {
      projectId: project.id,
      messageId: message.id,
      chapterId: chapter.id,
      scope: 'paragraph',
      paragraphId: `paragraph-message-${message.id}-0`,
      paragraphIndex: 0,
      paragraphFingerprint: createParagraphFingerprint(message.paragraphs![0]!),
    }
    const secondParagraphTarget: FeedbackTargetInput = {
      ...paragraphTarget,
      paragraphId: `paragraph-message-${message.id}-1`,
      paragraphIndex: 1,
      paragraphFingerprint: createParagraphFingerprint(message.paragraphs![1]!),
    }
    return { chapter, message, siblingMessage, messageTarget, paragraphTarget, secondParagraphTarget }
  }

  it('upserts unique message and paragraph feedback while clearing irrelevant message fields', async () => {
    const { message, messageTarget, paragraphTarget } = await seedFeedbackTarget()
    const first = await upsertFeedback({
      ...messageTarget,
      verdict: 'up',
      reason: '  节奏很好  ',
      paragraphId: 'ignored-for-message-scope',
      paragraphIndex: 99,
      paragraphFingerprint: 'ignored-for-message-scope',
    })
    const updated = await upsertFeedback({
      ...messageTarget,
      verdict: 'down',
      reason: '铺垫不够',
      customNote: '补充人物动机',
    })
    const paragraph = await upsertFeedback({ ...paragraphTarget, verdict: 'up' })

    expect(await storyDatabase.feedback.count()).toBe(2)
    expect(updated).toMatchObject({
      id: first.id,
      projectId: project.id,
      messageId: message.id,
      verdict: 'down',
      reason: '铺垫不够',
      customNote: '补充人物动机',
      createdAt: first.createdAt,
    })
    expect(updated.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(updated.paragraphId).toBeUndefined()
    expect(updated.paragraphIndex).toBeUndefined()
    expect(updated.paragraphFingerprint).toBeUndefined()
    expect(paragraph).toMatchObject({
      scope: 'paragraph',
      paragraphId: paragraphTarget.paragraphId,
      paragraphIndex: paragraphTarget.paragraphIndex,
      paragraphFingerprint: paragraphTarget.paragraphFingerprint,
    })
    expect(paragraph.targetKey).not.toBe(first.targetKey)

    const feedback = await listMessageFeedback(project.id, message.id)
    expect(feedback).toHaveLength(2)
    expect(feedback.map((item) => item.id)).toEqual(expect.arrayContaining([first.id, paragraph.id]))
  })

  it('toggles an identical verdict off, switches an opposite verdict in place, and supports exact removal', async () => {
    const { messageTarget } = await seedFeedbackTarget()
    const created = await toggleFeedback({ ...messageTarget, verdict: 'up', reason: '喜欢' })
    const removedBySameTap = await toggleFeedback({ ...messageTarget, verdict: 'up' })

    expect(created).toMatchObject({ verdict: 'up' })
    expect(removedBySameTap).toBeNull()
    expect(await storyDatabase.feedback.count()).toBe(0)

    const down = await toggleFeedback({ ...messageTarget, verdict: 'down', reason: '不喜欢' })
    const switched = await toggleFeedback({ ...messageTarget, verdict: 'up', customNote: '改为赞同' })
    if (!down || !switched) throw new Error('预期切换反馈会返回记录')

    expect(switched).toMatchObject({
      id: down.id,
      verdict: 'up',
      customNote: '改为赞同',
      createdAt: down.createdAt,
    })
    expect(switched.updatedAt).toBeGreaterThan(down.updatedAt)
    expect(await removeFeedback(messageTarget)).toBe(true)
    expect(await removeFeedback(messageTarget)).toBe(false)
    expect(await storyDatabase.feedback.count()).toBe(0)
  })

  it('rejects non-prose, foreign, mismatched, and fingerprint-drifted targets without rebinding existing feedback', async () => {
    const { chapter, message, siblingMessage, messageTarget, paragraphTarget } = await seedFeedbackTarget()
    const foreignProject: StoryProject = { ...project, id: 'feedback-project-foreign', title: '外部作品' }
    const otherChapter: Chapter = { ...chapter, id: 'feedback-chapter-2', order: 2 }
    const userMessage: ConversationMessage = {
      ...message,
      id: 'feedback-user-message',
      kind: 'user',
      paragraphs: undefined,
    }
    await storyDatabase.projects.add(foreignProject)
    await storyDatabase.chapters.add(otherChapter)
    await storyDatabase.messages.add(userMessage)

    await expect(upsertFeedback({ ...messageTarget, verdict: 'up', messageId: userMessage.id })).rejects.toThrow('仅正文消息支持反馈')
    await expect(upsertFeedback({ ...messageTarget, verdict: 'up', projectId: foreignProject.id })).rejects.toThrow('消息不存在或不属于当前作品')
    await expect(upsertFeedback({ ...paragraphTarget, verdict: 'up', messageId: siblingMessage.id })).rejects.toThrow('段落不存在或不属于当前正文消息')
    await expect(upsertFeedback({ ...messageTarget, verdict: 'up', chapterId: otherChapter.id })).rejects.toThrow('消息不属于当前章节')

    const original = await upsertFeedback({ ...paragraphTarget, verdict: 'up' })
    await storyDatabase.paragraphs.update(paragraphTarget.paragraphId!, { fingerprint: 'fingerprint-drifted' })
    await expect(upsertFeedback({ ...paragraphTarget, verdict: 'down' })).rejects.toThrow('段落已变化')
    expect(await storyDatabase.feedback.get(original.id)).toEqual(original)
  })

  it('lists project feedback by updated time descending and honors the requested limit', async () => {
    const { messageTarget, paragraphTarget, secondParagraphTarget } = await seedFeedbackTarget()
    const now = vi.spyOn(Date, 'now')

    try {
      now.mockReturnValue(100)
      const messageFeedback = await upsertFeedback({ ...messageTarget, verdict: 'up' })
      now.mockReturnValue(300)
      const newestParagraphFeedback = await upsertFeedback({ ...paragraphTarget, verdict: 'down' })
      now.mockReturnValue(200)
      const middleParagraphFeedback = await upsertFeedback({ ...secondParagraphTarget, verdict: 'up' })

      const recent = await listRecentProjectFeedback(project.id, 2)
      expect(recent.map((feedback) => feedback.id)).toEqual([
        newestParagraphFeedback.id,
        middleParagraphFeedback.id,
      ])
      expect((await listRecentProjectFeedback(project.id)).map((feedback) => feedback.id)).toEqual([
        newestParagraphFeedback.id,
        middleParagraphFeedback.id,
        messageFeedback.id,
      ])
    } finally {
      now.mockRestore()
    }
  })
})
