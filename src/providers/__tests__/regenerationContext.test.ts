import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectWorkspace, StoredParagraph } from '../../domain/models'
import { createParagraphFingerprint } from '../../domain/paragraphs'
import { storyDatabase, upsertChapterParagraphs } from '../../data/storyDatabase'
import { generateWritingTurn } from '../writing'
import type { HttpTransport, ProviderConfig, TransportRequest } from '../types'

const provider: ProviderConfig = {
  id: 'regeneration-context', name: 'Regeneration Context', baseUrl: 'https://example.test/v1', model: 'test-model',
  protocol: 'openai-compatible', secretRef: 'provider:text', manualContextLength: 64_000, manualMaxOutputTokens: 1_000,
}

const result = JSON.stringify({
  assistant_note: '完成', chapter_action: 'continue', prose: { chapter_title: '第一章', paragraphs: ['候选正文。'] }, visual_plan: null,
})

beforeEach(async () => {
  await Promise.all([
    storyDatabase.preferenceSignals.clear(), storyDatabase.styleCorpusBindings.clear(), storyDatabase.styleCorpusFragments.clear(),
    storyDatabase.styleCorpusSources.clear(), storyDatabase.paragraphs.clear(), storyDatabase.scenes.clear(), storyDatabase.messages.clear(),
    storyDatabase.chapters.clear(), storyDatabase.projects.clear(),
  ])
})

describe('regeneration context exclusions', () => {
  it('removes the replaced scene and old prose from retrieval while retaining the pre-turn chapter prefix', async () => {
    const project = { id: 'project-regen', title: '重生成测试', themeId: 'neutral' as const, activeChapterId: 'chapter-regen', illustrationMode: 'none' as const, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 }
    const currentChapter = { id: 'chapter-regen', projectId: project.id, title: '第一章', order: 1, content: '生成前正文。\n\n需要排除的旧版正文。', status: 'draft' as const, createdAt: 1, updatedAt: 2 }
    const oldProse = { id: 'prose-old', projectId: project.id, chapterId: currentChapter.id, kind: 'prose' as const, order: 3, createdAt: 3, paragraphs: ['需要排除的旧版正文。'], status: 'ready' as const, turnId: 'turn-old' }
    await storyDatabase.projects.add(project)
    await storyDatabase.chapters.add(currentChapter)
    await storyDatabase.messages.add(oldProse)
    await upsertChapterParagraphs(currentChapter)
    await storyDatabase.paragraphs.add({ id: 'paragraph-old-message', projectId: project.id, sourceType: 'message', messageId: oldProse.id, chapterId: currentChapter.id, index: 0, text: oldProse.paragraphs[0], fingerprint: createParagraphFingerprint(oldProse.paragraphs[0]), createdAt: 3 })
    await storyDatabase.scenes.bulkAdd([
      { id: 'scene-prior', projectId: project.id, chapterId: currentChapter.id, order: 1, createdAt: 1, notes: { charactersPresent: [], events: ['生成前事件'], stateChanges: [], relationshipChanges: [], knowledgeChanges: [], foreshadowingPlanted: [], resolvedForeshadowingIds: [], unresolvedThreads: [] }, excerpt: '生成前事件' },
      { id: 'scene-old', projectId: project.id, chapterId: currentChapter.id, order: 2, createdAt: 2, notes: { charactersPresent: [], events: ['旧版事件'], stateChanges: [], relationshipChanges: [], knowledgeChanges: [], foreshadowingPlanted: [], resolvedForeshadowingIds: [], unresolvedThreads: [] }, excerpt: '旧版事件', turnId: 'turn-old' },
    ])
    const strippedChapter = { ...currentChapter, content: '生成前正文。' }
    const workspace: ProjectWorkspace = { project, chapters: [strippedChapter], messages: [], characters: [], illustrations: [] }
    let retrievable: readonly StoredParagraph[] = []
    let retrievalQuery = ''
    let serializedContext = ''
    const transport: HttpTransport = {
      async request<T>(request: TransportRequest) {
        const payload = JSON.parse(String(request.body)) as { messages?: Array<{ content?: string }> }
        serializedContext = payload.messages?.[1]?.content ?? ''
        return { status: 200, data: { choices: [{ message: { content: result } }] } as T }
      },
      async stream() { return result },
    }

    await generateWritingTurn(workspace, '重新完成最近一轮', provider, transport, undefined, {
      retriever: { async retrieve(request) { retrievable = request.paragraphs; retrievalQuery = request.query; return [] } },
      regeneration: { turnId: 'turn-old', proseMessageId: oldProse.id, chapterId: currentChapter.id, baseParagraphCount: 1 },
    })

    expect(retrievable.map((paragraph) => paragraph.text)).toContain('生成前正文。')
    expect(retrievable.map((paragraph) => paragraph.text)).not.toContain('需要排除的旧版正文。')
    expect(retrievalQuery).not.toContain('旧版事件')
    expect(serializedContext).toContain('生成前事件')
    expect(serializedContext).not.toContain('旧版事件')
  })
})
