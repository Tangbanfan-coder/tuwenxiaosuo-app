// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ComposerAssetsMenu from './ComposerAssetsMenu'

afterEach(() => cleanup())

describe('ComposerAssetsMenu', () => {
  it('opens both material entry points and returns focus after Escape', async () => {
    const user = userEvent.setup()
    const onOpenCharacterAssets = vi.fn()
    const onOpenReferenceImage = vi.fn()
    render(<ComposerAssetsMenu onOpenCharacterAssets={onOpenCharacterAssets} onOpenReferenceImage={onOpenReferenceImage} />)

    const trigger = screen.getByRole('button', { name: '素材' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: '添加素材' })).toBeDefined()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /人物资产/ })))
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭素材菜单' }))
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /参考图/ }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭素材菜单' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加素材' })).toBeNull())
    expect(document.activeElement).toBe(trigger)

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: /人物资产/ }))
    expect(onOpenCharacterAssets).toHaveBeenCalledOnce()

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: /参考图/ }))
    expect(onOpenReferenceImage).toHaveBeenCalledOnce()
  })
})
