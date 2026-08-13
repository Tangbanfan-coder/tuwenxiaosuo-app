import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Chapter, ProjectWorkspace, StoryProject, StoredParagraph } from '../../domain/models'
import { createParagraphFingerprint } from '../../domain/paragraphs'
import {
  listRetrievableProjectParagraphs,
  storyDatabase,
  upsertChapterParagraphs,
  type StoredScene,
} from '../../data/storyDatabase'
import {
  buildContextBudgetPlan,
  buildProjectContext,
  generateWritingTurn,
  type ContextCompressionStage,
} from '../writing'
import { BigramBm25Retriever, scoreBigramBm25, tokenizeForBm25, type RetrievedParagraph, type Retriever } from '../retriever'
import { resolveTokenEstimator } from '../tokenEstimator'
import type { HttpTransport, ProviderConfig, TransportRequest } from '../types'

function paragraph(id: string, text: string, index = 0): StoredParagraph {
  return {
    id,
    projectId: 'project-1',
    sourceType: 'chapter',
    chapterId: 'chapter-1',
    index,
    text,
    fingerprint: createParagraphFingerprint(text),
    createdAt: 1,
  }
}

describe('BigramBm25Retriever', () => {
  it('exposes the single stable BM25 scoring core for other local corpora', () => {
    const scored = scoreBigramBm25('rare common', [
      { value: 'common-1', text: 'common', sourceIndex: 0 },
      { value: 'rare', text: 'rare', sourceIndex: 1 },
      { value: 'common-2', text: 'common', sourceIndex: 2 },
    ])
    expect(scored.map((item) => item.value)).toEqual(['rare', 'common-1', 'common-2'])
    expect(scored[0].score).toBeGreaterThan(scored[1].score)
  })
  it('uses Chinese character bigrams and preserves English/number words', async () => {
    expect(tokenizeForBm25('银色钥匙 Version42')).toEqual([
      'zh:银色', 'zh:色钥', 'zh:钥匙', 'word:version42',
    ])
    expect(tokenizeForBm25('林')).toEqual(['zh1:林'])

    const retriever = new BigramBm25Retriever()
    const results = await retriever.retrieve({
      query: '寻找银色钥匙 version42',
      paragraphs: [
        paragraph('hit', '银色钥匙的编号是 Version42。'),
        paragraph('miss', '铜制门环没有编号。', 1),
      ],
      topK: 5,
    })

    expect(results.map((result) => result.paragraphId)).toEqual(['hit'])
    expect(results[0]).toMatchObject({
      projectId: 'project-1',
      sourceType: 'chapter',
      chapterId: 'chapter-1',
      paragraphIndex: 0,
      text: '银色钥匙的编号是 Version42。',
    })

    await expect(retriever.retrieve({
      query: '林',
      paragraphs: [paragraph('single-han-hit', '林昭握紧了钥匙。')],
    })).resolves.toMatchObject([{ paragraphId: 'single-han-hit' }])
  })

  it('uses BM25 term frequency, inverse document frequency, and length normalization', async () => {
    const retriever = new BigramBm25Retriever()
    const frequencyAndLength = await retriever.retrieve({
      query: 'orb',
      paragraphs: [
        paragraph('long', `orb ${'filler '.repeat(30)}`),
        paragraph('repeated', 'orb orb orb'),
        paragraph('short', 'orb'),
      ],
      topK: 10,
    })
    expect(frequencyAndLength.map((result) => result.paragraphId)).toEqual(['repeated', 'short', 'long'])
    expect(frequencyAndLength[0]!.score).toBeGreaterThan(frequencyAndLength[1]!.score)
    expect(frequencyAndLength[1]!.score).toBeGreaterThan(frequencyAndLength[2]!.score)

    const inverseFrequency = await retriever.retrieve({
      query: 'rare common',
      paragraphs: [
        paragraph('common-1', 'common'),
        paragraph('rare', 'rare'),
        paragraph('common-2', 'common'),
      ],
      topK: 10,
    })
    expect(inverseFrequency.map((result) => result.paragraphId)).toEqual(['rare', 'common-1', 'common-2'])
    expect(inverseFrequency[0]!.score).toBeGreaterThan(inverseFrequency[1]!.score)
  })

  it('returns no hit for unrelated text, preserves tie order, and applies topK/text budgets', async () => {
    const retriever: Retriever = new BigramBm25Retriever()
    await expect(retriever.retrieve({ query: '不存在', paragraphs: [paragraph('one', '完全无关的正文。')] })).resolves.toEqual([])

    const tied = await retriever.retrieve({
      query: 'moon',
      paragraphs: [paragraph('first', 'moon'), paragraph('second', 'moon', 1)],
      topK: 10,
    })
    expect(tied.map((result) => result.paragraphId)).toEqual(['first', 'second'])

    const constrained = await retriever.retrieve({
      query: 'match',
      paragraphs: [paragraph('budget-first', 'match a'), paragraph('budget-second', 'match b', 1)],
      topK: 1,
      maxTotalCharacters: 7,
    })
    expect(constrained.map((result) => result.paragraphId)).toEqual(['budget-first'])
    expect((await retriever.retrieve({
      query: 'match',
      paragraphs: [paragraph('too-long', 'match a')],
      maxTotalCharacters: 6,
    }))).toEqual([])
  })

  it('rejects fingerprint-drift records even when the input bypasses the database query', async () => {
    const corrupted = { ...paragraph('drift', '银色钥匙在这里。'), fingerprint: 'corrupted' }
    await expect(new BigramBm25Retriever().retrieve({ query: '银色钥匙', paragraphs: [corrupted] })).resolves.toEqual([])
  })
})

