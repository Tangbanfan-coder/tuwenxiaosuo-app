// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterAsset } from '../domain/models'
import ReferenceImageDialog, { isHeicReferenceFile, referenceFileToDataUrl } from './ReferenceImageDialog'

const existingCharacter: CharacterAsset = {
  id: 'character-1',
  projectId: 'project-1',
  name: '林昭',
  role: '主角',
  identity: { ageAndBuild: '', fixedTraits: [] },
  appearance: { defaultLook: '', wardrobe: '' },
  continuity: { revision: 0, referenceStyleMode: 'project' },
  portraitStatus: 'confirmed',
  status: 'confirmed',
  createdAt: 1,
  updatedAt: 1,
}

const NORMALIZED_PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
  73, 69, 78, 68, 174, 66, 96, 130,
])

beforeEach(() => {
  window.requestAnimationFrame = vi.fn((callback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mockImageNormalization(width = 12, height = 8) {
  const close = vi.fn()
  const drawImage = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width, height, close }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob([NORMALIZED_PNG_BYTES], { type: 'image/png' })))
  return { close, drawImage }
}

function dataUrlBytes(dataUrl: string) {
  return Uint8Array.from(atob(dataUrl.split(',')[1]), (character) => character.charCodeAt(0))
}

describe('ReferenceImageDialog', () => {
  it('uses a dedicated full-width secondary action to create a character without a reference image', async () => {
    const user = userEvent.setup()
    let finishCreate: (() => void) | undefined
    const onCreate = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { finishCreate = resolve }))
    render(<ReferenceImageDialog open characters={[]} onClose={vi.fn()} onImport={vi.fn()} onCreate={onCreate} />)

    await user.type(screen.getByPlaceholderText('请使用故事中会出现的名字'), '顾遥')
    const createButton = screen.getByRole('button', { name: '只创建角色' })
    expect(createButton.classList.contains('reference-create-character-button')).toBe(true)
    expect(createButton.hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: '导入参考图' }).hasAttribute('disabled')).toBe(true)

    await user.click(createButton)
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: '顾遥', role: '主要角色' }))
    const creatingButton = screen.getByRole('button', { name: '正在创建…' })
    expect(creatingButton.getAttribute('aria-busy')).toBe('true')
    expect(creatingButton.hasAttribute('disabled')).toBe(true)

    finishCreate?.()
    await waitFor(() => expect(screen.getByRole('button', { name: '只创建角色' }).getAttribute('aria-busy')).toBe('false'))
  })

  it('已有角色时仍可新建第二个角色并上传参考图', async () => {
    const user = userEvent.setup()
    const onImport = vi.fn().mockResolvedValue(undefined)
    mockImageNormalization()
    render(<ReferenceImageDialog open characters={[existingCharacter]} onClose={vi.fn()} onImport={onImport} />)

    await user.click(screen.getByRole('button', { name: /林昭/ }))
    await user.click(screen.getByRole('option', { name: /新建角色/ }))
    await user.type(screen.getByPlaceholderText('请使用故事中会出现的名字'), '顾遥')
    await user.clear(screen.getByPlaceholderText('例如：主角、侦探、少年'))
    await user.type(screen.getByPlaceholderText('例如：主角、侦探、少年'), '侦探')
    await user.upload(screen.getByLabelText('选择角色参考图片'), new File(['png'], 'reference.png', { type: 'image/png' }))

    await waitFor(() => expect(screen.getByAltText('待导入的角色参考图预览')).toBeDefined())
    await user.click(screen.getByRole('button', { name: '导入参考图' }))

    await waitFor(() => expect(onImport).toHaveBeenCalledWith(
      { name: '顾遥', role: '侦探' },
      expect.stringMatching(/^data:image\/png;base64,/),
      'project',
    ))
  })

  it('快速连续选择时只保留最后一个文件的预览和导入结果', async () => {
    const user = userEvent.setup()
    const onImport = vi.fn().mockResolvedValue(undefined)
    const closeFirst = vi.fn()
    let resolveFirst: ((image: { width: number; height: number; close: () => void }) => void) | undefined
    const firstDecode = new Promise<{ width: number; height: number; close: () => void }>((resolve) => {
      resolveFirst = resolve
    })
    vi.stubGlobal('createImageBitmap', vi.fn((file: File) => file.name === 'a.jpg'
      ? firstDecode
      : Promise.resolve({ width: 20, height: 8, close: vi.fn() })))
    let drawnWidth = 0
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: (image: { width: number }) => { drawnWidth = image.width },
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob([String(drawnWidth)], { type: 'image/png' })))
    render(<ReferenceImageDialog open characters={[existingCharacter]} onClose={vi.fn()} onImport={onImport} />)

    const picker = screen.getByLabelText('选择角色参考图片')
    await user.upload(picker, new File(['a'], 'a.jpg', { type: 'image/jpeg' }))
    await user.upload(picker, new File(['b'], 'b.jpg', { type: 'image/jpeg' }))

    await waitFor(() => expect(screen.getByAltText('待导入的角色参考图预览').getAttribute('src')).toBe('data:image/png;base64,MjA='))
    resolveFirst?.({ width: 10, height: 8, close: closeFirst })
    await waitFor(() => expect(closeFirst).toHaveBeenCalled())
    expect(screen.getByAltText('待导入的角色参考图预览').getAttribute('src')).toBe('data:image/png;base64,MjA=')

    await user.click(screen.getByRole('button', { name: '导入参考图' }))
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(
      { characterId: 'character-1' },
      'data:image/png;base64,MjA=',
      'project',
    ))
  })

  it('识别 HEIC/HEIF MIME 和扩展名', () => {
    expect(isHeicReferenceFile(new File([], 'portrait.bin', { type: 'image/heic' }))).toBe(true)
    expect(isHeicReferenceFile(new File([], 'portrait.HEIF', { type: '' }))).toBe(true)
    expect(isHeicReferenceFile(new File([], 'portrait.jpg', { type: 'image/jpeg' }))).toBe(false)
  })

  it('普通 JPEG 也会经 Canvas 归一化为 PNG', async () => {
    const { close, drawImage } = mockImageNormalization()

    const result = await referenceFileToDataUrl(new File(['jpeg'], 'portrait.jpg', { type: 'image/jpeg' }))

    expect(result).toMatch(/^data:image\/png;base64,/)
    expect(drawImage).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('可解码但缺少 JPEG 结束标记的图片仍会转成完整 PNG', async () => {
    mockImageNormalization()
    const incompleteJpeg = new File([new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70])], 'wechat.jpg', { type: 'image/jpeg' })

    const result = await referenceFileToDataUrl(incompleteJpeg)

    expect(result).toMatch(/^data:image\/png;base64,/)
    expect(dataUrlBytes(result)).toEqual(NORMALIZED_PNG_BYTES)
  })

  it('导入 HEIC 时解码并输出 PNG data URL', async () => {
    mockImageNormalization()

    await expect(referenceFileToDataUrl(new File(['heic'], 'portrait.heic', { type: 'image/heic' })))
      .resolves.toMatch(/^data:image\/png;base64,/)
  })

  it('设备不能解码 HEIC 时给出可恢复的导入错误', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')))
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null

      set src(_value: string) {
        queueMicrotask(() => this.onerror?.())
      }
    })
    await expect(referenceFileToDataUrl(new File(['heic'], 'portrait.heic', { type: 'image/heic' })))
      .rejects.toThrow('无法导入此图片：图片解码失败。请先转换为 JPG、PNG 或 WebP 后重试')
  })

  it('任意无法解码的格式不会原样放行', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')))
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null

      set src(_value: string) {
        queueMicrotask(() => this.onerror?.())
      }
    })

    await expect(referenceFileToDataUrl(new File(['tiff'], 'portrait.tiff', { type: 'image/tiff' })))
      .rejects.toThrow('无法导入此图片：图片解码失败。请先转换为 JPG、PNG 或 WebP 后重试')
  })

  it('兜底图片解码器无响应时不会永久等待', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')))
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {}
    })

    const conversion = referenceFileToDataUrl(new File(['heic'], 'portrait.heic', { type: 'image/heic' }))
    const rejection = expect(conversion).rejects.toThrow('无法导入此图片：图片解码超时。请先转换为 JPG、PNG 或 WebP 后重试')
    await vi.runAllTimersAsync()

    await rejection
  })
})
