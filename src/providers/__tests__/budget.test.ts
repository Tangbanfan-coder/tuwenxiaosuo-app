import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { generateWritingTurn, previewWritingTurnBudget } from '../writing'
import { resolveTokenEstimator } from '../tokenEstimator'
import type { HttpTransport, ProviderConfig, TransportRequest } from '../types'

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

function captureRequestBody(onBody: (body: Record<string, unknown>) => void): HttpTransport {
  return {
    async request<T>(request: TransportRequest) {
      onBody(JSON.parse(String(request.body)) as Record<string, unknown>)
      return { status: 200, data: { choices: [{ message: { content: VALID_RESULT } }] } as T }
    },
    async stream() {
      return VALID_RESULT
    },
  }
}

function captureStreamRequest(onRequest: (request: TransportRequest) => void): HttpTransport {
  return {
    async request<T>() {
      return { status: 200, data: { choices: [{ message: { content: VALID_RESULT } }] } as T }
    },
    async stream(request) {
      onRequest(request)
      return VALID_RESULT
    },
  }
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

  it('8K 窗口在降低输出上限后仍可使用', async () => {
    const smallButValid: ProviderConfig = {
      ...textProvider,
      manualContextLength: 8_000,
      manualMaxOutputTokens: 500,
    }
    await expect(generateWritingTurn(emptyWorkspace(), '写一个很短的开场', smallButValid, noopTransport)).resolves.toBeDefined()
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

  it('只有注册表推测输出上限时不强制发送输出参数', async () => {
    let body: Record<string, unknown> = {}
    await generateWritingTurn(emptyWorkspace(), '写一章', textProvider, captureRequestBody((value) => { body = value }))
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('max_completion_tokens')
  })

  it('思考等级默认不发送，显式设置时透传 reasoning_effort', async () => {
    let body: Record<string, unknown> = {}
    await generateWritingTurn(emptyWorkspace(), '写一章', textProvider, captureRequestBody((value) => { body = value }))
    expect(body).not.toHaveProperty('reasoning_effort')
    await generateWritingTurn(emptyWorkspace(), '写一章', { ...textProvider, reasoningEffort: 'high' }, captureRequestBody((value) => { body = value }))
    expect(body.reasoning_effort).toBe('high')
  })

  it('按文本供应商配置选择 Android 写作传输模式', async () => {
    let defaultRequest: TransportRequest | undefined
    let streamingRequest: TransportRequest | undefined
    await generateWritingTurn(emptyWorkspace(), '写一章', textProvider, captureStreamRequest((request) => { defaultRequest = request }), vi.fn())
    await generateWritingTurn(emptyWorkspace(), '写一章', { ...textProvider, androidStreamingEnabled: true }, captureStreamRequest((request) => { streamingRequest = request }), vi.fn())

    expect(defaultRequest?.androidTransport).toBe('native')
    expect(streamingRequest?.androidTransport).toBe('webview-stream')
  })

  it('预览与发送复用同一份阶段化最终上下文计划', async () => {
    const workspace = emptyWorkspace()
    workspace.project.id = 'preview-shared-plan'
    const userRequest = '让开场的雨夜追逐更紧张，并保持第三人称。'
    const preview = await previewWritingTurnBudget(workspace, userRequest, textProvider)
    let body: Record<string, unknown> = {}
    await generateWritingTurn(workspace, userRequest, textProvider, captureRequestBody((value) => { body = value }))
    const previewAfterSend = await previewWritingTurnBudget(workspace, userRequest, textProvider)

    const messages = body.messages as Array<{ content: string }>
    const serializedContext = messages[1]?.content
    const estimator = resolveTokenEstimator({ protocol: textProvider.protocol, providerId: textProvider.id, model: textProvider.model })
    expect(serializedContext).toMatch(/^当前作品资料：/)
    expect(preview.serializedContextTokens).toBe(Math.ceil(estimator.estimator.estimate(serializedContext)))
    expect(preview.contextRetainedTokens).toBe(preview.serializedContextTokens)
    expect(preview.contextDemandTokens).toBeGreaterThanOrEqual(preview.contextRetainedTokens)
    expect(previewAfterSend).toEqual(preview)
    expect(previewAfterSend.compressionStage).toBe(preview.compressionStage)
    expect(preview.sections.map((section) => section.key)).toContain('timelineRetrievedContext')
  })

  it('显式配置输出上限时为通用模型发送 max_tokens', async () => {
    let body: Record<string, unknown> = {}
    const configured = { ...textProvider, manualContextLength: 128_000, manualMaxOutputTokens: 2_000 }
    await generateWritingTurn(emptyWorkspace(), '写一章', configured, captureRequestBody((value) => { body = value }))
    expect(body.max_tokens).toBe(2_000)
    expect(body).not.toHaveProperty('max_completion_tokens')
  })

  it('显式配置输出上限时为 OpenAI 推理模型发送 max_completion_tokens', async () => {
    let body: Record<string, unknown> = {}
    const configured = {
      ...textProvider,
      model: 'gpt-5',
      manualContextLength: 128_000,
      manualMaxOutputTokens: 2_000,
    }
    await generateWritingTurn(emptyWorkspace(), '写一章', configured, captureRequestBody((value) => { body = value }))
    expect(body.max_completion_tokens).toBe(2_000)
    expect(body).not.toHaveProperty('max_tokens')
  })
})
