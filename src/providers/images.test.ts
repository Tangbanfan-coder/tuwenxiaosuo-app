import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpTransport, ProviderConfig } from './types'
import { buildCharacterPortraitPrompt, editOpenAiImage, generateOpenAiImage, resolveImageSize } from './images'

const imageAssetStoreMocks = vi.hoisted(() => ({ generateNativeImageAsset: vi.fn() }))

vi.mock('./imageAssetStore', () => ({ generateNativeImageAsset: imageAssetStoreMocks.generateNativeImageAsset }))

const config: ProviderConfig = {
  id: 'image-provider',
  name: '图片模型',
  baseUrl: 'https://api.test/v1',
  model: 'gpt-image-2',
  protocol: 'openai-compatible',
  secretRef: 'image-key',
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  imageAssetStoreMocks.generateNativeImageAsset.mockReset()
})

describe('editOpenAiImage', () => {
  it('edits 端点返回 404 时说明 multipart 依赖并保留原始错误', async () => {
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

  it('timeout 等传输错误透传真实原因，不再归因于 multipart 兼容性', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['image']), { status: 200 })))
    const original = new Error('timeout')
    const request = vi.fn().mockRejectedValue(original)
    const transport = { request } as unknown as HttpTransport

    const promise = editOpenAiImage(config, '保持角色一致', ['data:image/png;base64,aW1hZ2U='], transport)

    await expect(promise).rejects.toThrow('参考图生图失败：timeout')
    await expect(promise).rejects.not.toThrow('multipart')
    await expect(promise).rejects.toMatchObject({ cause: original })
  })

  it('edits 成功时保持原有图片结果', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['image']), { status: 200 })))
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: { data: [{ b64_json: 'generated-image' }] },
    })
    const transport = { request } as unknown as HttpTransport

    await expect(editOpenAiImage(config, '保持角色一致', ['reference'], transport))
      .resolves.toEqual({ kind: 'inline', dataUrl: 'data:image/png;base64,generated-image' })
    const form = request.mock.calls[0][0].body as FormData
    expect(form.get('response_format')).toBeNull()
  })
})

