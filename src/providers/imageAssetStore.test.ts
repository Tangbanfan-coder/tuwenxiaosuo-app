import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeMocks = vi.hoisted(() => ({ native: true }))
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
}))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: filesystemMocks,
}))
vi.mock('@capgo/capacitor-file-sharer', () => ({ FileSharer: { save: vi.fn() } }))

import { persistImageAsset } from './imageAssetStore'

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
})

afterEach(() => vi.clearAllMocks())

describe('persistImageAsset', () => {
  it('writes large base64 PNG data in aligned chunks and validates only the file head and tail', async () => {
    const base64 = pngBase64(450_000)
    const source = `data:image/png;base64,${base64}`

    await expect(persistImageAsset(source, 'project-1', 'asset-1')).resolves.toMatchObject({
      imageUrl: source,
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
})
