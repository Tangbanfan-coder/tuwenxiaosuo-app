import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chapter, ConversationMessage, FeedbackTargetInput, StoryProject, SummaryVersion, UpsertFeedbackInput, WritingProseResult, WritingSceneNotes, WritingTurnResult } from '../domain/models'
import { collectOpenForeshadowings } from '../domain/foreshadowing'
import { createParagraphFingerprint, normalizeText } from '../domain/paragraphs'
import { PROSE_STYLE_RULE_VERSION } from '../domain/proseStyle'
import {
  StoryDatabase,
  applyParagraphRewrite,
  beginWritingTurn,
  cancelWritingTurn,
  confirmCharacterPortrait,
  createCharacterDraft,
  completeWritingTurn,
  createProject,
  deleteProject,
  deleteStyleCorpusSource,
  failWritingTurn,
  hashText,
  initializeStoryDatabase,
  listChapterSummaryVersions,
  listStyleCorpusFragments,
  listMessageFeedback,
  listMessageParagraphsWithCurrentStyleIssues,
  listProjectParagraphs,
  listRecentProjectFeedback,
  loadProjectScenes,
  removeFeedback,
  restoreChapterSummaryVersion,
  restoreIllustrationsBlockedByReference,
  retryWritingTurn,
  saveStyleCorpusImport,
  splitStyleCorpusText,
  setIllustrationBlockedByReference,
  setWritingTurnBackgroundTask,
  storyDatabase,
  toggleFeedback,
  toggleFeedbackBatch,
  upsertFeedback,
  upsertChapterParagraphs,
  updateCharacterProfile,
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

const writingResult: WritingProseResult = {
  kind: 'prose',
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
  chapterAction: 'continue' | 'new' = 'continue',
  paragraphs = ['本轮正文。'],
): WritingTurnResult {
  return {
    kind: 'prose',
    assistantNote: '正文已完成。',
    chapterAction,
    chapterTitle: '伏笔测试章节',
    paragraphs,
    sceneNotes: notes,
  }
}

async function completeScene(
  notes: WritingSceneNotes,
  chapterAction: 'continue' | 'new' = 'continue',
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
    storyDatabase.styleCorpusBindings.clear(),
    storyDatabase.styleCorpusFragments.clear(),
    storyDatabase.styleCorpusSources.clear(),
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
    expect(created.illustrationMode).toBe('auto')
    expect(created.autoIllustrate).toBeUndefined()
  })

  it('migrates legacy autoIllustrate values to a single illustration mode', async () => {
    const name = `illustration-mode-migration-${crypto.randomUUID()}`
    const legacy = new Dexie(name)
    let upgraded: StoryDatabase | undefined
    try {
      legacy.version(11).stores({
        projects: 'id, updatedAt, lastOpenedAt',
        illustrations: 'id, projectId, [projectId+createdAt], status',
      })
      await legacy.open()
      await legacy.table('projects').bulkAdd([
        { id: 'legacy-auto', title: '自动', themeId: 'neutral', autoIllustrate: true, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 },
        { id: 'legacy-manual', title: '按需', themeId: 'neutral', autoIllustrate: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 },
      ])
      await legacy.table('illustrations').bulkAdd([
        { id: 'illustration-auto', projectId: 'legacy-auto', title: '自动', prompt: '', referenceCharacterIds: [], status: 'planned', createdAt: 1, updatedAt: 1 },
        { id: 'illustration-manual', projectId: 'legacy-manual', title: '按需', prompt: '', referenceCharacterIds: [], status: 'planned', createdAt: 1, updatedAt: 1 },
      ])
      legacy.close()
      upgraded = new StoryDatabase(name)
      await upgraded.open()

      expect(await upgraded.projects.get('legacy-auto')).toMatchObject({ illustrationMode: 'auto' })
      expect(await upgraded.projects.get('legacy-manual')).toMatchObject({ illustrationMode: 'manual' })
      expect((await upgraded.projects.get('legacy-auto'))?.autoIllustrate).toBeUndefined()
      expect(await upgraded.illustrations.get('illustration-manual')).toMatchObject({ generationMode: 'manual' })
    } finally {
      upgraded?.close()
      legacy.close()
      await Dexie.delete(name)
    }
  })
})