const project: StoryProject = {
  id: 'writing-retrieval-project',
  title: '检索注入测试',
  themeId: 'neutral',
  autoIllustrate: false,
  activeChapterId: 'chapter-current',
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
}

const provider: ProviderConfig = {
  id: 'retrieval-test',
  name: 'Retrieval Test',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  protocol: 'openai-compatible',
  secretRef: 'provider:text',
  manualContextLength: 128_000,
  manualMaxOutputTokens: 512,
}

const validResponse = JSON.stringify({
  assistant_note: 'ok',
  chapter_action: 'continue',
  prose: { chapter_title: '第二章', paragraphs: ['新正文。'] },
  visual_plan: null,
})

async function clearStoryDatabase() {
  await Promise.all([
    storyDatabase.paragraphs.clear(),
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
  await clearStoryDatabase()
})

function workspace(chapters: Chapter[]): ProjectWorkspace {
  return {
    project: { ...project },
    messages: [],
    chapters,
    characters: [],
    illustrations: [],
    style: undefined,
  }
}

function scene(): StoredScene {
  return {
    id: 'scene-with-stale-excerpt',
    projectId: project.id,
    chapterId: 'chapter-current',
    order: 1,
    createdAt: 1,
    notes: {
      time: '清晨',
      location: '城门',
      povCharacter: '林昭',
      charactersPresent: ['林昭'],
      events: ['准备离城'],
      stateChanges: [],
      relationshipChanges: [],
      knowledgeChanges: [],
      foreshadowingPlanted: [],
      resolvedForeshadowingIds: [],
      unresolvedThreads: [],
    },
    excerpt: '过时摘要专用标记：这里绝不能作为检索原文。',
  }
}

function captureTransport(onRequest: (request: TransportRequest) => void): HttpTransport {
  return {
    async request<T>(request: TransportRequest) {
      onRequest(request)
      return { status: 200, data: { choices: [{ message: { content: validResponse } }] } as T }
    },
    async stream() {
      return validResponse
    },
  }
}

describe('writing paragraph retrieval integration', () => {
  it('progressively reduces low-priority retained tokens while preserving critical facts and whole anchors', () => {
    const current: Chapter = {
      id: 'chapter-current',
      projectId: project.id,
      title: '城门',
      order: 12,
      content: '城门外的风雪压低了林昭的斗篷。'.repeat(700),
      summary: '林昭持银色钥匙抵达北境城门，必须在天亮前找到守门人的信物。',
      status: 'draft',
      createdAt: 1,
      updatedAt: 1,
    }
    const historical = Array.from({ length: 10 }, (_, index): Chapter => ({
      id: `chapter-history-${index}`,
      projectId: project.id,
      title: `旧章 ${index + 1}`,
      order: index + 1,
      content: '',
      summary: `第 ${index + 1} 章的历史提要。`.repeat(8),
      status: 'draft',
      createdAt: index + 1,
      updatedAt: index + 1,
    }))
    const scenes: StoredScene[] = Array.from({ length: 24 }, (_, index) => ({
      id: `compression-scene-${index}`,
      projectId: project.id,
      chapterId: current.id,
      order: index + 1,
      createdAt: index + 1,
      notes: {
        time: `第 ${index + 1} 夜`,
        location: '北境城门',
        povCharacter: '林昭',
        charactersPresent: ['林昭'],
        events: [`事件 ${index + 1}：${'风雪与钟声。'.repeat(16)}`],
        stateChanges: index === 23 ? [{ character: '林昭', aspect: '位置', state: '城门外' }] : [],
        relationshipChanges: [],
        knowledgeChanges: [],
        foreshadowingPlanted: index === 0 ? [{ id: 'foreshadowing-critical', text: '银色钥匙会在钟声后开启暗门。' }] : [],
        resolvedForeshadowingIds: [],
        unresolvedThreads: [`线索 ${index + 1}`],
      },
      excerpt: '',
    }))
    const currentWorkspace: ProjectWorkspace = {
      ...workspace([...historical, current]),
      project: {
        ...project,
        activeChapterId: current.id,
        writingInstructions: '核心规则：保持第三人称有限视角；不得改写已确认事实。',
      },
      messages: Array.from({ length: 8 }, (_, index) => ({
        id: `old-message-${index}`,
        projectId: project.id,
        chapterId: historical[Math.min(index, historical.length - 1)]?.id,
        kind: 'user' as const,
        order: index,
        createdAt: index,
        text: `早期对话 ${index}：${'补充的低优先级讨论。'.repeat(45)}`,
      })),
    }
    const anchors: RetrievedParagraph[] = Array.from({ length: 5 }, (_, index) => ({
      paragraphId: `paragraph-anchor-${index}`,
      projectId: project.id,
      sourceType: 'chapter' as const,
      chapterId: historical[index]?.id ?? current.id,
      paragraphIndex: 0,
      fingerprint: createParagraphFingerprint(`完整检索原文 ${index}`),
      text: `完整检索原文 ${index}：${'钥匙与钟声。'.repeat(20)}`,
      score: 5 - index,
    }))
    const stages: ContextCompressionStage[] = ['normal', 'organizing', 'compressed', 'critical']
    const staged = stages.map((compressionStage) => {
      const built = buildProjectContext(
        currentWorkspace,
        scenes,
        24_000,
        '继续写林昭在北境城门前寻找暗门。',
        anchors,
        { compressionStage },
      )
      const plan = buildContextBudgetPlan({
        windowTokens: 128_000,
        contextBudget: 'standard',
        outputReserveTokens: 1_000,
        safetyMarginTokens: 1_000,
        systemPrompt: 'system',
        projectWorkspace: built.contextSections.projectWorkspace,
        coreMemory: built.contextSections.coreMemory,
        timelineRetrievedContext: built.contextSections.timelineRetrievedContext,
        recentMessages: built.contextSections.recentMessages,
        userMessage: '继续写林昭在北境城门前寻找暗门。',
        serializedContext: `当前作品资料：${built.context}`,
        estimator: resolveTokenEstimator({ protocol: provider.protocol, providerId: provider.id, model: provider.model }),
      })
      return { built, plan }
    })
    const retainedTokens = (key: 'timelineRetrievedContext' | 'recentMessages') => staged.map((entry) => (
      entry.plan.sections.find((section) => section.key === key)?.tokens ?? 0
    ))

    for (const tokens of [retainedTokens('timelineRetrievedContext'), retainedTokens('recentMessages')]) {
      expect(tokens.every((value, index) => index === 0 || value <= tokens[index - 1]!)).toBe(true)
    }
    for (const { built } of staged) {
      expect(built.contextSections.projectWorkspace).toContain('核心规则：保持第三人称有限视角')
      expect(built.contextSections.projectWorkspace).toContain('当前章节：第12章 城门')
    }
    expect(staged[3]?.built.contextSections.coreMemory).toContain('[foreshadowing-critical]')

    for (const { built } of staged) {
      const timeline = built.contextSections.timelineRetrievedContext
      for (const anchor of anchors) {
        if (!timeline.includes(`段落 ID：${anchor.paragraphId}`)) continue
        expect(timeline).toContain(`位置：第${historical[Number(anchor.paragraphId.at(-1))]?.order}章《${historical[Number(anchor.paragraphId.at(-1))]?.title}》，第1段`)
        expect(timeline).toContain(`原文：${anchor.text}`)
      }
    }

    const oversized = { ...anchors[0]!, text: '过长锚点原文。'.repeat(8_000) }
    const constrained = buildProjectContext(
      currentWorkspace,
      scenes,
      1_500,
      '继续写',
      [oversized],
      { compressionStage: 'critical' },
    )
    expect(constrained.contextSections.timelineRetrievedContext).not.toContain(`段落 ID：${oversized.paragraphId}`)
  })

  it('injects anchored original paragraphs rather than StoredScene.excerpt and accounts for them in timelineRetrievedContext', async () => {
    const historical: Chapter = {
      id: 'chapter-history',
      projectId: project.id,
      title: '旧钥匙',
      order: 1,
      content: '林昭摸到银色钥匙，钥匙背面刻着北境旧徽。',
      status: 'draft',
      createdAt: 1,
      updatedAt: 1,
    }
    const current: Chapter = {
      id: 'chapter-current',
      projectId: project.id,
      title: '城门',
      order: 2,
      content: '清晨的城门尚未开启。',
      status: 'draft',
      createdAt: 2,
      updatedAt: 2,
    }
    const currentWorkspace = workspace([historical, current])
    const oldScene = scene()
    await storyDatabase.projects.add({ ...project })
    await storyDatabase.chapters.bulkAdd([historical, current])
    await Promise.all([upsertChapterParagraphs(historical), upsertChapterParagraphs(current)])
    await storyDatabase.scenes.add(oldScene)

    const userRequest = '让林昭回忆银色钥匙的来历。'
    const retriever = new BigramBm25Retriever()
    const retrieved = await retriever.retrieve({
      query: userRequest,
      paragraphs: await listRetrievableProjectParagraphs(project.id),
      topK: 5,
    })
    const withRetrieval = buildProjectContext(currentWorkspace, [oldScene], 50_000, userRequest, retrieved)
    const withoutRetrieval = buildProjectContext(currentWorkspace, [oldScene], 50_000, userRequest)
    const estimator = resolveTokenEstimator({ protocol: provider.protocol, providerId: provider.id, model: provider.model })
    const planWith = buildContextBudgetPlan({
      windowTokens: 32_000,
      contextBudget: 'standard',
      outputReserveTokens: 1_000,
      safetyMarginTokens: 1_000,
      systemPrompt: 'system',
      timelineRetrievedContext: withRetrieval.contextSections.timelineRetrievedContext,
      userMessage: userRequest,
      serializedContext: `当前作品资料：${withRetrieval.context}`,
      estimator,
    })
    const planWithout = buildContextBudgetPlan({
      windowTokens: 32_000,
      contextBudget: 'standard',
      outputReserveTokens: 1_000,
      safetyMarginTokens: 1_000,
      systemPrompt: 'system',
      timelineRetrievedContext: withoutRetrieval.contextSections.timelineRetrievedContext,
      userMessage: userRequest,
      serializedContext: `当前作品资料：${withoutRetrieval.context}`,
      estimator,
    })
    const withTokens = planWith.sections.find((section) => section.key === 'timelineRetrievedContext')?.tokens ?? 0
    const withoutTokens = planWithout.sections.find((section) => section.key === 'timelineRetrievedContext')?.tokens ?? 0
    expect(withRetrieval.contextSections.timelineRetrievedContext).toContain('段落 ID：paragraph-chapter-chapter-history-')
    expect(withTokens).toBeGreaterThan(withoutTokens)

    let requestContext = ''
    await generateWritingTurn(currentWorkspace, userRequest, provider, captureTransport((request) => {
      const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> }
      requestContext = body.messages[1]?.content ?? ''
    }))

    expect(requestContext).toContain('检索出的相关历史片段')
    expect(requestContext).toContain('段落 ID：paragraph-chapter-chapter-history-')
    expect(requestContext).toContain('位置：第1章《旧钥匙》，第1段')
    expect(requestContext).toContain(historical.content)
    expect(requestContext).not.toContain('过时摘要专用标记')
  })

  it('omits an oversized retrieval record as a whole instead of sending a partial anchor', async () => {
    const chapter: Chapter = {
      id: 'chapter-current',
      projectId: project.id,
      title: '当前章',
      order: 1,
      content: '当前正文。',
      status: 'draft',
      createdAt: 1,
      updatedAt: 1,
    }
    const anchoredId = 'paragraph-chapter-history-anchor-0'
    const original = '这是需要裁剪但必须保留锚点的历史原文。'.repeat(1_000)
    const constrainedProvider = { ...provider, manualContextLength: 8_000, manualMaxOutputTokens: 512 }
    const replacement: Retriever = {
      async retrieve() {
        return [{
          paragraphId: anchoredId,
          projectId: project.id,
          sourceType: 'chapter',
          chapterId: chapter.id,
          paragraphIndex: 0,
          fingerprint: createParagraphFingerprint(original),
          text: original,
          score: 1,
        }]
      },
    }
    let requestContext = ''
    await generateWritingTurn(workspace([chapter]), '继续写银色钥匙', constrainedProvider, captureTransport((request) => {
      const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> }
      requestContext = body.messages[1]?.content ?? ''
    }), undefined, { retriever: replacement })

    expect(requestContext).not.toContain('检索出的相关历史片段')
    expect(requestContext).not.toContain(`段落 ID：${anchoredId}`)
    expect(requestContext).not.toContain(`位置：第1章《当前章》，第1段`)
    expect(requestContext).not.toContain(original)
  })

  it('accepts a replacement Retriever while retaining the same prompt location structure', async () => {
    const chapter: Chapter = {
      id: 'chapter-current',
      projectId: project.id,
      title: '当前章',
      order: 1,
      content: '当前正文。',
      status: 'draft',
      createdAt: 1,
      updatedAt: 1,
    }
    await storyDatabase.projects.add({ ...project, activeChapterId: chapter.id })
    await storyDatabase.chapters.add(chapter)
    await upsertChapterParagraphs(chapter)
    const replacement: Retriever = {
      async retrieve() {
        return [{
          paragraphId: 'semantic-ready-paragraph',
          projectId: project.id,
          sourceType: 'chapter',
          chapterId: chapter.id,
          paragraphIndex: 0,
          fingerprint: createParagraphFingerprint('替换实现返回的原文。'),
          text: '替换实现返回的原文。',
          score: 1,
        }]
      },
    }

    let requestContext = ''
    await generateWritingTurn(workspace([chapter]), '继续写', provider, captureTransport((request) => {
      const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> }
      requestContext = body.messages[1]?.content ?? ''
    }), undefined, { retriever: replacement })

    expect(requestContext).toContain('段落 ID：semantic-ready-paragraph')
    expect(requestContext).toContain('位置：第1章《当前章》，第1段')
    expect(requestContext).toContain('替换实现返回的原文。')
  })
})
