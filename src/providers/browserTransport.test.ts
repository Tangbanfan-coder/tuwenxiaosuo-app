import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  native: true,
  nativeRequest: vi.fn(),
  secretGet: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
  CapacitorHttp: { request: mocks.nativeRequest },
}))

vi.mock('./secretStore', () => ({
  secretStore: { get: mocks.secretGet },
}))

import { BrowserFetchTransport } from './browserTransport'

describe('BrowserFetchTransport', () => {
  beforeEach(() => {
    mocks.native = true
    mocks.nativeRequest.mockReset()
    mocks.secretGet.mockReset().mockResolvedValue('native-key')
    vi.stubGlobal('window', { setTimeout, clearTimeout })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('原生普通请求明确使用 CapacitorHttp', async () => {
    mocks.nativeRequest.mockResolvedValue({ status: 200, data: { ok: true }, headers: {}, url: 'https://api.test' })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await new BrowserFetchTransport().request<{ ok: boolean }>({
      url: 'https://api.test/v1/models',
      method: 'GET',
      auth: { kind: 'bearer', secretRef: 'provider-key' },
      timeoutMs: 3210,
    })

    expect(result).toEqual({ status: 200, data: { ok: true } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mocks.nativeRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.test/v1/models',
      method: 'GET',
      headers: { Authorization: 'Bearer native-key' },
      connectTimeout: 3210,
      readTimeout: 3210,
    }))
  })

  it('原生 HTTP 错误保留中文详情和状态码', async () => {
    mocks.nativeRequest.mockResolvedValue({
      status: 400,
      data: { error: { message: '参考图片格式不受支持' } },
      headers: {},
      url: 'https://api.test',
    })

    await expect(new BrowserFetchTransport().request({
      url: 'https://api.test/v1/images/edits',
      method: 'POST',
    })).rejects.toMatchObject({
      message: '接口返回 HTTP 400：参考图片格式不受支持',
      status: 400,
    })
  })

  it('原生超时保持明确的中文提示', async () => {
    mocks.nativeRequest.mockRejectedValue(Object.assign(new Error('Read timed out'), {
      code: 'SocketTimeoutException',
    }))

    await expect(new BrowserFetchTransport().request({
      url: 'https://api.test/v1/models',
      method: 'GET',
    })).rejects.toThrow('连接超时，请检查 API URL')
  })

  it('原生 FormData 转成 Capacitor formData entries', async () => {
    mocks.nativeRequest.mockResolvedValue({ status: 200, data: {}, headers: {}, url: 'https://api.test' })
    const form = new FormData()
    form.append('prompt', '角色定妆照')
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'reference.png')

    await new BrowserFetchTransport().request({
      url: 'https://api.test/v1/images/edits',
      method: 'POST',
      body: form,
    })

    expect(mocks.nativeRequest).toHaveBeenCalledWith(expect.objectContaining({
      dataType: 'formData',
      headers: { 'Content-Type': 'multipart/form-data' },
      data: [
        { key: 'prompt', value: '角色定妆照', type: 'string' },
        {
          key: 'image',
          value: 'AQID',
          type: 'base64File',
          contentType: 'image/png',
          fileName: 'reference.png',
        },
      ],
    }))
  })

  it('原生 stream 改为非流式请求并只回调一次完整内容', async () => {
    mocks.nativeRequest.mockResolvedValue({
      status: 200,
      data: { choices: [{ message: { content: '完整正文' } }] },
      headers: {},
      url: 'https://api.test',
    })
    const onDelta = vi.fn()

    const result = await new BrowserFetchTransport().stream({
      url: 'https://api.test/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', stream: true, messages: [] }),
    }, onDelta)

    expect(result).toBe('完整正文')
    expect(onDelta).toHaveBeenCalledTimes(1)
    expect(onDelta).toHaveBeenCalledWith('完整正文')
    const nativeOptions = mocks.nativeRequest.mock.calls[0][0]
    expect(JSON.parse(nativeOptions.data)).toMatchObject({ model: 'test-model', stream: false })
  })

  it('Android 开启流式输出后使用 WebView SSE，不调用 CapacitorHttp', async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"实时正文"}}]}\n',
      'data: [DONE]\n',
    ].join('')
    const fetchSpy = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const onDelta = vi.fn()

    await expect(new BrowserFetchTransport().stream({
      url: 'https://api.test/v1/chat/completions',
      method: 'POST',
      body: '{}',
      androidTransport: 'webview-stream',
    }, onDelta)).resolves.toBe('实时正文')

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(mocks.nativeRequest).not.toHaveBeenCalled()
    expect(onDelta).toHaveBeenCalledWith('实时正文')
  })

  it('Android 流式连接失败时不自动用原生 HTTP 重发', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(new BrowserFetchTransport().stream({
      url: 'https://api.test/v1/chat/completions',
      method: 'POST',
      body: '{}',
      androidTransport: 'webview-stream',
    }, vi.fn())).rejects.toThrow('关闭“流式输出”后手动重试；本次没有自动重发')

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(mocks.nativeRequest).not.toHaveBeenCalled()
  })

  it('Web stream 继续解析 fetch SSE', async () => {
    mocks.native = false
    const body = [
      'data: {"choices":[{"delta":{"content":"第一段"}}]}\n',
      'data: {"choices":[{"delta":{"content":"第二段"}}]}\n',
      'data: [DONE]\n',
    ].join('')
    const fetchSpy = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const onDelta = vi.fn()

    const result = await new BrowserFetchTransport().stream({
      url: 'https://api.test/v1/chat/completions',
      method: 'POST',
      body: '{}',
    }, onDelta)

    expect(result).toBe('第一段第二段')
    expect(onDelta.mock.calls).toEqual([['第一段'], ['第二段']])
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(mocks.nativeRequest).not.toHaveBeenCalled()
  })
})
