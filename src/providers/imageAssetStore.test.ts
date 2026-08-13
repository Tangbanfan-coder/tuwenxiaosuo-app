import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeMocks = vi.hoisted(() => ({ native: true }))
const nativeAssetStoreMocks = vi.hoisted(() => ({ download: vi.fn(), generate: vi.fn() }))
const secretStoreMocks = vi.hoisted(() => ({ get: vi.fn() }))
const backgroundGenerationMocks = vi.hoisted(() => ({ enqueue: vi.fn(), wait: vi.fn(), acknowledge: vi.fn() }))
const loggerMocks = vi.hoisted(() => ({ write: vi.fn().mockResolvedValue(undefined) }))
const filesystemMocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  appendFile: vi.fn(),
  deleteFile: vi.fn(),
  getUri: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => nativeMocks.native,
    convertFileSrc: (value: string) => value,
  },
  registerPlugin: (name: string) => name === 'ImageAssetStore'
    ? nativeAssetStoreMocks
    : loggerMocks,
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: filesystemMocks,
}))
vi.mock('@capgo/capacitor-file-sharer', () => ({ FileSharer: { save: vi.fn() } }))
vi.mock('./secretStore', () => ({ secretStore: secretStoreMocks }))
vi.mock('./backgroundGeneration', () => ({
  enqueueBackgroundImageTask: backgroundGenerationMocks.enqueue,
  waitForBackgroundGenerationTask: backgroundGenerationMocks.wait,
  acknowledgeBackgroundGenerationTask: backgroundGenerationMocks.acknowledge,
}))

import { generateNativeImageAsset, persistImageAsset } from './imageAssetStore'

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function pngBase64(size = 96) {
  const bytes = new Uint8Array(size)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  bytes.set([73, 69, 78, 68, 174, 66, 96, 130], size - 8)
  return bytesToBase64(bytes)
}

function jpegBase64(size = 96) {
  const bytes = new Uint8Array(size)
  bytes.set([255, 216, 255])
  bytes.set([255, 217], size - 2)
  return bytesToBase64(bytes)
}

function byteLength(base64: string) {
  return atob(base64).length
}

