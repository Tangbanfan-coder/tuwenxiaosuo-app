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

afterEach(() => cleanup())

describe('SettingsDrawer', () => {
  it('opens chapter summary history from the context and memory section', async () => {
    const user = userEvent.setup()
    const onOpenSummaryHistory = vi.fn()
    render(
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
        onOpenSummaryHistory={onOpenSummaryHistory}
        providerSettings={providerSettings}
        onOpenProviderSettings={vi.fn()}
        appearanceMode="dark"
        onAppearanceChange={vi.fn()}
      />,
    )

    expect(screen.getByText('上下文与记忆')).toBeDefined()
    await user.click(screen.getByRole('button', { name: /摘要版本历史/ }))
    expect(onOpenSummaryHistory).toHaveBeenCalledTimes(1)
  })

  it('keeps the settings layer open but ignores Escape while a subpage is above it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <SettingsDrawer
        open
        suspended
        projectTitle="测试作品"
        activeThemeId="neutral"
        onClose={onClose}
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
      />,
    )

    expect(screen.getByRole('dialog', { hidden: true }).getAttribute('data-suspended')).toBe('true')
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })
})