describe('character narrative pronouns', () => {
  it('keeps legacy character records readable and requires a pronoun before reference confirmation', async () => {
    await storyDatabase.characters.add({
      id: 'legacy-character', projectId: project.id, name: '旧角色', role: '主角',
      identity: { ageAndBuild: '', fixedTraits: [] }, appearance: { defaultLook: '', wardrobe: '' },
      continuity: { revision: 1, referenceImageUrl: 'data:image/png;base64,AA==' }, portraitStatus: 'review', status: 'draft', createdAt: 1, updatedAt: 1,
    })
    expect((await storyDatabase.characters.get('legacy-character'))?.narrativePronoun).toBeUndefined()
    await expect(confirmCharacterPortrait('legacy-character')).rejects.toThrow('叙事代词')

    await updateCharacterProfile('legacy-character', { narrativePronoun: 'ta' })
    await confirmCharacterPortrait('legacy-character')
    expect(await storyDatabase.characters.get('legacy-character')).toMatchObject({ narrativePronoun: 'ta', status: 'confirmed' })

    await updateCharacterProfile('legacy-character', { narrativePronoun: undefined })
    expect((await storyDatabase.characters.get('legacy-character'))?.narrativePronoun).toBeUndefined()
  })

  it('creates new drafts without inventing a narrative pronoun', async () => {
    const character = await createCharacterDraft(project.id, '新角色', '主角')
    expect(character.narrativePronoun).toBeUndefined()
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

      expect(upgraded.verno).toBe(12)
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
    chapterAction: 'continue' | 'new',
    paragraphs: string[],
    chapterSummary: string,
  ) {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写作', false)
    await completeWritingTurn(project.id, userMessage.id, notice.id, {
      kind: 'prose',
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
        kind: 'prose',
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
      text: '正在创作正文并整理视觉计划…',
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
  it('ignores a non-conforming visual plan in text-only mode', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '请开始写作', 'none')
    await completeWritingTurn(project.id, userMessage.id, notice.id, {
      ...writingResult,
      visualPlan: {
        title: '不应保存', prompt: '不应保存', stylePrompt: '', negativePrompt: '',
        characters: [{ name: '林昭', role: '主角', ageAndBuild: '青年', fixedTraits: ['黑发'], defaultLook: '清瘦', wardrobe: '灰外套' }],
      },
    }, 'none')
    expect(await storyDatabase.characters.where('projectId').equals(project.id).count()).toBe(0)
    expect(await storyDatabase.illustrations.where('projectId').equals(project.id).count()).toBe(0)
    expect((await storyDatabase.messages.where('projectId').equals(project.id).toArray()).some((message) => message.kind === 'illustration')).toBe(false)
  })

  it('keeps visual plans and characters when automatic illustration is disabled', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '请开始写作', false)
    const result: WritingTurnResult = {
      ...writingResult,
      visualPlan: {
        title: '雨夜', prompt: '雨夜街头', stylePrompt: '', negativePrompt: '',
        action: '撑伞穿过积水', bodyLanguage: '压低肩膀快步前行', expression: '神情紧绷', gaze: '望向巷口灯光', camera: '中景侧拍', motion: '雨水沿伞沿坠落',
        characters: [{ name: '林昭', role: '主角', narrativePronoun: 'she', ageAndBuild: '青年', fixedTraits: ['黑发'], defaultLook: '清瘦', wardrobe: '灰外套' }],
      },
    }
    await completeWritingTurn(project.id, userMessage.id, notice.id, result, false)
    expect(await storyDatabase.characters.where('projectId').equals(project.id).count()).toBe(1)
    expect(await storyDatabase.illustrations.where('projectId').equals(project.id).count()).toBe(1)
    expect((await storyDatabase.illustrations.where('projectId').equals(project.id).first())).toMatchObject({
      action: '撑伞穿过积水', bodyLanguage: '压低肩膀快步前行', expression: '神情紧绷', gaze: '望向巷口灯光', camera: '中景侧拍', motion: '雨水沿伞沿坠落',
      status: 'failed', failureKind: 'reference-unavailable',
      generationMode: 'manual',
    })
    expect(await storyDatabase.characters.where('projectId').equals(project.id).first()).toMatchObject({
      narrativePronoun: 'she',
      identity: { ageAndBuild: '青年', fixedTraits: ['黑发'] },
      appearance: { defaultLook: '清瘦', wardrobe: '灰外套' },
    })
  })

  it('fills only empty draft fields from a matching writing plan and leaves confirmed profiles authoritative', async () => {
    await storyDatabase.characters.add({
      id: 'draft-lin', projectId: project.id, name: '林染', role: '',
      identity: { ageAndBuild: '', fixedTraits: [] }, appearance: { defaultLook: '', wardrobe: '' },
      continuity: { revision: 0, referenceStyleMode: 'project' }, portraitStatus: 'planned', status: 'draft', createdAt: 1, updatedAt: 1,
    })
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写作', false)
    await completeWritingTurn(project.id, userMessage.id, notice.id, {
      ...writingResult,
      visualPlan: {
        title: '雨夜', prompt: '林染走进雨夜街头', stylePrompt: '', negativePrompt: '', characters: [{
          name: '林染', role: '主角', narrativePronoun: 'ta', ageAndBuild: '青年，身形修长', fixedTraits: ['齐肩黑发'], defaultLook: '眉眼清秀', wardrobe: '深色风衣',
        }],
      },
    }, false)
    expect(await storyDatabase.characters.get('draft-lin')).toMatchObject({
      role: '主角', narrativePronoun: 'ta',
      identity: { ageAndBuild: '青年，身形修长', fixedTraits: ['齐肩黑发'] },
      appearance: { defaultLook: '眉眼清秀', wardrobe: '深色风衣' },
    })

    await storyDatabase.characters.update('draft-lin', { status: 'confirmed', role: '用户确认身份', narrativePronoun: 'name' })
    const [secondUserMessage, secondNotice] = await beginWritingTurn(project.id, '继续写作', false)
    await completeWritingTurn(project.id, secondUserMessage.id, secondNotice.id, {
      ...writingResult,
      visualPlan: {
        title: '另一幕', prompt: '林染回头', stylePrompt: '', negativePrompt: '', characters: [{
          name: '林染', role: '模型身份', narrativePronoun: 'she', ageAndBuild: '模型年龄', fixedTraits: ['模型特征'], defaultLook: '模型外貌', wardrobe: '模型服装',
        }],
      },
    }, false)
    expect(await storyDatabase.characters.get('draft-lin')).toMatchObject({
      status: 'confirmed', role: '用户确认身份', narrativePronoun: 'name',
      identity: { ageAndBuild: '青年，身形修长', fixedTraits: ['齐肩黑发'] },
      appearance: { defaultLook: '眉眼清秀', wardrobe: '深色风衣' },
    })
  })

  it('restores only reference blockers, never ordinary image failures', async () => {
    await storyDatabase.illustrations.bulkAdd([
      { id: 'reference-blocked', projectId: project.id, title: '待确认', prompt: '场景', referenceCharacterIds: [], status: 'failed', failureKind: 'reference-unavailable', errorMessage: '参考图未确认', createdAt: 1, updatedAt: 1 },
      { id: 'image-failed', projectId: project.id, title: '模型失败', prompt: '场景', referenceCharacterIds: [], status: 'failed', errorMessage: '网络失败', createdAt: 1, updatedAt: 1 },
    ])
    expect(await restoreIllustrationsBlockedByReference(project.id, ['reference-blocked', 'image-failed'])).toBe(1)
    const restored = await storyDatabase.illustrations.get('reference-blocked')
    const imageFailed = await storyDatabase.illustrations.get('image-failed')
    expect(restored).toMatchObject({ status: 'planned' })
    expect(restored?.failureKind).toBeUndefined()
    expect(restored?.errorMessage).toBeUndefined()
    expect(imageFailed).toMatchObject({ status: 'failed', errorMessage: '网络失败' })
    expect(imageFailed?.failureKind).toBeUndefined()

    await setIllustrationBlockedByReference('image-failed', '参考图未确认')
    expect(await storyDatabase.illustrations.get('image-failed')).toMatchObject({ status: 'failed', failureKind: 'reference-unavailable' })
  })
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

describe('humanized prose persistence', () => {
  it('persists local diagnostics on stable message paragraphs', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写', false)
    await completeWritingTurn(project.id, userMessage.id, notice.id, {
      ...writingResult,
      paragraphs: ['她呼吸一滞，眸光一闪，指节泛白。'],
    }, false)
    const prose = await storyDatabase.messages.where('projectId').equals(project.id).filter((message) => message.kind === 'prose').first()
    const paragraph = await storyDatabase.paragraphs.where('[projectId+messageId]').equals([project.id, prose!.id]).first()
    expect(paragraph?.styleIssues?.map((issue) => issue.ruleId)).toContain('stock-physical-reaction')
  })

  it('applies a rewrite atomically to message, stable paragraph, chapter and current chapter index', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写', false)
    await completeWritingTurn(project.id, userMessage.id, notice.id, {
      ...writingResult,
      paragraphs: ['她呼吸一滞，眸光一闪。', '门外有人。'],
    }, false)
    const prose = await storyDatabase.messages.where('projectId').equals(project.id).filter((message) => message.kind === 'prose').first()
    const paragraph = await storyDatabase.paragraphs.where('[projectId+messageId]').equals([project.id, prose!.id]).first()
    await applyParagraphRewrite({
      projectId: project.id, messageId: prose!.id, paragraphId: paragraph!.id, paragraphIndex: 0,
      originalFingerprint: paragraph!.fingerprint, rewrittenText: '她把杯子推回桌子中央。',
    })
    expect((await storyDatabase.messages.get(prose!.id))?.paragraphs?.[0]).toBe('她把杯子推回桌子中央。')
    expect((await storyDatabase.paragraphs.get(paragraph!.id))?.text).toBe('她把杯子推回桌子中央。')
    const chapter = await storyDatabase.chapters.get(prose!.chapterId!)
    expect(chapter?.content).toContain('她把杯子推回桌子中央。')
    expect(await storyDatabase.paragraphs.where('[projectId+chapterId]').equals([project.id, prose!.chapterId!]).filter((row) => row.sourceType === 'chapter' && row.text === '她把杯子推回桌子中央。').count()).toBe(1)
  })

  it('rejects stale rewrite anchors without changing any body text', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写', false)
    await completeWritingTurn(project.id, userMessage.id, notice.id, writingResult, false)
    const prose = await storyDatabase.messages.where('projectId').equals(project.id).filter((message) => message.kind === 'prose').first()
    const paragraph = await storyDatabase.paragraphs.where('[projectId+messageId]').equals([project.id, prose!.id]).first()
    await expect(applyParagraphRewrite({ projectId: project.id, messageId: prose!.id, paragraphId: paragraph!.id, paragraphIndex: 0, originalFingerprint: 'stale', rewrittenText: '错误建议。' })).rejects.toThrow('发生变化')
    expect((await storyDatabase.messages.get(prose!.id))?.paragraphs?.[0]).toBe('第一段正文。')
  })

  it('refreshes missing or stale diagnostic versions without changing message anchors', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写', false)
    await completeWritingTurn(project.id, userMessage.id, notice.id, { ...writingResult, paragraphs: ['她呼吸一滞，眸光一闪。'] }, false)
    const prose = await storyDatabase.messages.where('projectId').equals(project.id).filter((message) => message.kind === 'prose').first()
    const stored = await storyDatabase.paragraphs.where('[projectId+messageId]').equals([project.id, prose!.id]).first()
    await storyDatabase.paragraphs.update(stored!.id, { styleIssues: [], styleRuleVersion: 0 })
    const refreshed = await listMessageParagraphsWithCurrentStyleIssues(project.id, prose!.id)
    expect(refreshed[0]).toMatchObject({ id: stored!.id, createdAt: stored!.createdAt, styleRuleVersion: PROSE_STYLE_RULE_VERSION })
    expect(refreshed[0].styleIssues?.map((issue) => issue.ruleId)).toContain('stock-physical-reaction')
  })
})

