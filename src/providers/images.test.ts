import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpTransport, ProviderConfig } from './types'
import { editOpenAiImage, generateOpenAiImage } from './images'

const config: ProviderConfig = {
  id: 'image-provider',
  name: '图片模型',
  baseUrl: 'https://api.test/v1',
  model: 'gpt-image-2',
  protocol: 'openai-compatible',
  secretRef: 'image-key',
}

describe('editOpenAiImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('明确说明 edits multipart 依赖并保留原始错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['image']), { status: 200 })))
    const original = new Error('接口返回 HTTP 404：路由不存在')
    const request = vi.fn().mockRejectedValue(original)
    const transport = { request } as unknown as HttpTransport

    const promise = editOpenAiImage(config, '保持角色一致', ['data:image/png;base64,aW1hZ2U='], transport)

    await expect(promise).rejects.toThrow(
      '参考图生图失败：该功能依赖 OpenAI 兼容的 /images/edits multipart 接口，中转服务可能不支持。原始错误：接口返回 HTTP 404：路由不存在',
    )
    await expect(promise).rejects.toMatchObject({ cause: original })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.test/v1/images/edits',
      body: expect.any(FormData),
    }))
  })

  it('edits 成功时保持原有图片结果', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['image']), { status: 200 })))
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: { data: [{ b64_json: 'generated-image' }] },
    })
    const transport = { request } as unknown as HttpTransport

    await expect(editOpenAiImage(config, '保持角色一致', ['reference'], transport))
      .resolves.toBe('data:image/png;base64,generated-image')
    const form = request.mock.calls[0][0].body as FormData
    expect(form.get('response_format')).toBeNull()
  })
})

describe('image URL recovery', () => {
  it('does not send response_format to GPT Image and does not download its returned b64 data', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: { data: [{ url: 'https://cdn.test/image.png', b64_json: 'generated-image' }] },
    })
    const resolveImageSource = vi.fn()
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport)).resolves.toBe('data:image/png;base64,generated-image')
    expect(JSON.parse(request.mock.calls[0][0].body)).not.toHaveProperty('response_format')
    expect(resolveImageSource).not.toHaveBeenCalled()
  })

  it('sends response_format only for an explicitly supported DALL-E generation model', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ b64_json: 'generated-image' }] } })
    const transport = { request } as unknown as HttpTransport
    const dalle = { ...config, model: 'dall-e-3' }

    await expect(generateOpenAiImage(dalle, '生成定妆照', transport)).resolves.toBe('data:image/png;base64,generated-image')
    expect(JSON.parse(request.mock.calls[0][0].body)).toMatchObject({ response_format: 'b64_json' })
  })

  it('sends response_format for an explicitly supported DALL-E edit model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['image']), { status: 200 })))
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ b64_json: 'generated-image' }] } })
    const transport = { request } as unknown as HttpTransport
    const dalle = { ...config, model: 'dall-e-2' }

    await expect(editOpenAiImage(dalle, '保持角色一致', ['reference'], transport)).resolves.toBe('data:image/png;base64,generated-image')
    const form = request.mock.calls[0][0].body as FormData
    expect(form.get('response_format')).toBe('b64_json')
  })

  it('uses the provider bearer only for a same-origin URL fallback', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ url: 'https://api.test/generated/image.png' }] } })
    const resolveImageSource = vi.fn().mockResolvedValue('data:image/png;base64,generated-image')
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport)).resolves.toBe('data:image/png;base64,generated-image')
    expect(resolveImageSource).toHaveBeenCalledWith({
      url: 'https://api.test/generated/image.png',
      auth: { kind: 'bearer', secretRef: 'image-key' },
      timeoutMs: 120_000,
    })
  })

  it('never sends the provider bearer to a cross-origin CDN URL', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ url: 'https://cdn.test/generated/image.png' }] } })
    const resolveImageSource = vi.fn().mockResolvedValue('data:image/png;base64,generated-image')
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport)).resolves.toBe('data:image/png;base64,generated-image')
    expect(resolveImageSource).toHaveBeenCalledWith({
      url: 'https://cdn.test/generated/image.png',
      auth: undefined,
      timeoutMs: 120_000,
    })
  })

  it('explains a cross-origin 403 without retrying it with the API key', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ url: 'https://cdn.test/generated/image.png' }] } })
    const resolveImageSource = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport))
      .rejects.toThrow('不会向该地址发送凭据')
    expect(resolveImageSource).toHaveBeenCalledTimes(1)
    expect(resolveImageSource.mock.calls[0][0].auth).toBeUndefined()
  })
})
