import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpTransport, ProviderConfig } from './types'
import { editOpenAiImage } from './images'

const config: ProviderConfig = {
  id: 'image-provider',
  name: '图片模型',
  baseUrl: 'https://api.test/v1',
  model: 'image-model',
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
  })
})
