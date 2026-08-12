// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReasoningEffortQuickControl from './ReasoningEffortQuickControl'

afterEach(() => cleanup())

describe('ReasoningEffortQuickControl', () => {
  it('updates the selected level and closes from Escape or an outside pointer', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<><ReasoningEffortQuickControl value="auto" onChange={onChange} /><button type="button">外部</button></>)

    const trigger = screen.getByRole('button', { name: '文本模型思考等级：自动' })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitemradio', { name: '高' }))
    expect(onChange).toHaveBeenCalledWith('high')
    expect(screen.queryByRole('menu')).toBeNull()

    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: '外部' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
