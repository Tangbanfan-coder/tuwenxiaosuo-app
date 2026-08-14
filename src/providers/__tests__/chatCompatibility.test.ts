import { describe, expect, it } from 'vitest'
import { buildChatCompletionPayload, extractStreamingTextDelta, extractTextResponse, inferOutputTokenParameter, resolveTextTransport } from '../chatCompatibility'
import type { ProviderConfig } from '../types'

const baseConfig: ProviderConfig = {
  id: 'p1',
  name: 'p',
  baseUrl: 'https://api.test/v1',
  model: 'gpt-4o',
  protocol: 'openai-compatible',
  secretRef: 'provider:text',
}

describe('inferOutputTokenParameter', () => {
  it.each(['o1', 'o3-mini', 'o4-mini-2025-04-16', 'o1_2024_12_17', 'openai/o1'])('推理模型族 %s 使用 max_completion_tokens', (model) => {
    expect(inferOutputTokenParameter(model)).toBe('max_completion_tokens')
  })

  it.each(['gpt-5', 'gpt-5.1', 'gpt-5-mini-high', 'gpt-5.1-mini'])('GPT-5 族 %s 使用 max_completion_tokens', (model) => {
    expect(inferOutputTokenParameter(model)).toBe('max_completion_tokens')
  })

  it.each(['gpt-4o', 'gpt-4o-2024-08-06', 'openai/gpt-4o', 'deepseek-chat', 'unknown-alias', ''])('其余及未知别名 %s 使用 max_tokens', (model) => {
    expect(inferOutputTokenParameter(model)).toBe('max_tokens')
  })
})

