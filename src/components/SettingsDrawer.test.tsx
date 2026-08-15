// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSettings } from '../providers/types'
import SettingsDrawer from './SettingsDrawer'

const providerSettings: ProviderSettings = {
  text: {
    id: 'text-provider',
    name: '文本服务',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    protocol: 'openai-compatible',
    secretRef: 'provider:text',
  },
  image: {
    id: 'image-provider',
    name: '图片服务',
    baseUrl: 'https://example.test/v1',
    model: 'image-model',
    protocol: 'openai-compatible',
    secretRef: 'provider:image',
  },
  textProviders: [],
  imageProviders: [],
}

function renderDrawer(overrides: Partial<Parameters<typeof SettingsDrawer>[0]> = {}) {
  return render(
    <SettingsDrawer
      open
      projectTitle="测试作品"
      activeThemeId="neutral"
      onClose={vi.fn()}
      onThemeChange={vi.fn().mockResolvedValue(undefined)}
      activeIllustrationStyleId="unconstrained"
      activeCustomStylePrompt=""
      onIllustrationStyleChange={vi.fn().mockResolvedValue(undefined)}
      activeWritingInstructions=""
      onEditWritingInstructions={vi.fn()}
      contextBudget="standard"
      onContextBudgetChange={vi.fn().mockResolvedValue(undefined)}
      contextUsageState="empty"
      onOpenContextUsage={vi.fn()}
      onOpenSummaryHistory={vi.fn()}
      providerSettings={providerSettings}
      onOpenProviderSettings={vi.fn()}
      appearanceMode="dark"
      onAppearanceChange={vi.fn()}
      {...overrides}
    />,
  )
}

afterEach(() => cleanup())

describe('SettingsDrawer', () => {
  it('shows category entries and quick controls on the home page', () => {
    renderDrawer()

    expect(screen.getByRole('heading', { name: '设置' })).toBeDefined()
    expect(screen.getByRole('button', { name: /写作/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /记忆与上下文/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /外观/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /模型服务/ })).toBeDefined()
    expect(screen.getByRole('radiogroup', { name: '界面外观' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /摘要版本历史/ })).toBeNull()
  })

  it('opens chapter summary history from the memory page', async () => {
    const user = userEvent.setup()
    const onOpenSummaryHistory = vi.fn()
    renderDrawer({ onOpenSummaryHistory })

    await user.click(screen.getByRole('button', { name: /记忆与上下文/ }))
    expect(screen.getByRole('heading', { name: '记忆与上下文' })).toBeDefined()
    expect(screen.getByText('上下文与记忆')).toBeDefined()
    await user.click(screen.getByRole('button', { name: /摘要版本历史/ }))
    expect(onOpenSummaryHistory).toHaveBeenCalledTimes(1)
  })

  it('navigates between writing subpages and back home', async () => {
    const user = userEvent.setup()
    const onEditGlobalWritingInstructions = vi.fn()
    const onEditWritingInstructions = vi.fn()
    renderDrawer({
      activeWritingInstructions: '局部规则',
      globalWritingInstructions: '全局规则',
      onEditGlobalWritingInstructions,
      onEditWritingInstructions,
    })

    await user.click(screen.getByRole('button', { name: /写作/ }))
    expect(screen.getByRole('heading', { name: '写作' })).toBeDefined()

    const globalHeading = screen.getByRole('heading', { name: '全局创作设定' })
    const globalSection = globalHeading.closest('section')
    const localButton = screen.getByRole('button', { name: /局部创作设定/ })
    expect(globalSection?.querySelector('button')?.textContent).toContain('全局创作设定')
    expect(globalSection?.textContent).not.toContain('摘要版本历史')
    expect(globalSection?.compareDocumentPosition(localButton.closest('section')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    await user.click(screen.getByRole('button', { name: /全局创作设定/ }))
    expect(onEditGlobalWritingInstructions).toHaveBeenCalledTimes(1)
    await user.click(localButton)
    expect(onEditWritingInstructions).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '返回设置' }))
    expect(screen.getByRole('heading', { name: '设置' })).toBeDefined()
    expect(screen.getByRole('button', { name: /模型服务/ })).toBeDefined()
  })

  it('opens the global style corpus from the writing page', async () => {
    const user = userEvent.setup()
    const onOpenStyleCorpus = vi.fn()
    renderDrawer({
      styleCorpusSummary: { sourceCount: 2, fragmentCount: 8 },
      onOpenStyleCorpus,
    })

    await user.click(screen.getByRole('button', { name: /写作/ }))
    const button = screen.getByRole('button', { name: /风格语料库/ })
    expect(button.textContent).toContain('2 个来源 · 8 个片段')
    await user.click(button)
    expect(onOpenStyleCorpus).toHaveBeenCalledTimes(1)
  })

  it('opens provider settings from the model service page', async () => {
    const user = userEvent.setup()
    const onOpenProviderSettings = vi.fn()
    renderDrawer({ onOpenProviderSettings })

    await user.click(screen.getByRole('button', { name: /模型服务/ }))
    await user.click(screen.getByRole('button', { name: /图片模型/ }))
    expect(onOpenProviderSettings).toHaveBeenCalledWith('image')
  })

  it('returns home with Escape from a subpage before closing', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDrawer({ onClose })

    await user.click(screen.getByRole('button', { name: /外观/ }))
    expect(screen.getByRole('heading', { name: '外观' })).toBeDefined()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('heading', { name: '设置' })).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the settings layer open but ignores Escape while a subpage is above it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDrawer({ suspended: true, onClose })

    expect(screen.getByRole('dialog', { hidden: true }).getAttribute('data-suspended')).toBe('true')
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })
})