describe('image URL recovery', () => {
  it('uses the Android generation-and-persist path before any transport request when given a target', async () => {
    imageAssetStoreMocks.generateNativeImageAsset.mockResolvedValue({ imageUrl: '', localUri: 'file://projects/project-1/images/asset-1.png' })
    const request = vi.fn()
    const transport = { request } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport, '1024x1536', undefined, { projectId: 'project-1', assetId: 'asset-1' }))
      .resolves.toEqual({ kind: 'local', localUri: 'file://projects/project-1/images/asset-1.png' })
    expect(imageAssetStoreMocks.generateNativeImageAsset).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://api.test/v1/images/generations', model: 'gpt-image-2', prompt: '生成定妆照', size: '1024x1536',
      target: { projectId: 'project-1', assetId: 'asset-1' }, secretRef: 'image-key',
    }))
    expect(request).not.toHaveBeenCalled()
  })

  it('uses the native multipart path without first converting local references into JavaScript blobs', async () => {
    imageAssetStoreMocks.generateNativeImageAsset.mockResolvedValue({ imageUrl: '', localUri: 'file://projects/project-1/images/asset-1.png' })
    const request = vi.fn()
    const transport = { request } as unknown as HttpTransport
    const reference = 'http://localhost/_capacitor_file_/data/user/0/reference.png'

    await expect(editOpenAiImage(config, '保持角色一致', [reference], transport, '1024x1536', undefined, { projectId: 'project-1', assetId: 'asset-1' }))
      .resolves.toEqual({ kind: 'local', localUri: 'file://projects/project-1/images/asset-1.png' })
    expect(imageAssetStoreMocks.generateNativeImageAsset).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://api.test/v1/images/edits', referenceSources: [reference],
    }))
    expect(request).not.toHaveBeenCalled()
  })

  it('does not retry through JavaScript when native generation fails', async () => {
    imageAssetStoreMocks.generateNativeImageAsset.mockRejectedValue(new Error('接口返回 HTTP 500'))
    const request = vi.fn()
    const transport = { request } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport, '1024x1536', undefined, { projectId: 'project-1', assetId: 'asset-1' }))
      .rejects.toThrow('接口返回 HTTP 500')
    expect(request).not.toHaveBeenCalled()
  })

  it('does not retry through JavaScript when native generation returns no local file', async () => {
    imageAssetStoreMocks.generateNativeImageAsset.mockResolvedValue({ imageUrl: '' })
    const request = vi.fn()
    const transport = { request } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport, '1024x1536', undefined, { projectId: 'project-1', assetId: 'asset-1' }))
      .rejects.toThrow('原生图片生成未返回本地文件')
    expect(request).not.toHaveBeenCalled()
  })

  it('prefers a returned URL so the native storage path can avoid b64 bridge transfer', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: { data: [{ url: 'https://cdn.test/image.png', b64_json: 'generated-image' }] },
    })
    const resolveImageSource = vi.fn()
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport)).resolves.toEqual({ kind: 'remote', url: 'https://cdn.test/image.png', auth: undefined })
    expect(JSON.parse(request.mock.calls[0][0].body)).not.toHaveProperty('response_format')
    expect(resolveImageSource).not.toHaveBeenCalled()
  })

  it('sends response_format only for an explicitly supported DALL-E generation model', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ b64_json: 'generated-image' }] } })
    const transport = { request } as unknown as HttpTransport
    const dalle = { ...config, model: 'dall-e-3' }

    await expect(generateOpenAiImage(dalle, '生成定妆照', transport)).resolves.toEqual({ kind: 'inline', dataUrl: 'data:image/png;base64,generated-image' })
    expect(JSON.parse(request.mock.calls[0][0].body)).toMatchObject({ response_format: 'b64_json' })
  })

  it('sends response_format for an explicitly supported DALL-E edit model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['image']), { status: 200 })))
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ b64_json: 'generated-image' }] } })
    const transport = { request } as unknown as HttpTransport
    const dalle = { ...config, model: 'dall-e-2' }

    await expect(editOpenAiImage(dalle, '保持角色一致', ['reference'], transport)).resolves.toEqual({ kind: 'inline', dataUrl: 'data:image/png;base64,generated-image' })
    const form = request.mock.calls[0][0].body as FormData
    expect(form.get('response_format')).toBe('b64_json')
  })

  it('uses the provider bearer only for a same-origin URL fallback', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ url: 'https://api.test/generated/image.png' }] } })
    const resolveImageSource = vi.fn()
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport)).resolves.toEqual({
      kind: 'remote', url: 'https://api.test/generated/image.png', auth: { kind: 'bearer', secretRef: 'image-key' },
    })
    expect(resolveImageSource).not.toHaveBeenCalled()
  })

  it('never sends the provider bearer to a cross-origin CDN URL', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ url: 'https://cdn.test/generated/image.png' }] } })
    const resolveImageSource = vi.fn()
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport)).resolves.toEqual({
      kind: 'remote', url: 'https://cdn.test/generated/image.png', auth: undefined,
    })
    expect(resolveImageSource).not.toHaveBeenCalled()
  })

  it('reports waiting before a b64 response without a synthetic download phase', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ b64_json: 'generated-image' }] } })
    const stages: string[] = []
    const transport = { request } as unknown as HttpTransport

    await generateOpenAiImage(config, '生成定妆照', transport, '1024x1536', (stage) => stages.push(stage))

    expect(stages).toEqual(['waiting'])
  })

  it('reports waiting then downloading when the provider returns a URL', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ url: 'https://cdn.test/generated/image.png' }] } })
    const resolveImageSource = vi.fn()
    const stages: string[] = []
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await generateOpenAiImage(config, '生成定妆照', transport, '1024x1536', (stage) => stages.push(stage))

    expect(stages).toEqual(['waiting', 'downloading'])
  })

  it('logs provider and URL download timing without exposing the returned URL', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ url: 'https://cdn.test/private-image.png' }] } })
    const resolveImageSource = vi.fn()
    const info = vi.mocked(console.info)
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await generateOpenAiImage(config, '生成定妆照', transport)

    const logged = info.mock.calls.map(([message]) => String(message))
    expect(logged.some((message) => message.includes('"phase":"provider-complete"') && message.includes('"responseMode":"url"'))).toBe(true)
    expect(logged.some((message) => message.includes('"phase":"remote-image-ready"') && message.includes('"usesProviderAuth":false'))).toBe(true)
    expect(logged.join('\n')).not.toContain('private-image.png')
  })

  it('defers cross-origin errors to the anonymous native persistence path', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ url: 'https://cdn.test/generated/image.png' }] } })
    const resolveImageSource = vi.fn()
    const transport = { request, resolveImageSource } as unknown as HttpTransport

    await expect(generateOpenAiImage(config, '生成定妆照', transport)).resolves.toEqual({
      kind: 'remote', url: 'https://cdn.test/generated/image.png', auth: undefined,
    })
    expect(resolveImageSource).not.toHaveBeenCalled()
  })
})

