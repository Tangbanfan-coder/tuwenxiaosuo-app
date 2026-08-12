// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CharacterAsset } from '../domain/models'
import CharacterAssetsDrawer from './CharacterAssetsDrawer'

vi.mock('../providers/imageAssetStore', () => ({ resolveImageSource: (url?: string) => url }))

const character: CharacterAsset = {
  id: 'character-1',
  projectId: 'project-1',
  name: '林昭',
  role: '主角',
  identity: { ageAndBuild: '', fixedTraits: [] },
  appearance: { defaultLook: '', wardrobe: '' },
  continuity: { revision: 0 },
  portraitStatus: 'review',
  status: 'draft',
  createdAt: 1,
  updatedAt: 1,
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function renderDrawer(overrides: Partial<ComponentProps<typeof CharacterAssetsDrawer>> = {}) {
  const props = {
    open: true,
    characters: [character],
    onClose: vi.fn(),
    onGenerate: vi.fn().mockResolvedValue(undefined),
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onReferenceStyleModeChange: vi.fn().mockResolvedValue(undefined),
    onUpdateProfile: vi.fn().mockResolvedValue(undefined),
    onAnalyzeReference: vi.fn().mockResolvedValue(undefined),
    onCreateCharacter: vi.fn(),
    onCancelGeneration: vi.fn(),
    generationActive: false,
    ...overrides,
  }
  const result = render(<CharacterAssetsDrawer {...props} />)
  return { ...result, props }
}

afterEach(() => cleanup())

describe('CharacterAssetsDrawer', () => {
  it('uses in-app radio buttons for narrative pronouns and saves the chosen value', async () => {
    const user = userEvent.setup()
    const { container, props } = renderDrawer()

    await user.click(screen.getByRole('button', { name: '编辑角色 林昭 的档案' }))
    expect(container.querySelector('select')).toBeNull()
    const pronouns = screen.getByRole('radiogroup', { name: '叙事代词' })
    await user.click(screen.getByRole('radio', { name: '她' }))
    expect(pronouns.contains(screen.getByRole('radio', { name: '她' }))).toBe(true)
    expect(screen.getByRole('radio', { name: '她' }).getAttribute('aria-checked')).toBe('true')
    await user.click(screen.getByRole('button', { name: '保存档案' }))

    await waitFor(() => expect(props.onUpdateProfile).toHaveBeenCalledWith('character-1', expect.objectContaining({ narrativePronoun: 'she' })))
  })

  it('shows a character-specific loading state while a regeneration is queued', async () => {
    const user = userEvent.setup()
    const generation = deferred()
    const { props } = renderDrawer({ onGenerate: vi.fn().mockReturnValue(generation.promise) })

    await user.click(screen.getByRole('button', { name: '不满意，生成优化版' }))
    await user.type(screen.getByLabelText('具体哪里不满意？'), '保留短发')
    await user.click(screen.getByRole('button', { name: '生成优化版' }))

    expect((screen.getByRole('button', { name: '正在生成优化版' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('生成中')
    expect(props.onGenerate).toHaveBeenCalledWith('character-1', '保留短发')

    generation.resolve()
    await waitFor(() => expect(screen.queryByRole('button', { name: '正在生成优化版' })).toBeNull())
  })

  it('disables a new portrait action while that character is queued', async () => {
    const user = userEvent.setup()
    const generation = deferred()
    const plannedCharacter = { ...character, portraitStatus: 'planned' as const }
    const { props } = renderDrawer({
      characters: [plannedCharacter],
      onGenerate: vi.fn().mockReturnValue(generation.promise),
    })

    await user.click(screen.getByRole('button', { name: '生成定妆照' }))

    const pendingButton = screen.getByRole('button', { name: '正在生成定妆照' }) as HTMLButtonElement
    expect(pendingButton.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('生成中')
    expect(props.onGenerate).toHaveBeenCalledWith('character-1', undefined)

    generation.resolve()
    await waitFor(() => expect(screen.queryByRole('button', { name: '正在生成定妆照' })).toBeNull())
  })

  it('keeps failed regeneration feedback available for another attempt', async () => {
    const user = userEvent.setup()
    renderDrawer({ onGenerate: vi.fn().mockRejectedValue(new Error('生成失败')) })

    await user.click(screen.getByRole('button', { name: '不满意，生成优化版' }))
    const feedback = screen.getByLabelText('具体哪里不满意？')
    await user.type(feedback, '保留短发')
    await user.click(screen.getByRole('button', { name: '生成优化版' }))

    await waitFor(() => expect((screen.getByRole('button', { name: '生成优化版' }) as HTMLButtonElement).disabled).toBe(false))
    expect((feedback as HTMLTextAreaElement).value).toBe('保留短发')
  })
})
