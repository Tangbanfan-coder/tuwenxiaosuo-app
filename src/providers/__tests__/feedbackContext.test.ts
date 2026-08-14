import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  Chapter,
  ConversationMessage,
  FeedbackTargetInput,
  ProjectWorkspace,
  StoryProject,
} from '../../domain/models'
import { createParagraphFingerprint } from '../../domain/paragraphs'
import {
  storyDatabase,
  upsertFeedback,
} from '../../data/storyDatabase'
import { generateWritingTurn, previewWritingTurnBudget } from '../writing'
import { resolveTokenEstimator } from '../tokenEstimator'
import type { HttpTransport, ProviderConfig, TransportRequest } from '../types'

const provider: ProviderConfig = {
  id: 'feedback-context-test',
  name: 'Feedback Context Test',
  baseUrl: 'https://example.test/v1',
  model: 'deepseek-chat',
  protocol: 'openai-compatible',
  secretRef: 'provider:text',
  manualContextLength: 128_000,
  manualMaxOutputTokens: 1_000,
}

const validResult = JSON.stringify({
  assistant_note: 'ok',
  chapter_action: 'continue',
  prose: { chapter_title: '反馈测试', paragraphs: ['新正文。'] },
  visual_plan: null,
})

function captureTransport(onBody: (body: Record<string, unknown>) => void): HttpTransport {
  return {
    async request<T>(request: TransportRequest) {
      onBody(JSON.parse(String(request.body)) as Record<string, unknown>)
      return { status: 200, data: { choices: [{ message: { content: validResult } }] } as T }
    },
    async stream() {
      return validResult
    },
  }
}

const noRetrieval = { retrieve: async () => [] }

function project(overrides: Partial<StoryProject> = {}): StoryProject {
  return {
    id: 'feedback-context-project',
    title: '反馈上下文测试作品',
    themeId: 'neutral',
    activeChapterId: 'feedback-chapter-1',
    autoIllustrate: false,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    ...overrides,
  }
}

function chapter(order = 1, summary = ''): Chapter {
  return {
    id: `feedback-chapter-${order}`,
    projectId: 'feedback-context-project',
    title: order === 1 ? '雨夜追逐' : `历史章节${order}`,
    order,
    content: '',
    status: 'draft',
    summary: summary || undefined,
    createdAt: order,
    updatedAt: order,
  }
}

function workspace(projectValue: StoryProject, chapters: Chapter[], messages: ConversationMessage[] = []): ProjectWorkspace {
  return {
    project: projectValue,
    messages,
    chapters,
    characters: [],
    illustrations: [],
    style: undefined,
  }
}

async function seedBaseWorkspace(options: { paragraphs?: string[]; project?: StoryProject } = {}) {
  const projectValue = options.project ?? project()
  const currentChapter = chapter()
  const messages: ConversationMessage[] = []
  await storyDatabase.projects.add(projectValue)
  await storyDatabase.chapters.add(currentChapter)

  if (options.paragraphs?.length) {
    const message: ConversationMessage = {
      id: 'feedback-message-1',
      projectId: projectValue.id,
      chapterId: currentChapter.id,
      kind: 'prose',
      order: 1,
      createdAt: 2,
      paragraphs: options.paragraphs,
      status: 'ready',
    }
    messages.push(message)
    await storyDatabase.messages.add(message)
    await storyDatabase.paragraphs.bulkAdd(options.paragraphs.map((text, index) => ({
      id: `feedback-paragraph-${index}`,
      projectId: projectValue.id,
      sourceType: 'message' as const,
      messageId: message.id,
      chapterId: currentChapter.id,
      index,
      text,
      fingerprint: createParagraphFingerprint(text),
      createdAt: message.createdAt,
    })))
  }

  return { project: projectValue, chapter: currentChapter, messages }
}

async function addFeedback(target: FeedbackTargetInput, verdict: 'up' | 'down', reason?: string, customNote?: string) {
  return upsertFeedback({ ...target, verdict, reason, customNote })
}

function sectionTokens(plan: Awaited<ReturnType<typeof previewWritingTurnBudget>>, key: string) {
  return plan.sections.find((section) => section.key === key)?.tokens ?? 0
}

beforeEach(async () => {
  await Promise.all([
    storyDatabase.feedback.clear(),
    storyDatabase.paragraphs.clear(),
    storyDatabase.messages.clear(),
    storyDatabase.chapters.clear(),
    storyDatabase.projects.clear(),
  ])
})

