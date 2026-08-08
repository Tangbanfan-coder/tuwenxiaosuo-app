import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { generateWritingTurn } from '../writing'
import type { HttpTransport, ProviderConfig } from '../types'

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

const VALID_RESULT = JSON.stringify({
  assistant_note: 'ok',
  chapter_action: 'continue',
  prose: { chapter_title: '第1章', paragraphs: ['正文第一段。'] },
  visual_plan: null,
})

const noopTransport: HttpTransport = {
  async request<T>() {
    return { status: 200, data: { choices: [{ message: { content: VALID_RESULT } }] } as T }
  },
  async stream() {
    return VALID_RESULT
  },
}

describe('上下文预算', () => {
  it('输入超过模型窗口时阻止请求而不是静默发送', async () => {
    const tinyWindow: ProviderConfig = {
      ...textProvider,
      manualContextLength: 1_000,
      manualMaxOutputTokens: 16_000,
    }
    await expect(generateWritingTurn(emptyWorkspace(), '随便写一段', tinyWindow, noopTransport))
      .rejects.toThrow(/上下文窗口/)
  })

  it('窗口小于输出预留时同样阻止请求', async () => {
    const absurd: ProviderConfig = {
      ...textProvider,
      manualContextLength: 8_000,
      manualMaxOutputTokens: 16_000,
    }
    await expect(generateWritingTurn(emptyWorkspace(), '随便写一段', absurd, noopTransport))
      .rejects.toThrow(/上下文窗口/)
  })

  it('核心规则超过预算时阻止生成，不静默继续', async () => {
    const hugeInstructions = '必须遵守的核心规则。'.repeat(2_000)
    const workspace = {
      ...emptyWorkspace(),
      project: { ...emptyWorkspace().project, writingInstructions: hugeInstructions },
    }
    const smallWindow: ProviderConfig = {
      ...textProvider,
      manualContextLength: 64_000,
      manualMaxOutputTokens: 1_000,
    }
    await expect(generateWritingTurn(workspace, '继续写', smallWindow, noopTransport))
      .rejects.toThrow(/核心预算/)
  })

  it('正常窗口下不抛错', async () => {
    const normal: ProviderConfig = {
      ...textProvider,
      manualContextLength: 128_000,
      manualMaxOutputTokens: 16_000,
    }
    await expect(generateWritingTurn(emptyWorkspace(), '写一章', normal, noopTransport)).resolves.toBeDefined()
  })

  it('输出上限超过窗口一半时按窗口一半封顶，不阻止请求', async () => {
    const capped: ProviderConfig = {
      ...textProvider,
      manualContextLength: 128_000,
      manualMaxOutputTokens: 384_000,
    }
    await expect(generateWritingTurn(emptyWorkspace(), '写一章', capped, noopTransport)).resolves.toBeDefined()
  })
})
