// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user.click(trigger)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: '外部' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('renders caller-provided native effort values and persists max selection', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const options = [
      { value: 'auto', label: '自动' },
      { value: 'low', label: '低' },
      { value: 'high', label: '高' },
      { value: 'max', label: '最大' },
    ] as const
    render(<ReasoningEffortQuickControl value="auto" options={options} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: '文本模型思考等级：自动' }))
    expect(screen.getByRole('menuitemradio', { name: '低' })).toBeDefined()
    expect(screen.getByRole('menuitemradio', { name: '高' })).toBeDefined()
    expect(screen.getByRole('menuitemradio', { name: '最大' })).toBeDefined()
    expect(screen.queryByRole('menuitemradio', { name: '中' })).toBeNull()
    await user.click(screen.getByRole('menuitemradio', { name: '最大' }))
    expect(onChange).toHaveBeenCalledWith('max')
  })

  it('maps a stale non-auto value to the supplied toggle opening option', () => {
    const options = [
      { value: 'auto', label: '自动' },
      { value: 'low', label: '开启' },
    ] as const
    render(<ReasoningEffortQuickControl value="high" options={options} onChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: '文本模型思考等级：开启' })).toBeDefined()
  })
})