describe('近期偏好反馈上下文', () => {
  it('空反馈不生成反馈 section', async () => {
    const seeded = await seedBaseWorkspace()
    const currentWorkspace = workspace(seeded.project, [seeded.chapter])
    const plan = await previewWritingTurnBudget(currentWorkspace, '继续写作', provider, { retriever: noRetrieval })

    expect(sectionTokens(plan, 'feedback')).toBe(0)
    let body: Record<string, unknown> = {}
    await generateWritingTurn(currentWorkspace, '继续写作', provider, captureTransport((value) => { body = value }), undefined, { retriever: noRetrieval })
    const context = String((body.messages as Array<{ content: string }>)[1]?.content)
    expect(context).not.toContain('近期偏好反馈')
  })

  it('渲染消息与段落反馈的覆盖关系，并隐藏完整目标段落原文', async () => {
    const targetParagraph = '这是一段需要保持短句节奏的完整目标段落，绝不能逐字注入反馈上下文。'
    const siblingParagraph = '另一段需要调整拖沓表达的正文。'
    const seeded = await seedBaseWorkspace({ paragraphs: [targetParagraph, siblingParagraph] })
    const messageTarget: FeedbackTargetInput = {
      projectId: seeded.project.id,
      messageId: seeded.messages[0]!.id,
      chapterId: seeded.chapter.id,
      scope: 'message',
    }
    await addFeedback(messageTarget, 'up', '整体节奏稳定', '保持冷静克制的叙述')
    await addFeedback({
      ...messageTarget,
      scope: 'paragraph',
      paragraphId: 'feedback-paragraph-0',
      paragraphIndex: 0,
      paragraphFingerprint: createParagraphFingerprint(targetParagraph),
    }, 'down', '这一段需要更紧凑')

    const currentWorkspace = workspace(seeded.project, [seeded.chapter], seeded.messages)
    const userRequest = '继续写雨夜追逐'
    const preview = await previewWritingTurnBudget(currentWorkspace, userRequest, provider, { retriever: noRetrieval })
    let body: Record<string, unknown> = {}
    await generateWritingTurn(currentWorkspace, userRequest, provider, captureTransport((value) => { body = value }), undefined, { retriever: noRetrieval })
    const context = String((body.messages as Array<{ content: string }>)[1]?.content)
    const estimator = resolveTokenEstimator({ protocol: provider.protocol, providerId: provider.id, model: provider.model })

    expect(context).toContain('近期偏好反馈')
    expect(context).toContain('点踩——避免/调整')
    expect(context).toContain('点赞——保持此风格')
    expect(context).toContain('消息级（仅适用于同一消息中未单独标注的其他段落）')
    expect(context).toContain('第1段（段落级反馈优先于消息级）')
    expect(context).toContain('自定义说明（优先）')
    expect(context).not.toContain(targetParagraph)
    expect(sectionTokens(preview, 'feedback')).toBeGreaterThan(0)
    expect(preview.serializedContextTokens).toBe(Math.ceil(estimator.estimator.estimate(context)))
    const previewAfterSend = await previewWritingTurnBudget(currentWorkspace, userRequest, provider, { retriever: noRetrieval })
    expect(previewAfterSend).toEqual(preview)
  })

  it('压力进入 critical 时仅保留高优先点踩反馈', async () => {
    const seeded = await seedBaseWorkspace({ paragraphs: ['点踩目标段落。'] })
    const messageTarget: FeedbackTargetInput = {
      projectId: seeded.project.id,
      messageId: seeded.messages[0]!.id,
      chapterId: seeded.chapter.id,
      scope: 'paragraph',
      paragraphId: 'feedback-paragraph-0',
      paragraphIndex: 0,
      paragraphFingerprint: createParagraphFingerprint('点踩目标段落。'),
    }
    await addFeedback(messageTarget, 'up', undefined, '保持此风格')
    await addFeedback({ ...messageTarget, paragraphId: 'feedback-paragraph-0', paragraphIndex: 0 }, 'down', undefined, '避免拖沓')

    const overloadedChapters = [
      seeded.chapter,
      ...Array.from({ length: 10 }, (_, index) => chapter(index + 2, `历史资料${index}。`.repeat(300))),
    ]
    const currentWorkspace = workspace(seeded.project, overloadedChapters, seeded.messages)
    const criticalProvider = { ...provider, manualContextLength: 24_000, manualMaxOutputTokens: 500 }
    const plan = await previewWritingTurnBudget(currentWorkspace, '继续写作', criticalProvider, { retriever: noRetrieval })
    expect(plan.compressionStage).toBe('critical')

    let body: Record<string, unknown> = {}
    await generateWritingTurn(currentWorkspace, '继续写作', criticalProvider, captureTransport((value) => { body = value }), undefined, { retriever: noRetrieval })
    const context = String((body.messages as Array<{ content: string }>)[1]?.content)
    expect(context).toContain('点踩——避免/调整')
    expect(context).not.toContain('点赞——保持此风格')
  })
})
