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

describe('ReferenceImageDialog', () => {
  it('已有角色时仍可新建第二个角色并上传参考图', async () => {
    const user = userEvent.setup()
    const onImport = vi.fn().mockResolvedValue(undefined)
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

  it('识别 HEIC/HEIF MIME 和扩展名', () => {
    expect(isHeicReferenceFile(new File([], 'portrait.bin', { type: 'image/heic' }))).toBe(true)
    expect(isHeicReferenceFile(new File([], 'portrait.HEIF', { type: '' }))).toBe(true)
    expect(isHeicReferenceFile(new File([], 'portrait.jpg', { type: 'image/jpeg' }))).toBe(false)
  })

  it('导入 HEIC 时解码并输出 PNG data URL', async () => {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 12, height: 8, close }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['png'], { type: 'image/png' })))

    const result = await referenceFileToDataUrl(new File(['heic'], 'portrait.heic', { type: 'image/heic' }))

    expect(result).toMatch(/^data:image\/png;base64,/)
    expect(close).toHaveBeenCalled()
  })

  it('设备不能解码 HEIC 时提示先转换格式', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')))
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null

      set src(_value: string) {
        queueMicrotask(() => this.onerror?.())
      }
    })
    await expect(referenceFileToDataUrl(new File(['heic'], 'portrait.heic', { type: 'image/heic' })))
      .rejects.toThrow('请先将图片转换为 JPG、PNG 或 WebP')
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
    const rejection = expect(conversion).rejects.toThrow('请先将图片转换为 JPG、PNG 或 WebP')
    await vi.runAllTimersAsync()

    await rejection
  })
})
