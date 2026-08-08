// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ContextUsage, { CONTEXT_USAGE_SECTION_SCALE_PROPERTY, ContextUsageDetails } from './ContextUsage'
import type { ContextBudgetPlan } from '../providers/writing'

const contextUsageStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

function plan(overrides: Partial<ContextBudgetPlan> = {}): ContextBudgetPlan {
  return {
    estimator: { source: 'o200k_base', isFallback: false },
    windowTokens: 16_000,
    contextBudget: 'standard',
    contextBudgetRatio: 0.55,
    contextNarrowingFactor: 0.85,
    outputReserveTokens: 1_000,
    safetyMarginTokens: 500,
    requestOverheadTokens: 200,
    inputLimitTokens: 14_500,
    contextCapacityTokens: 13_000,
    contextTargetTokens: 7_150,
    contextAllocationTokens: 6_077,
    contextSerializationGuardTokens: 427,
    contextContentBudgetTokens: 5_650,
    compressionStage: 'normal',
    contextDemandTokens: 1_280,
    contextRetainedTokens: 1_200,
    contextPressureRatio: 0.227,
    serializedContextTokens: 1_200,
    contextSerializationTokens: 80,
    estimatedInputTokens: 1_950,
    usedTokens: 3_450,
    remainingTokens: 12_550,
    isOverLimit: false,
    windowUsageRatio: 0.216,
    inputUsageRatio: 0.135,
    sections: [
      { key: 'systemPrompt', label: '系统提示', tokens: 280, percentageOfEstimatedInput: 0.14 },
      { key: 'projectWorkspace', label: '项目/工作区', tokens: 360, percentageOfEstimatedInput: 0.18 },
      { key: 'coreMemory', label: '核心记忆', tokens: 240, percentageOfEstimatedInput: 0.12 },
      { key: 'timelineRetrievedContext', label: '时间线/检索上下文', tokens: 400, percentageOfEstimatedInput: 0.2 },
      { key: 'recentMessages', label: '近期消息', tokens: 180, percentageOfEstimatedInput: 0.09 },
      { key: 'feedback', label: '反馈（预留）', tokens: 0, percentageOfEstimatedInput: 0 },
      { key: 'userMessage', label: '用户消息', tokens: 120, percentageOfEstimatedInput: 0.06 },
    ],
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('ContextUsage', () => {
  it('shows all four progressive compression states with calibrated copy and a critical recovery suggestion', () => {
    const stages = [
      ['normal', '常规上下文', '当前按完整工作区资料组织本轮内容。'],
      ['organizing', '正在整理上下文', '接近预算，已轻度收紧近期对话和时间线。'],
      ['compressed', '已压缩上下文', '优先保留章节提要、核心记忆和当前工作区。'],
      ['critical', '紧凑上下文', '预算压力很高，当前只保留核心规则、章节状态与必要锚点。'],
    ] as const
    const { container, rerender } = render(<ContextUsageDetails plan={plan()} state="ready" />)

    for (const [compressionStage, label, description] of stages) {
      rerender(<ContextUsageDetails plan={plan({ compressionStage })} state="ready" />)
      expect(screen.getByText(label)).toBeDefined()
      expect(screen.getByText(description)).toBeDefined()
      expect(container.querySelector(`.context-usage-compression--${compressionStage}`)).toBeDefined()
      expect(contextUsageStyles).toContain(`.context-usage-compression--${compressionStage}`)
    }
    expect(screen.getByText(/建议：如需更多历史细节，可缩短本条输入、降低最大输出/)).toBeDefined()
  })

  it('renders a concise N/M strip and opens accessible section details that Escape can close', async () => {
    const user = userEvent.setup()
    render(<ContextUsage plan={plan()} state="ready" />)

    await user.click(screen.getByRole('button', { name: /上下文.*1,950.*14,500/ }))
    expect(screen.getByRole('dialog', { name: '本轮上下文用量' })).toBeDefined()
    expect(screen.getByText('系统提示')).toBeDefined()
    expect(screen.getByText('项目/工作区')).toBeDefined()
    expect(screen.getByText('反馈（预留）')).toBeDefined()
    expect(screen.getByText('120 token · 6%')).toBeDefined()
    expect(screen.getByText('窗口占比')).toBeDefined()
    expect(screen.getByText('输出预留')).toBeDefined()
    expect(screen.getByText('安全余量')).toBeDefined()
    expect(screen.getByText('剩余 token')).toBeDefined()
    const firstSectionFill = document.querySelector('.context-usage-section-bar > span') as HTMLElement | null
    expect(firstSectionFill?.style.getPropertyValue(CONTEXT_USAGE_SECTION_SCALE_PROPERTY)).toBe('0.14')
    expect(contextUsageStyles).toContain(`scaleX(var(${CONTEXT_USAGE_SECTION_SCALE_PROPERTY}))`)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '本轮上下文用量' })).toBeNull()
  })

  it('supports the close button and compresses itself while the composer is focused', async () => {
    const user = userEvent.setup()
    const { container, rerender } = render(<ContextUsage plan={plan()} state="ready" />)

    await user.click(screen.getByRole('button', { name: /查看本轮上下文用量明细/ }))
    await user.click(screen.getByRole('button', { name: '关闭上下文用量明细' }))
    expect(screen.queryByRole('dialog', { name: '本轮上下文用量' })).toBeNull()

    rerender(<ContextUsage plan={plan()} state="ready" composerFocused />)
    const root = container.querySelector('.context-usage')
    const strip = container.querySelector('.context-usage-strip')
    expect(root?.getAttribute('data-composer-focused')).toBe('true')
    expect(strip?.getAttribute('tabindex')).toBe('-1')
  })

  it('renders loading, empty, over-limit, fallback and error states without blocking details', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ContextUsage state="loading" />)
    expect(screen.getByText('上下文 · 估算中')).toBeDefined()

    rerender(<ContextUsage state="empty" />)
    await user.click(screen.getByRole('button', { name: /暂无输入/ }))
    expect(screen.getByText(/暂无输入或未配置文本模型/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: '关闭上下文用量明细' }))

    rerender(<ContextUsage plan={plan({ isOverLimit: true, remainingTokens: -250 })} state="over-limit" />)
    await user.click(screen.getByRole('button', { name: /查看本轮上下文用量明细/ }))
    expect(screen.getByText(/本轮可能超出上下文窗口/)).toBeDefined()
    expect(screen.getByText(/缩短本条输入、降低最大输出/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: '关闭上下文用量明细' }))

    rerender(<ContextUsage plan={plan({ estimator: { source: 'chars-per-token', isFallback: true } })} state="fallback" />)
    await user.click(screen.getByRole('button', { name: /查看本轮上下文用量明细/ }))
    expect(screen.getByText('估算回退')).toBeDefined()
    expect(screen.getAllByText(/chars-per-token/).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '关闭上下文用量明细' }))

    rerender(<ContextUsage state="error" error="检索暂不可用" />)
    await user.click(screen.getByRole('button', { name: /暂不可估算/ }))
    expect(screen.getByText(/预算预览暂不可用，仍可继续发送/)).toBeDefined()
  })
})