describe('style corpus persistence', () => {
  it('stores source, fragment and global binding separately and cascades source deletion', async () => {
    const rawText = '门外有人。\n\n她没有开门。'
    const sourceParagraphs = splitStyleCorpusText(rawText)
    const saved = await saveStyleCorpusImport({
      title: '悬疑对白', rawText,
      fragments: [
        { paragraphIds: [sourceParagraphs[0].id], text: '伪造文本', fingerprint: 'ignored', labels: { genres: ['悬疑'], sceneTypes: ['等待'] } },
        { paragraphIds: [sourceParagraphs[1].id], text: '伪造文本', fingerprint: 'ignored', labels: { techniques: ['动作留白'] } },
      ],
    })
    expect(saved.fragments).toHaveLength(2)
    expect(await storyDatabase.styleCorpusBindings.where('[scope+state]').equals(['global', 'enabled']).count()).toBe(2)
    expect((await listStyleCorpusFragments())[0].text).not.toContain('门外有人。\n\n她没有开门。')
    await deleteStyleCorpusSource(saved.source.id)
    expect(await storyDatabase.styleCorpusSources.count()).toBe(0)
    expect(await storyDatabase.styleCorpusFragments.count()).toBe(0)
    expect(await storyDatabase.styleCorpusBindings.count()).toBe(0)
  })

  it('does not delete global corpus data when deleting a project', async () => {
    const rawText = '雨停在窗外。'
    const [paragraph] = splitStyleCorpusText(rawText)
    await saveStyleCorpusImport({ title: '全局语料', rawText, fragments: [{ paragraphIds: [paragraph.id], text: '伪造文本', fingerprint: 'ignored' }] })
    await deleteProject(project.id)
    expect(await storyDatabase.styleCorpusSources.count()).toBe(1)
    expect(await storyDatabase.styleCorpusFragments.count()).toBe(1)
  })

  it('rebuilds combined fragment text from ids across different blank-line whitespace', async () => {
    const rawText = '第一段原文。\n \t\n第二段原文。\n\n\n第三段原文。'
    const paragraphs = splitStyleCorpusText(rawText)
    const saved = await saveStyleCorpusImport({
      title: '空白测试', rawText,
      fragments: [
        { paragraphIds: paragraphs.slice(0, 2).map((paragraph) => paragraph.id), text: 'UI 篡改文本', fingerprint: 'tampered' },
        { paragraphIds: [paragraphs[2].id], text: '另一段篡改文本', fingerprint: 'tampered' },
      ],
    })
    expect(saved.fragments.map((fragment) => fragment.text)).toEqual(['第一段原文。\n\n第二段原文。', '第三段原文。'])
    expect(saved.fragments[0].fingerprint).toBe(createParagraphFingerprint('第一段原文。\n\n第二段原文。'))
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

describe('writing turn stop and retry', () => {
  it('resolves an assistant-only turn without creating chapters, scenes, prose, summaries or visuals', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '打个招呼', false)

    await completeWritingTurn(project.id, userMessage.id, notice.id, { kind: 'assistant-only', assistantNote: '你好，我们先讨论设定。' }, false)

    const messages = await storyDatabase.messages.where('projectId').equals(project.id).toArray()
    expect(messages.find((message) => message.id === notice.id)).toMatchObject({ status: 'ready', text: '你好，我们先讨论设定。' })
    expect(messages.filter((message) => message.kind === 'prose')).toHaveLength(0)
    expect(await storyDatabase.chapters.count()).toBe(0)
    expect(await storyDatabase.scenes.count()).toBe(0)
    expect(await storyDatabase.paragraphs.count()).toBe(0)
    expect(await storyDatabase.summaryVersions.count()).toBe(0)
    expect(await storyDatabase.illustrations.count()).toBe(0)
  })

  it('marks a pending notice cancelled without writing prose and stays idempotent', async () => {
    const [, notice] = await beginWritingTurn(project.id, '继续写', false)

    await cancelWritingTurn(notice.id)
    expect(await storyDatabase.messages.get(notice.id)).toMatchObject({ status: 'cancelled', text: '已停止生成，未写入正文。' })
    expect(await storyDatabase.chapters.count()).toBe(0)
    expect(await storyDatabase.paragraphs.count()).toBe(0)

    await cancelWritingTurn(notice.id)
    expect((await storyDatabase.messages.get(notice.id))?.status).toBe('cancelled')
  })

  it('rejects a late completion after the notice was cancelled, writing nothing', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写', false)
    await cancelWritingTurn(notice.id)

    await expect(completeWritingTurn(project.id, userMessage.id, notice.id, writingResult, false)).rejects.toThrow('写作任务已经结束')
    expect(await storyDatabase.chapters.count()).toBe(0)
    expect(await storyDatabase.scenes.count()).toBe(0)
    expect(await storyDatabase.paragraphs.count()).toBe(0)
    expect(await storyDatabase.illustrations.count()).toBe(0)
    expect((await storyDatabase.messages.get(notice.id))?.status).toBe('cancelled')
  })

  it('retry reuses the original user message and notice without duplicating the user bubble', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写', false)
    await failWritingTurn(notice.id, '网络失败')
    const userCountBefore = (await storyDatabase.messages.toArray()).filter((message) => message.kind === 'user').length

    const retry = await retryWritingTurn(project.id, notice.id)
    expect(retry.userText).toBe('继续写')
    expect(retry.illustrationMode).toBe('manual')
    expect((await storyDatabase.messages.toArray()).filter((message) => message.kind === 'user')).toHaveLength(userCountBefore)
    expect(await storyDatabase.messages.get(notice.id)).toMatchObject({ status: 'pending', backgroundTaskId: '' })
    expect(userMessage.id).toBeTruthy()
  })

  it('rejects a result whose background task no longer matches the linked task', async () => {
    const [userMessage, notice] = await beginWritingTurn(project.id, '继续写', false)
    await setWritingTurnBackgroundTask(notice.id, 'task-old')
    await expect(completeWritingTurn(project.id, userMessage.id, notice.id, writingResult, false, false, 'task-new')).rejects.toThrow('后台写作结果不属于当前任务')
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
