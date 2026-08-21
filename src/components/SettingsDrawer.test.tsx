// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

function drawerProps(overrides: Partial<Parameters<typeof SettingsDrawer>[0]> = {}) {
  return {
    open: true,
    projectTitle: '测试作品',
    activeThemeId: 'neutral' as const,
    onClose: vi.fn(),
    onThemeChange: vi.fn().mockResolvedValue(undefined),
    activeIllustrationStyleId: 'unconstrained' as const,
    activeCustomStylePrompt: '',
    onIllustrationStyleChange: vi.fn().mockResolvedValue(undefined),
    activeWritingInstructions: '',
    onEditWritingInstructions: vi.fn(),
    contextBudget: 'standard' as const,
    onContextBudgetChange: vi.fn().mockResolvedValue(undefined),
    contextUsageState: 'empty' as const,
    onOpenContextUsage: vi.fn(),
    onOpenSummaryHistory: vi.fn(),
    providerSettings,
    onOpenProviderSettings: vi.fn(),
    appearanceMode: 'dark' as const,
    onAppearanceChange: vi.fn(),
    ...overrides,
  }
}

function renderDrawer(overrides: Partial<Parameters<typeof SettingsDrawer>[0]> = {}) {
  return render(<SettingsDrawer {...drawerProps(overrides)} />)
}

async function waitForPageSettled(targetHeading: string) {
  const heading = await screen.findByRole('heading', { name: targetHeading })
  await waitFor(() => expect(document.querySelector('.settings-content--exiting')).toBeNull())
  await waitFor(() => expect(heading.isConnected).toBe(true))
  const closeButton = screen.queryByRole('button', { name: '返回设置' })
  if (closeButton) {
    await waitFor(() => expect(document.activeElement).toBe(closeButton))
  }
}

afterEach(() => cleanup())

describe('SettingsDrawer', () => {
  it('shows category entries and app appearance controls on the home page', () => {
    renderDrawer()

    expect(screen.getByRole('heading', { name: '设置' })).toBeDefined()
    expect(screen.getByRole('button', { name: /写作/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /记忆与上下文/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /外观/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /模型服务/ })).toBeDefined()
    expect(screen.getByRole('radiogroup', { name: '界面外观' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /中性纸墨/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /摘要版本历史/ })).toBeNull()
  })

  it('opens chapter summary history from the memory page', async () => {
    const user = userEvent.setup()
    const onOpenSummaryHistory = vi.fn()
    renderDrawer({ onOpenSummaryHistory })

    await user.click(screen.getByRole('button', { name: /记忆与上下文/ }))
    await waitForPageSettled('记忆与上下文')
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
    await waitForPageSettled('写作')

    const globalHeading = screen.getByRole('heading', { name: '全局创作设定' })
    const globalSection = globalHeading.closest('section')
    const toolsHeading = screen.getByRole('heading', { name: '创作辅助' })
    const toolsSection = toolsHeading.closest('section')
    const localButton = screen.getByRole('button', { name: /局部创作设定/ })
    expect(globalSection?.querySelector('button')?.textContent).toContain('全局创作设定')
    expect(globalSection?.textContent).not.toContain('风格语料库')
    expect(globalSection?.textContent).not.toContain('文风优化数据')
    expect(toolsSection?.textContent).toContain('风格语料库')
    expect(toolsSection?.textContent).toContain('文风优化数据')
    expect(globalSection?.compareDocumentPosition(localButton.closest('section')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    await user.click(screen.getByRole('button', { name: /全局创作设定/ }))
    expect(onEditGlobalWritingInstructions).toHaveBeenCalledTimes(1)
    await user.click(localButton)
    expect(onEditWritingInstructions).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '返回设置' }))
    await waitForPageSettled('设置')
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
    await waitForPageSettled('写作')
    const button = screen.getByRole('button', { name: /风格语料库/ })
    expect(button.textContent).toContain('2 个来源 · 8 个片段')
    await user.click(button)
    expect(onOpenStyleCorpus).toHaveBeenCalledTimes(1)
  })

  it('keeps independent writing and memory actions outside a joined list', async () => {
    const user = userEvent.setup()
    renderDrawer()

    await user.click(screen.getByRole('button', { name: /写作/ }))
    await waitForPageSettled('写作')
    expect(screen.getByRole('button', { name: /全局创作设定/ }).closest('.settings-navigation-list')).toBeNull()
    expect(screen.getByRole('button', { name: /风格语料库/ }).closest('.settings-navigation-list')).toBeNull()
    expect(screen.getByRole('button', { name: /文风优化数据/ }).closest('.settings-navigation-list')).toBeNull()

    await user.click(screen.getByRole('button', { name: '返回设置' }))
    await waitForPageSettled('设置')
    await user.click(screen.getByRole('button', { name: /记忆与上下文/ }))
    await waitForPageSettled('记忆与上下文')
    expect(screen.getByRole('button', { name: /查看本轮上下文用量/ }).closest('.settings-navigation-list')).toBeNull()
    expect(screen.getByRole('button', { name: /摘要版本历史/ }).closest('.settings-navigation-list')).toBeNull()
  })

  it('shows the story theme selector inside the appearance page', async () => {
    const user = userEvent.setup()
    renderDrawer()

    await user.click(screen.getByRole('button', { name: /外观/ }))
    await waitForPageSettled('外观')
    expect(screen.getByRole('heading', { name: '作品氛围' })).toBeDefined()
    expect(screen.getByRole('button', { name: /中性纸墨/ })).toBeDefined()
  })

  it('returns to the active category after an external settings page closes', async () => {
    const user = userEvent.setup()
    const props = drawerProps()
    const { rerender } = render(<SettingsDrawer {...props} />)

    await user.click(screen.getByRole('button', { name: /写作/ }))
    await waitForPageSettled('写作')
    expect(screen.getByRole('heading', { name: '写作' })).toBeDefined()

    rerender(<SettingsDrawer {...props} suspended />)
    expect(screen.getByRole('dialog', { hidden: true }).getAttribute('data-suspended')).toBe('true')
    rerender(<SettingsDrawer {...props} suspended={false} />)

    expect(screen.getByRole('heading', { name: '写作' })).toBeDefined()
    expect(screen.getByRole('button', { name: /局部创作设定/ })).toBeDefined()
  })

  it('opens provider settings from the model service page', async () => {
    const user = userEvent.setup()
    const onOpenProviderSettings = vi.fn()
    renderDrawer({ onOpenProviderSettings })

    await user.click(screen.getByRole('button', { name: /模型服务/ }))
    await screen.findByRole('heading', { name: '模型服务', level: 3 })
    await waitFor(() => expect(document.querySelector('.settings-content--exiting')).toBeNull())
    await user.click(screen.getByRole('button', { name: /图片模型/ }))
    expect(onOpenProviderSettings).toHaveBeenCalledWith('image')
  })

  it('returns home with Escape from a subpage before closing', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDrawer({ onClose })

    await user.click(screen.getByRole('button', { name: /外观/ }))
    await waitForPageSettled('外观')
    expect(screen.getByRole('heading', { name: '外观' })).toBeDefined()
    await user.keyboard('{Escape}')
    await waitForPageSettled('设置')
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
