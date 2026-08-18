// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TimelineMessage from './TimelineMessage'

afterEach(() => cleanup())

const userMessage = {
  id: 'user-1',
  projectId: 'project-1',
  kind: 'user' as const,
  text: '原始创作要求',
  order: 1,
  createdAt: 1,
}

function renderEditableMessage(onEditUserMessage = vi.fn().mockResolvedValue(true)) {
  render(
    <main className="app-shell" data-appearance="light">
      <TimelineMessage
        message={userMessage}
        canEditUserMessage
        onEditUserMessage={onEditUserMessage}
        onRetryIllustration={vi.fn()}
        imageProviderReady={false}
        onOpenImageSettings={vi.fn()}
        characters={[]}
        onOpenCharacterAssets={vi.fn()}
        onOpenIllustration={vi.fn()}
      />
    </main>,
  )
  return onEditUserMessage
}

describe('EditableUserMessage bottom sheet', () => {
  it('keeps the message bubble intact and saves from the bottom sheet', async () => {
    const user = userEvent.setup()
    const onEditUserMessage = renderEditableMessage()

    await user.click(screen.getByRole('button', { name: '编辑已发送内容' }))

    const editor = screen.getByRole('dialog', { name: '编辑已发送内容' })
    const textarea = screen.getByRole('textbox', { name: '编辑已发送内容' })
    expect(editor.classList.contains('user-message-edit-sheet')).toBe(true)
    expect(document.querySelector('.user-bubble')?.textContent).toContain('原始创作要求')
    expect(textarea).toHaveProperty('value', '原始创作要求')

    await user.clear(textarea)
    await user.type(textarea, '修改后的创作要求')
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect(onEditUserMessage).toHaveBeenCalledWith(userMessage, '修改后的创作要求')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑已发送内容' })).toBeNull())
  })

  it('discards an unfinished draft when cancelled', async () => {
    const user = userEvent.setup()
    renderEditableMessage()

    const trigger = screen.getByRole('button', { name: '编辑已发送内容' })
    await user.click(trigger)
    const textarea = screen.getByRole('textbox', { name: '编辑已发送内容' })
    await user.clear(textarea)
    await user.type(textarea, '不保存的内容')
    await user.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑已发送内容' })).toBeNull())
    await user.click(screen.getByRole('button', { name: '编辑已发送内容' }))
    expect(screen.getByRole('textbox', { name: '编辑已发送内容' })).toHaveProperty('value', '原始创作要求')
  })
})
