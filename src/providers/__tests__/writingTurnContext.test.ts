import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { computeWritingTurnContext } from '../writing/writingTurnContext'
import type { ConversationMessage, ProjectWorkspace } from '../../domain/models'
import type { ProviderConfig } from '../types'

const textProvider: ProviderConfig = {
  id: 'test',
  name: 'Test',
  baseUrl: 'https://example/v1',
  model: 'deepseek-chat',
  protocol: 'openai-compatible',
  secretRef: 'provider:text',
}

const emptyWorkspace = () => ({
  project: {
    id: 'project-1',
    title: '测试作品',
    themeId: 'neutral' as const,
    autoIllustrate: false,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
  },
  messages: [],
  chapters: [],
  characters: [],
  illustrations: [],
  style: undefined,
})

/**
 * Regression guard for the two invariants that mock-based worker tests cannot
 * cover: (1) the pure computation produces a valid plan, and (2) the result
 * survives structuredClone — the worker posts it back through postMessage, so
 * any non-cloneable field (function/class instance) would break the worker path
 * silently while the main thread path kept working. Also guards
 * excludeUserMessageId (retry must not inject the requirement twice).
 */
describe('computeWritingTurnContext 纯函数', () => {
  it('返回合法 plan，且结果可 structuredClone、深相等', () => {
    const result = computeWritingTurnContext({
      workspace: emptyWorkspace(),
      scenes: [],
      retrievedParagraphs: [],
      preferenceSignals: [],
      styleCorpusFragments: [],
      config: textProvider,
      userRequest: '继续写',
    })
    expect(result.initialPlan).toBeDefined()
    expect(result.finalPlan).toBeDefined()
    expect(result.contextMessage).toMatch(/^当前作品资料：/)
    expect(typeof result.rulesTruncated).toBe('boolean')
    expect(Array.isArray(result.styleFragmentIds)).toBe(true)
    // 关键安全属性：worker 经 structuredClone 回传，结果必须可克隆且保持值相等。
    const cloned = structuredClone(result)
    expect(cloned).toEqual(result)
  })

  it('excludeUserMessageId 时近期对话不重复注入该消息（重试防重复）', () => {
    const workspace = emptyWorkspace() as unknown as ProjectWorkspace
    const excludedText = '这条旧要求不应重复出现在近期对话'
    workspace.messages = [{
      id: 'm-excluded',
      projectId: 'project-1',
      kind: 'user',
      text: excludedText,
      createdAt: 0,
      updatedAt: 0,
      status: 'done',
    }] as unknown as ConversationMessage[]

    const excluded = computeWritingTurnContext({
      workspace,
      scenes: [],
      retrievedParagraphs: [],
      preferenceSignals: [],
      styleCorpusFragments: [],
      config: textProvider,
      userRequest: '继续写',
      excludeUserMessageId: 'm-excluded',
    })
    expect(excluded.contextMessage).not.toContain(excludedText)

    const included = computeWritingTurnContext({
      workspace,
      scenes: [],
      retrievedParagraphs: [],
      preferenceSignals: [],
      styleCorpusFragments: [],
      config: textProvider,
      userRequest: '继续写',
    })
    expect(included.contextMessage).toContain(excludedText)
  })
})