describe('buildChatCompletionPayload', () => {
  it('auto 时用户未选择思考等级则不发送 reasoning_effort', () => {
    const body = buildChatCompletionPayload(baseConfig, {
      model: 'gpt-4o', messages: [], reasoningEffort: 'auto', stream: true,
    })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('auto 时用户显式选择思考等级则发送 reasoning_effort', () => {
    const body = buildChatCompletionPayload(baseConfig, {
      model: 'gpt-4o', messages: [], reasoningEffort: 'high', stream: true,
    })
    expect(body.reasoning_effort).toBe('high')
  })

  it('unsupported 时即使显式选择 high 也不发送 reasoning_effort', () => {
    const body = buildChatCompletionPayload({ ...baseConfig, capabilities: { reasoningEffortParameter: 'unsupported' } }, {
      model: 'gpt-4o', messages: [], reasoningEffort: 'high', stream: true,
    })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('输出参数 auto 时按模型 ID 推断参数名并发送预算值', () => {
    const body = buildChatCompletionPayload({ ...baseConfig, model: 'o3-mini' }, {
      model: 'o3-mini', messages: [], stream: false, maxOutputTokens: 4096,
    })
    expect(body.max_completion_tokens).toBe(4096)
    expect(body.max_tokens).toBeUndefined()
  })

  it('输出参数 auto 且未配置输出预算时不发送任何输出参数', () => {
    const body = buildChatCompletionPayload(baseConfig, { model: 'gpt-4o', messages: [], stream: false })
    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('输出参数 none 时不发送输出参数', () => {
    const body = buildChatCompletionPayload({ ...baseConfig, capabilities: { outputTokenParameter: 'none' } }, {
      model: 'gpt-4o', messages: [], stream: false, maxOutputTokens: 4096,
    })
    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('输出参数 max_tokens 时固定发送 max_tokens', () => {
    const body = buildChatCompletionPayload({ ...baseConfig, capabilities: { outputTokenParameter: 'max_tokens' } }, {
      model: 'o3-mini', messages: [], stream: false, maxOutputTokens: 1024,
    })
    expect(body.max_tokens).toBe(1024)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('输出参数 max_completion_tokens 时固定发送 max_completion_tokens', () => {
    const body = buildChatCompletionPayload({ ...baseConfig, capabilities: { outputTokenParameter: 'max_completion_tokens' } }, {
      model: 'gpt-4o', messages: [], stream: false, maxOutputTokens: 1024,
    })
    expect(body.max_completion_tokens).toBe(1024)
    expect(body.max_tokens).toBeUndefined()
  })

  it('stream 字段直接透传调用点的最终传输决策（不再被能力覆盖）', () => {
    expect(buildChatCompletionPayload({ ...baseConfig, capabilities: { textTransport: 'stream' } }, { model: 'gpt-4o', messages: [], stream: false }).stream).toBe(false)
    expect(buildChatCompletionPayload({ ...baseConfig, capabilities: { textTransport: 'non-stream' } }, { model: 'gpt-4o', messages: [], stream: true }).stream).toBe(true)
    expect(buildChatCompletionPayload(baseConfig, { model: 'gpt-4o', messages: [], stream: false }).stream).toBe(false)
    expect(buildChatCompletionPayload(baseConfig, { model: 'gpt-4o', messages: [], stream: true }).stream).toBe(true)
  })

  it('forceNonStream 时无论调用点意图与能力都强制 stream:false（Android 后台）', () => {
    expect(buildChatCompletionPayload({ ...baseConfig, capabilities: { textTransport: 'stream' } }, {
      model: 'gpt-4o', messages: [], stream: true, forceNonStream: true,
    }).stream).toBe(false)
  })

  it('额外参数在能力决策之后合并', () => {
    const body = buildChatCompletionPayload(baseConfig, {
      model: 'gpt-4o', messages: [], stream: true, extra: { temperature: 0.8 },
    })
    expect(body.temperature).toBe(0.8)
    expect(body.model).toBe('gpt-4o')
    expect(body.messages).toEqual([])
  })
})

describe('resolveTextTransport', () => {
  it('auto 能力原样保留调用点默认传输方法与 Android 通道', () => {
    expect(resolveTextTransport(baseConfig, { transportMethod: 'stream', androidTransport: 'webview-stream' }))
      .toEqual({ transportMethod: 'stream', androidTransport: 'webview-stream' })
    expect(resolveTextTransport(baseConfig, { transportMethod: 'request', androidTransport: 'native' }))
      .toEqual({ transportMethod: 'request', androidTransport: 'native' })
  })

  it('stream 能力强制流式传输与 webview-stream 通道', () => {
    expect(resolveTextTransport({ ...baseConfig, capabilities: { textTransport: 'stream' } }, { transportMethod: 'request', androidTransport: 'native' }))
      .toEqual({ transportMethod: 'stream', androidTransport: 'webview-stream' })
  })

  it('non-stream 能力强制 request 传输与 native 通道', () => {
    expect(resolveTextTransport({ ...baseConfig, capabilities: { textTransport: 'non-stream' } }, { transportMethod: 'stream', androidTransport: 'webview-stream' }))
      .toEqual({ transportMethod: 'request', androidTransport: 'native' })
  })

  it('后台 forceNonStream 优先级最高，stream 能力不得覆盖', () => {
    expect(resolveTextTransport({ ...baseConfig, capabilities: { textTransport: 'stream' } }, { transportMethod: 'stream', androidTransport: 'webview-stream', forceNonStream: true }))
      .toEqual({ transportMethod: 'request', androidTransport: 'native' })
  })
})

describe('extractTextResponse', () => {
  it('支持 choices[0].message.content 字符串', () => {
    expect(extractTextResponse({ choices: [{ message: { content: '正文' } }] })).toBe('正文')
  })

  it('支持 choices[0].message.content 为带 text 字段的数组', () => {
    expect(extractTextResponse({ choices: [{ message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } }] })).toBe('第一段第二段')
  })

  it('支持顶层 output_text', () => {
    expect(extractTextResponse({ output_text: '顶层正文' })).toBe('顶层正文')
  })

  it('支持顶层 generated_text', () => {
    expect(extractTextResponse({ generated_text: '生成正文' })).toBe('生成正文')
  })

  it('支持 output[].content[].text（Responses 风格）', () => {
    expect(extractTextResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '回复内容' }] }] })).toBe('回复内容')
  })

  it('choices 内容为空字符串时继续探测其他结构', () => {
    expect(extractTextResponse({ choices: [{ message: { content: '' } }], output_text: '后备正文' })).toBe('后备正文')
  })

  it('无法识别时抛出明确的不受支持错误而不是“没有返回内容”', () => {
    expect(() => extractTextResponse({ error: { message: 'boom' } })).toThrow('当前响应结构不受支持')
    expect(() => extractTextResponse(null)).toThrow('当前响应结构不受支持')
  })
})

describe('extractStreamingTextDelta', () => {
  it('提取流式 delta 字符串', () => {
    expect(extractStreamingTextDelta({ choices: [{ delta: { content: '增量' } }] })).toBe('增量')
  })

  it('提取带 text 字段的数组 delta', () => {
    expect(extractStreamingTextDelta({ choices: [{ delta: { content: [{ text: 'a' }, { text: 'b' }] } }] })).toBe('ab')
  })

  it('流式 delta 原样保留英文前导空格（"Hello" + " world" 拼接为 "Hello world"）', () => {
    const first = extractStreamingTextDelta({ choices: [{ delta: { content: 'Hello' } }] })
    const second = extractStreamingTextDelta({ choices: [{ delta: { content: ' world' } }] })
    expect(first + second).toBe('Hello world')
  })

  it('单独的空格或换行 delta 不得丢失', () => {
    expect(extractStreamingTextDelta({ choices: [{ delta: { content: ' ' } }] })).toBe(' ')
    expect(extractStreamingTextDelta({ choices: [{ delta: { content: '\n' } }] })).toBe('\n')
    expect(extractStreamingTextDelta({ choices: [{ delta: { content: '段落一\n\n段落二' } }] })).toBe('段落一\n\n段落二')
  })

  it('数组 delta 内的空格片段同样保留', () => {
    expect(extractStreamingTextDelta({ choices: [{ delta: { content: [{ text: '第' }, { text: '一' }, { text: ' 段' }] } }] })).toBe('第一 段')
  })

  it('非流式响应保留原文首尾空白，仅由调用点决定是否为空', () => {
    expect(extractTextResponse({ choices: [{ message: { content: '  正文前后有空格  ' } }] })).toBe('  正文前后有空格  ')
    expect(extractTextResponse({ output_text: '\n\t带换行\t\n' })).toBe('\n\t带换行\t\n')
    expect(extractTextResponse({ choices: [{ message: { content: [{ text: '行1' }, { text: '\n' }, { text: '行2' }] } }] })).toBe('行1\n行2')
  })

  it('无 delta 或空内容返回空串', () => {
    expect(extractStreamingTextDelta({ choices: [{ delta: {} }] })).toBe('')
    expect(extractStreamingTextDelta({})).toBe('')
  })
})
