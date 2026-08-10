// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IllustrationLightbox, { type LightboxImage } from './IllustrationLightbox'

const imageAssetMocks = vi.hoisted(() => ({
  saveImageToDevice: vi.fn(),
}))

vi.mock('../providers/imageAssetStore', () => imageAssetMocks)

const image: LightboxImage = {
  source: 'data:image/png;base64,dGVzdA==',
  title: '剧情插画',
  alt: '第一章剧情插画',
  localUri: 'local://illustration.png',
}

beforeEach(() => {
  imageAssetMocks.saveImageToDevice.mockReset()
  imageAssetMocks.saveImageToDevice.mockResolvedValue(undefined)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => cleanup())

describe('IllustrationLightbox', () => {
  it('preserves the dialog contract and zoom controls', async () => {
    const user = userEvent.setup()
    render(<IllustrationLightbox image={image} onClose={() => {}} onToast={() => {}} />)

    expect(screen.getByRole('dialog', { name: image.title })).toBeDefined()
    const preview = screen.getByRole('img', { name: image.alt })
    expect(preview.getAttribute('src')).toBe(image.source)
    expect(preview.getAttribute('style')).toContain('scale(1)')

    await user.click(screen.getByRole('button', { name: '放大' }))
    expect(preview.getAttribute('style')).toContain('scale(1.5)')
    expect(screen.getByText('150%')).toBeDefined()

    await user.click(screen.getByRole('button', { name: '复位缩放' }))
    expect(preview.getAttribute('style')).toContain('scale(1)')
  })

  it('closes from Escape, the close button, and the empty stage', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<IllustrationLightbox image={image} onClose={onClose} onToast={() => {}} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    await user.click(screen.getByRole('button', { name: '关闭图片预览' }))
    fireEvent.pointerDown(screen.getByRole('dialog', { name: image.title }))

    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('keeps the image mounted with the closing class during the exit animation', () => {
    const view = render(<IllustrationLightbox image={image} onClose={() => {}} onToast={() => {}} />)

    view.rerender(<IllustrationLightbox image={undefined} onClose={() => {}} onToast={() => {}} />)

    expect(screen.getByRole('presentation').className).toContain('closing')
    expect(screen.getByRole('dialog', { name: image.title })).toBeDefined()
  })

  it('saves the current image and reports the unchanged success message', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    render(<IllustrationLightbox image={image} onClose={() => {}} onToast={onToast} />)

    await user.click(screen.getByRole('button', { name: '保存图片到手机' }))

    await waitFor(() => expect(imageAssetMocks.saveImageToDevice).toHaveBeenCalledWith(image.source, image.localUri, image.title))
    expect(onToast).toHaveBeenCalledWith('图片已保存到相册')
  })

  it('keeps the detailed save failure message', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    imageAssetMocks.saveImageToDevice.mockRejectedValue(new Error('权限不足'))
    render(<IllustrationLightbox image={image} onClose={() => {}} onToast={onToast} />)

    await user.click(screen.getByRole('button', { name: '保存图片到手机' }))

    await waitFor(() => expect(onToast).toHaveBeenCalledWith('保存失败：权限不足'))
  })
})