beforeEach(() => {
  nativeMocks.native = true
  filesystemMocks.files.clear()
  vi.clearAllMocks()
  secretStoreMocks.get.mockResolvedValue('secret-token')
  filesystemMocks.mkdir.mockResolvedValue(undefined)
  filesystemMocks.writeFile.mockImplementation(async ({ path, data }: { path: string; data: string }) => {
    filesystemMocks.files.set(path, data)
    return { uri: `file://${path}` }
  })
  filesystemMocks.appendFile.mockImplementation(async ({ path, data }: { path: string; data: string }) => {
    filesystemMocks.files.set(path, `${filesystemMocks.files.get(path) ?? ''}${data}`)
  })
  filesystemMocks.rename.mockImplementation(async ({ from, to }: { from: string; to: string }) => {
    const data = filesystemMocks.files.get(from)
    if (!data) throw new Error('source missing')
    filesystemMocks.files.set(to, data)
    filesystemMocks.files.delete(from)
  })
  filesystemMocks.deleteFile.mockImplementation(async ({ path }: { path: string }) => {
    filesystemMocks.files.delete(path)
  })
  filesystemMocks.stat.mockImplementation(async ({ path }: { path: string }) => {
    const data = filesystemMocks.files.get(path)
    if (!data) throw new Error('not found')
    return { type: 'file', size: byteLength(data), mtime: Date.now(), ctime: Date.now(), uri: `file://${path}` }
  })
  filesystemMocks.readFile.mockImplementation(async ({ path, offset = 0, length = -1 }: { path: string; offset?: number; length?: number }) => {
    const data = filesystemMocks.files.get(path)
    if (!data) throw new Error('not found')
    const bytes = atob(data)
    const end = length > 0 ? offset + length : bytes.length
    return { data: btoa(bytes.slice(offset, end)) }
  })
  filesystemMocks.getUri.mockImplementation(async ({ path }: { path: string }) => ({ uri: `file://${path}` }))
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => vi.restoreAllMocks())

describe('persistImageAsset', () => {
  it('delegates native generation directly to the plugin and returns only its local URI', async () => {
    nativeAssetStoreMocks.generate.mockResolvedValue({
      localUri: 'file://projects/project-1/images/asset-1.png', format: 'png', bytes: 2_400_000, responseMode: 'b64_json',
      responseMs: 60_000, writeMs: 35, validationAndReplaceMs: 12, durationMs: 60_047,
    })

    await expect(generateNativeImageAsset({
      endpoint: 'https://api.test/v1/images/generations', model: 'gpt-image-2', prompt: '生成插画', size: '1536x1024',
      target: { projectId: 'project-1', assetId: 'asset-1' }, secretRef: 'image-key',
    })).resolves.toEqual({ imageUrl: '', localUri: 'file://projects/project-1/images/asset-1.png' })
    expect(nativeAssetStoreMocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://api.test/v1/images/generations', projectId: 'project-1', assetId: 'asset-1', bearerToken: 'secret-token',
    }))
  })

  it('logs background generation metrics before acknowledging the completed task', async () => {
    const calls: string[] = []
    backgroundGenerationMocks.enqueue.mockImplementation(async () => { calls.push('enqueue'); return { id: 'background-1', state: 'prepared' } })
    backgroundGenerationMocks.wait.mockImplementation(async () => {
      calls.push('wait')
      return { id: 'background-1', kind: 'image', state: 'completed', localUri: 'file://projects/project-1/images/asset-1.png', bytes: 2_400_000, format: 'png', responseMode: 'b64_json', responseMs: 60_000, writeMs: 35, validationAndReplaceMs: 12, durationMs: 60_047 }
    })
    loggerMocks.write.mockImplementation(async () => { calls.push('log') })
    backgroundGenerationMocks.acknowledge.mockImplementation(async () => { calls.push('acknowledge') })

    await expect(generateNativeImageAsset({
      endpoint: 'https://api.test/v1/images/generations', model: 'gpt-image-2', prompt: '生成插画', size: '1536x1024',
      target: { projectId: 'project-1', assetId: 'asset-1' }, secretRef: 'image-key',
    })).resolves.toEqual({ imageUrl: '', localUri: 'file://projects/project-1/images/asset-1.png' })

    expect(loggerMocks.write).toHaveBeenCalledWith({
      level: 'info',
      message: '{"phase":"native-generation-persist-complete","operation":"generation","format":"png","bytes":2400000,"responseMode":"b64_json","responseMs":60000,"writeMs":35,"validationAndReplaceMs":12,"durationMs":60047}',
    })
    expect(calls).toEqual(['enqueue', 'wait', 'log', 'acknowledge'])
  })

  it('does not invoke the native plugin on Web, preserving the transport fallback', async () => {
    nativeMocks.native = false
    await expect(generateNativeImageAsset({
      endpoint: 'https://api.test/v1/images/generations', model: 'gpt-image-2', prompt: '生成插画', size: '1536x1024',
      target: { projectId: 'project-1', assetId: 'asset-1' }, secretRef: 'image-key',
    })).resolves.toBeUndefined()
    expect(nativeAssetStoreMocks.generate).not.toHaveBeenCalled()
  })

  it('writes large base64 PNG data in aligned chunks and validates only the file head and tail', async () => {
    const base64 = pngBase64(450_000)
    const source = `data:image/png;base64,${base64}`

    await expect(persistImageAsset(source, 'project-1', 'asset-1')).resolves.toMatchObject({
      imageUrl: '',
      localUri: 'file://projects/project-1/images/asset-1.png',
    })

    expect(filesystemMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(filesystemMocks.appendFile).toHaveBeenCalled()
    const writtenChunks = [
      filesystemMocks.writeFile.mock.calls[0][0].data,
      ...filesystemMocks.appendFile.mock.calls.map(([options]) => options.data),
    ]
    expect(writtenChunks.join('')).toBe(base64)
    expect(writtenChunks.every((chunk) => chunk.length % 4 === 0)).toBe(true)
    expect(filesystemMocks.readFile).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, length: 64 }))
    expect(filesystemMocks.readFile.mock.calls.every(([options]) => options.length === 64)).toBe(true)
  })

  it('normalizes Android-style wrapped base64 before aligned chunk writes', async () => {
    const base64 = pngBase64(450_000)
    const wrapped = base64.replace(/.{76}/g, '$&\r\n')

    await expect(persistImageAsset(`data:image/png;base64,${wrapped}`, 'project-1', 'asset-1')).resolves.toMatchObject({
      localUri: 'file://projects/project-1/images/asset-1.png',
    })

    const writtenChunks = [
      filesystemMocks.writeFile.mock.calls[0][0].data,
      ...filesystemMocks.appendFile.mock.calls.map(([options]) => options.data),
    ]
    expect(writtenChunks.join('')).toBe(base64)
    expect(writtenChunks.every((chunk) => chunk.length % 4 === 0)).toBe(true)
  })

  it('validates JPEG data URLs from their file head and tail without a full bridge read', async () => {
    const source = `data:image/jpeg;base64,${jpegBase64()}`

    await expect(persistImageAsset(source, 'project-1', 'asset-1')).resolves.toMatchObject({
      localUri: 'file://projects/project-1/images/asset-1.jpg',
    })

    expect(filesystemMocks.readFile).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, length: 64 }))
    expect(filesystemMocks.readFile.mock.calls.every(([options]) => options.length === 64)).toBe(true)
  })

  it('reports saving then validating and keeps Android storage local-only', async () => {
    const stages: string[] = []
    const source = `data:image/png;base64,${pngBase64()}`

    await expect(persistImageAsset(source, 'project-1', 'asset-1', 'generated', (stage) => stages.push(stage)))
      .resolves.toEqual({ imageUrl: '', localUri: 'file://projects/project-1/images/asset-1.png' })

    expect(stages).toEqual(['saving', 'validating'])
  })

  it('rejects a truncated PNG even when its header is valid', async () => {
    const truncated = pngBase64().slice(0, -8)

    await expect(persistImageAsset(`data:image/png;base64,${truncated}`, 'project-1', 'asset-1'))
      .rejects.toThrow('图片已生成，但无法保存到手机本地（图片文件不完整）')
  })

  it('reports import storage failures without claiming that the image was generated', async () => {
    const truncated = pngBase64().slice(0, -8)

    await expect(persistImageAsset(`data:image/png;base64,${truncated}`, 'project-1', 'asset-1', 'imported'))
      .rejects.toThrow('参考图无法保存到手机本地（图片文件不完整）')
  })

  it('rejects a URL that was not downloaded through the authenticated provider channel', async () => {
    await expect(persistImageAsset('https://example.test/image', 'project-1', 'asset-1'))
      .rejects.toThrow('图片数据尚未下载为可保存的格式')
    expect(filesystemMocks.writeFile).not.toHaveBeenCalled()
  })

  it('streams a remote URL through the native plugin without returning Base64 to JS', async () => {
    nativeAssetStoreMocks.download.mockResolvedValue({
      localUri: 'file://projects/project-1/images/asset-1.png', format: 'png', bytes: 2_400_000,
      responseMs: 320, writeMs: 90, validationAndReplaceMs: 12, durationMs: 422,
    })
    const source = { kind: 'remote' as const, url: 'https://api.test/image.png', auth: { kind: 'bearer' as const, secretRef: 'image-key' } }

    const stages: string[] = []
    await expect(persistImageAsset(source, 'project-1', 'asset-1', 'generated', (stage) => stages.push(stage))).resolves.toEqual({
      imageUrl: '', localUri: 'file://projects/project-1/images/asset-1.png',
    })
    expect(nativeAssetStoreMocks.download).toHaveBeenCalledWith({
      url: 'https://api.test/image.png', projectId: 'project-1', assetId: 'asset-1', bearerToken: 'secret-token',
    })
    expect(stages).toEqual(['saving', 'validating'])
    expect(filesystemMocks.writeFile).not.toHaveBeenCalled()
  })

  it('never adds provider credentials to a cross-origin remote source', async () => {
    nativeAssetStoreMocks.download.mockResolvedValue({
      localUri: 'file://asset.png', format: 'png', bytes: 10, responseMs: 1, writeMs: 1, validationAndReplaceMs: 1, durationMs: 3,
    })
    await persistImageAsset({ kind: 'remote', url: 'https://cdn.test/image.png' }, 'project-1', 'asset-1')
    expect(nativeAssetStoreMocks.download).toHaveBeenCalledWith(expect.objectContaining({ bearerToken: undefined }))
    expect(secretStoreMocks.get).not.toHaveBeenCalled()
  })

  it('explains an anonymous CDN authorization failure without retrying with a key', async () => {
    nativeAssetStoreMocks.download.mockRejectedValue({ data: { status: 403 } })
    await expect(persistImageAsset({ kind: 'remote', url: 'https://cdn.test/image.png' }, 'project-1', 'asset-1'))
      .rejects.toThrow('不会向该地址发送凭据')
    expect(nativeAssetStoreMocks.download).toHaveBeenCalledTimes(1)
    expect(secretStoreMocks.get).not.toHaveBeenCalled()
  })

  it('replaces an existing final image after validating the temporary image', async () => {
    const path = 'projects/project-1/images/asset-1.jpg'
    const temporaryPath = 'projects/project-1/images/asset-1.tmp'
    const previous = jpegBase64()
    const next = jpegBase64(128)
    filesystemMocks.files.set(path, previous)
    let rejectedDirectReplacement = false
    filesystemMocks.rename.mockImplementation(async ({ from, to }: { from: string; to: string }) => {
      if (from === temporaryPath && to === path && !rejectedDirectReplacement) {
        rejectedDirectReplacement = true
        throw new Error('target exists')
      }
      const data = filesystemMocks.files.get(from)
      if (!data) throw new Error('source missing')
      filesystemMocks.files.set(to, data)
      filesystemMocks.files.delete(from)
    })

    await expect(persistImageAsset(`data:image/jpeg;base64,${next}`, 'project-1', 'asset-1')).resolves.toMatchObject({
      localUri: `file://${path}`,
    })
    expect(filesystemMocks.files.get(path)).toBe(next)
    expect(filesystemMocks.rename).toHaveBeenCalledWith(expect.objectContaining({
      from: path,
      to: `${temporaryPath}.previous`,
    }))
  })

  it('does not report an older final image as recovery when the current save fails', async () => {
    const path = 'projects/project-1/images/asset-1.jpg'
    filesystemMocks.files.set(path, jpegBase64())
    filesystemMocks.writeFile.mockRejectedValue(new Error('disk full'))
    filesystemMocks.stat.mockImplementation(async ({ path: requestedPath }: { path: string }) => {
      const data = filesystemMocks.files.get(requestedPath)
      if (!data) throw new Error('not found')
      return {
        type: 'file',
        size: byteLength(data),
        mtime: requestedPath === path ? 1 : Date.now(),
        ctime: requestedPath === path ? 1 : Date.now(),
        uri: `file://${requestedPath}`,
      }
    })

    await expect(persistImageAsset(`data:image/jpeg;base64,${jpegBase64(128)}`, 'project-1', 'asset-1'))
      .rejects.toThrow('图片已生成，但无法保存到手机本地')
  })

  it('keeps Web image storage on the existing pass-through path', async () => {
    nativeMocks.native = false
    const source = 'data:image/png;base64,AAAA'

    await expect(persistImageAsset(source, 'project-1', 'asset-1')).resolves.toEqual({ imageUrl: source })
    expect(filesystemMocks.writeFile).not.toHaveBeenCalled()
  })

  it('keeps Web remote storage on the URL pass-through path', async () => {
    nativeMocks.native = false
    await expect(persistImageAsset({ kind: 'remote', url: 'https://cdn.test/image.png' }, 'project-1', 'asset-1'))
      .resolves.toEqual({ imageUrl: 'https://cdn.test/image.png' })
    expect(nativeAssetStoreMocks.download).not.toHaveBeenCalled()
  })
})