describe('buildCharacterPortraitPrompt', () => {
  it('preserves reference style when Android keeps only the local file URI', () => {
    const prompt = buildCharacterPortraitPrompt({
      id: 'character-1', projectId: 'project-1', name: '林染', role: '主角',
      identity: { ageAndBuild: '', fixedTraits: [] }, appearance: { defaultLook: '', wardrobe: '' },
      continuity: { revision: 0, localUri: 'file://reference.png', referenceStyleMode: 'reference' },
      portraitStatus: 'confirmed', status: 'confirmed', createdAt: 1, updatedAt: 1,
    })

    expect(prompt).toContain('保留上一张参考图自身的绘制或摄影风格')
  })
})

describe('图片能力校验', () => {
  it('imageEdits=unsupported 时在网络请求前拒绝参考图编辑', async () => {
    const request = vi.fn()
    const transport = { request } as unknown as HttpTransport
    const unsupported = { ...config, capabilities: { imageEdits: 'unsupported' as const } }

    const promise = editOpenAiImage(unsupported, '保持角色一致', ['data:image/png;base64,aW1hZ2U='], transport)

    await expect(promise).rejects.toThrow('不支持参考图编辑')
    expect(request).not.toHaveBeenCalled()
    expect(imageAssetStoreMocks.generateNativeImageAsset).not.toHaveBeenCalled()
  })

  it('参考图数量超限时在请求前报出实际数量与上限，不静默丢弃', async () => {
    const request = vi.fn()
    const transport = { request } as unknown as HttpTransport
    const limited = { ...config, capabilities: { maxReferenceImages: 1 } }

    const promise = editOpenAiImage(limited, '保持角色一致', ['ref-a', 'ref-b'], transport)

    await expect(promise).rejects.toThrow('参考图数量超出该图片供应商限制：当前 2 张，上限 1 张')
    expect(request).not.toHaveBeenCalled()
  })

  it('未配置能力时保持 legacy 行为，不阻止编辑', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['image']), { status: 200 })))
    const request = vi.fn().mockResolvedValue({ status: 200, data: { data: [{ b64_json: 'generated' }] } })
    const transport = { request } as unknown as HttpTransport

    await expect(editOpenAiImage(config, '保持角色一致', ['data:image/png;base64,aW1hZ2U='], transport))
      .resolves.toEqual({ kind: 'inline', dataUrl: 'data:image/png;base64,generated' })
  })
})

describe('resolveImageSize', () => {
  it('未配置能力时返回调用点默认尺寸', () => {
    expect(resolveImageSize(config, 'portrait', '1024x1536')).toBe('1024x1536')
    expect(resolveImageSize(config, 'landscape', '1536x1024')).toBe('1536x1024')
  })

  it('手动首选尺寸优先于默认值', () => {
    const custom = { ...config, capabilities: { portraitSize: '768x1152' } }
    expect(resolveImageSize(custom, 'portrait', '1024x1536')).toBe('768x1152')
  })

  it('首选尺寸不在支持列表时从列表选择方向兼容的尺寸', () => {
    const custom = { ...config, capabilities: { imageSizes: ['1024x1024', '768x1152', '1536x1024'] } }
    expect(resolveImageSize(custom, 'portrait', '1024x1536')).toBe('768x1152')
    expect(resolveImageSize(custom, 'landscape', '1536x1024')).toBe('1536x1024')
  })

  it('首选尺寸在支持列表中时保持首选', () => {
    const custom = { ...config, capabilities: { imageSizes: ['1024x1536', '1536x1024'], portraitSize: '1024x1536' } }
    expect(resolveImageSize(custom, 'portrait', '1024x1536')).toBe('1024x1536')
  })

  it('支持列表没有兼容方向的尺寸时明确报错而不是静默替换', () => {
    const custom = { ...config, capabilities: { imageSizes: ['1536x1024'] } }
    expect(() => resolveImageSize(custom, 'portrait', '1024x1536')).toThrow('不支持竖版尺寸')
  })
})
