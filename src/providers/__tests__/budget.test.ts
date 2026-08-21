import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { generateWritingTurn, prepareBackgroundWritingRequest, previewWritingTurnBudget } from '../writing'
import { structureWritingInstructions } from '../writing/instructions'
import { rewriteProseParagraph } from '../writing/rewrite'
import { suggestStyleCorpusLabels } from '../writing/styleCorpus'
import { analyzeReferenceImage } from '../referenceAnalysis'
import { resolveTokenEstimator } from '../tokenEstimator'
import type { HttpTransport, ProviderConfig, TransportRequest } from '../types'

const textProvider: ProviderConfig = {
  id: 'test',
  name: 'Test',
  baseUrl: 'https://example/v1',
  model: 'deepseek-v4-flash',
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

/** Records the body AND which transport method actually handled it, so tests can
 *  assert the body stream field matches the real transport. */
function captureTransportPair(onBody: (body: Record<string, unknown>) => void, onMethod: (method: 'stream' | 'request') => void): HttpTransport {
  return {
    async request<T>(request: TransportRequest) {
      onMethod('request')
      onBody(JSON.parse(String(request.body)) as Record<string, unknown>)
      return { status: 200, data: { choices: [{ message: { content: VALID_RESULT } }] } as T }
    },
    async stream(request) {
      onMethod('stream')
      onBody(JSON.parse(String(request.body)) as Record<string, unknown>)
      return VALID_RESULT
    },
  }
}

describe('上下文预算', () => {
  it('reports selected style ids only for real foreground/background requests, never previews', async () => {
    const previewSelection = vi.fn()
    await previewWritingTurnBudget(emptyWorkspace(), '继续写', textProvider, { onStyleFragmentsSelected: previewSelection })
    expect(previewSelection).not.toHaveBeenCalled()

    const foregroundSelection = vi.fn()
    await generateWritingTurn(emptyWorkspace(), '继续写', textProvider, noopTransport, undefined, { onStyleFragmentsSelected: foregroundSelection })
    expect(foregroundSelection).toHaveBeenCalledTimes(1)

    const backgroundSelection = vi.fn()
    await prepareBackgroundWritingRequest(emptyWorkspace(), '继续写', textProvider, { onStyleFragmentsSelected: backgroundSelection })
    expect(backgroundSelection).toHaveBeenCalledTimes(1)
  })
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
    let deliveredPlan: typeof preview | undefined
    let body: Record<string, unknown> = {}
    await generateWritingTurn(workspace, userRequest, textProvider, captureRequestBody((value) => { body = value }), undefined, {
      onContextPlan: (plan) => { deliveredPlan = plan },
    })
    const previewAfterSend = await previewWritingTurnBudget(workspace, userRequest, textProvider)

    const messages = body.messages as Array<{ content: string }>
    const serializedContext = messages[1]?.content
    const estimator = resolveTokenEstimator({ protocol: textProvider.protocol, providerId: textProvider.id, model: textProvider.model })
    expect(serializedContext).toMatch(/^当前作品资料：/)
    expect(preview.serializedContextTokens).toBe(Math.ceil(estimator.estimator.estimate(serializedContext)))
    expect(preview.contextRetainedTokens).toBe(preview.serializedContextTokens)
    expect(preview.contextDemandTokens).toBeGreaterThanOrEqual(preview.contextRetainedTokens)
    expect(previewAfterSend).toEqual(preview)
    expect(deliveredPlan).toEqual(preview)
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

  it('Android 后台写作请求保持非流式（stream:false），思考等级按用户选择透传', async () => {
    const prepared = await prepareBackgroundWritingRequest(emptyWorkspace(), '写一章', { ...textProvider, reasoningEffort: 'high' as const })
    const body = JSON.parse(prepared.body) as Record<string, unknown>
    expect(body.stream).toBe(false)
    expect(body.reasoning_effort).toBe('high')
    expect(body.messages).toBeInstanceOf(Array)
  })

  it('严格中转预设下写作请求省略可选参数并保持非流式', async () => {
    let body: Record<string, unknown> = {}
    const strict = {
      ...textProvider,
      reasoningEffort: 'high' as const,
      manualContextLength: 128_000,
      manualMaxOutputTokens: 2_000,
      capabilities: {
        reasoningEffortParameter: 'unsupported' as const,
        outputTokenParameter: 'none' as const,
        textTransport: 'non-stream' as const,
        structuredOutput: 'prompt_only' as const,
      },
    }
    await generateWritingTurn(emptyWorkspace(), '写一章', strict, captureRequestBody((value) => { body = value }))
    expect(body.stream).toBe(false)
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('max_completion_tokens')
    expect(body).not.toHaveProperty('response_format')
  })

  it('自动兼容在前台和 Android 后台都发送 JSON Object 约束', async () => {
    let foregroundBody: Record<string, unknown> = {}
    await generateWritingTurn(emptyWorkspace(), '写一章', textProvider, captureRequestBody((value) => { foregroundBody = value }))
    const background = JSON.parse((await prepareBackgroundWritingRequest(emptyWorkspace(), '写一章', textProvider)).body) as Record<string, unknown>

    expect(foregroundBody.response_format).toEqual({ type: 'json_object' })
    expect(background.response_format).toEqual({ type: 'json_object' })
  })

  it('OpenAI JSON Schema 严格约束包含写作字段与必要的 object 规则', async () => {
    let body: Record<string, unknown> = {}
    const official = { ...textProvider, capabilities: { structuredOutput: 'json_schema' as const } }
    await generateWritingTurn(emptyWorkspace(), '写一章', official, captureRequestBody((value) => { body = value }))

    const format = body.response_format as { type: string; json_schema: { strict: boolean; schema: Record<string, unknown> } }
    expect(format.type).toBe('json_schema')
    expect(format.json_schema.strict).toBe(true)
    expect(format.json_schema.schema.additionalProperties).toBe(false)
    expect((format.json_schema.schema.properties as Record<string, unknown>).prose).toBeDefined()
  })
})

describe('请求体模式与实际传输方法一致性', () => {
  it('auto 能力 + 前台 onDelta：body stream:true 且由 stream() 传输', async () => {
    let body: Record<string, unknown> = {}
    const methods: string[] = []
    await generateWritingTurn(emptyWorkspace(), '写一章', textProvider, captureTransportPair((value) => { body = value }, (method) => methods.push(method)), vi.fn())
    expect(body.stream).toBe(true)
    expect(methods).toEqual(['stream'])
  })

  it('auto 能力 + 前台无 onDelta：body stream:false 且由 request() 传输（不再错配）', async () => {
    let body: Record<string, unknown> = {}
    const methods: string[] = []
    await generateWritingTurn(emptyWorkspace(), '写一章', textProvider, captureTransportPair((value) => { body = value }, (method) => methods.push(method)))
    expect(body.stream).toBe(false)
    expect(methods).toEqual(['request'])
  })

  it('严格中转（non-stream）即使前台有 onDelta 也走 request()，body stream:false', async () => {
    let body: Record<string, unknown> = {}
    const methods: string[] = []
    const strict = { ...textProvider, capabilities: { textTransport: 'non-stream' as const } }
    await generateWritingTurn(emptyWorkspace(), '写一章', strict, captureTransportPair((value) => { body = value }, (method) => methods.push(method)), vi.fn())
    expect(body.stream).toBe(false)
    expect(methods).toEqual(['request'])
  })

  it('OpenAI 官方（stream）即使前台无 onDelta 也走 stream()，body stream:true', async () => {
    let capturedRequest: TransportRequest | undefined
    const transport = {
      async request<T>() {
        return { status: 200, data: { choices: [{ message: { content: VALID_RESULT } }] } as T }
      },
      async stream(request: TransportRequest) {
        capturedRequest = request
        return VALID_RESULT
      },
    } as unknown as HttpTransport
    const official = { ...textProvider, capabilities: { textTransport: 'stream' as const } }
    await generateWritingTurn(emptyWorkspace(), '写一章', official, transport)
    const body = JSON.parse(String(capturedRequest?.body)) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(capturedRequest?.androidTransport).toBe('webview-stream')
  })

  it('OpenAI 官方（stream）预设下 Android 后台请求体仍强制 stream:false', async () => {
    const official = { ...textProvider, capabilities: { textTransport: 'stream' as const } }
    const prepared = await prepareBackgroundWritingRequest(emptyWorkspace(), '写一章', official)
    const body = JSON.parse(prepared.body) as Record<string, unknown>
    expect(body.stream).toBe(false)
  })

  it('自定义 stream 模式下后台请求体同样保持 stream:false', async () => {
    const custom = { ...textProvider, capabilities: { textTransport: 'stream' as const, reasoningEffortParameter: 'supported' as const } }
    const prepared = await prepareBackgroundWritingRequest(emptyWorkspace(), '写一章', custom)
    const body = JSON.parse(prepared.body) as Record<string, unknown>
    expect(body.stream).toBe(false)
  })

  it('非写作调用点（改写）在 stream 预设下仍保持非流式请求体', async () => {
    let body: Record<string, unknown> = {}
    const transport = {
      async request<T>(request: TransportRequest) {
        body = JSON.parse(String(request.body)) as Record<string, unknown>
        return { status: 200, data: { choices: [{ message: { content: '{"rewritten_paragraph":"他推开窗，风灌了进来。"}' } }] } as T }
      },
      async stream() {
        return VALID_RESULT
      },
    } as unknown as HttpTransport
    const official = { ...textProvider, capabilities: { textTransport: 'stream' as const } }
    await rewriteProseParagraph({
      originalText: '他推开窗，风灌了进来。',
      issues: [{ ruleId: 'rule-1', category: 'emotion-telling', severity: 'hint', explanation: '直接说出情绪', rewriteGoal: '改为动作或场景暗示' }],
    }, official, transport)
    expect(body.stream).toBe(false)
  })

  it('设定整理在 stream 预设下仍保持非流式请求体', async () => {
    let body: Record<string, unknown> = {}
    const transport = {
      async request<T>(request: TransportRequest) {
        body = JSON.parse(String(request.body)) as Record<string, unknown>
        return { status: 200, data: { choices: [{ message: { content: '{"core_fragments":[],"sections":[{"title":"世界观","content":"雨城常年潮湿。","tags":["设定"],"priority":1}],"style_samples":[]}' } }] } as T }
      },
      async stream() {
        return VALID_RESULT
      },
    } as unknown as HttpTransport
    const official = { ...textProvider, capabilities: { textTransport: 'stream' as const } }
    await structureWritingInstructions('雨城常年潮湿。', official, transport)
    expect(body.stream).toBe(false)
  })

  it('语料标注在 stream 预设下仍保持非流式请求体', async () => {
    let body: Record<string, unknown> = {}
    const transport = {
      async request<T>(request: TransportRequest) {
        body = JSON.parse(String(request.body)) as Record<string, unknown>
        return { status: 200, data: { choices: [{ message: { content: '{"fragments":[{"paragraph_ids":["p1"],"genres":["玄幻"],"scene_types":[],"pov":"","narrative_distance":"","pace":[],"techniques":[],"emotional_tone":[],"imitate":[],"avoid":[],"confidence":0.9}]}' } }] } as T }
      },
      async stream() {
        return VALID_RESULT
      },
    } as unknown as HttpTransport
    const official = { ...textProvider, capabilities: { textTransport: 'stream' as const } }
    await suggestStyleCorpusLabels([{ id: 'p1', text: '雨城常年潮湿。', fingerprint: 'f1' }], official, transport)
    expect(body.stream).toBe(false)
  })

  it('参考图识图在 stream 预设下仍保持非流式请求体', async () => {
    let body: Record<string, unknown> = {}
    const transport = {
      async request<T>(request: TransportRequest) {
        body = JSON.parse(String(request.body)) as Record<string, unknown>
        return { status: 200, data: { choices: [{ message: { content: '{"narrative_pronoun":"she","age_and_build":"少女体型","fixed_traits":["长发"],"default_look":"","wardrobe":""}' } }] } as T }
      },
      async stream() {
        return VALID_RESULT
      },
    } as unknown as HttpTransport
    const official = { ...textProvider, capabilities: { textTransport: 'stream' as const, visionInput: 'supported' as const } }
    await analyzeReferenceImage('data:image/png;base64,abc', official, transport)
    expect(body.stream).toBe(false)
  })
})
