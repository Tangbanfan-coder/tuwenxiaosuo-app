// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WritingInstructionsStructure } from '../domain/models'
import type { ProviderConfig } from '../providers/types'

const structureWritingInstructionsMock = vi.hoisted(() => vi.fn())

vi.mock('../providers/writing', async () => {
  const actual = await vi.importActual<typeof import('../providers/writing')>('../providers/writing')
  return {
    ...actual,
    structureWritingInstructions: structureWritingInstructionsMock,
  }
})

import WritingInstructionsDialog from './WritingInstructionsDialog'

const textProvider: ProviderConfig = {
  id: 'text-test',
  name: 'Text Test',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  protocol: 'openai-compatible',
  secretRef: 'provider:text',
}

const generatedStructure: WritingInstructionsStructure = {
  core: '必须使用第三人称有限视角。',
  sections: [{ id: 'section-1', title: '世界设定', content: '北境终年积雪。', tags: ['北境'], priority: 4 }],
  styleSamples: [{ sceneType: '景物', content: '风从冻土上刮过。' }],
}

beforeEach(() => {
  structureWritingInstructionsMock.mockReset()
  structureWritingInstructionsMock.mockResolvedValue(generatedStructure)
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }
})

afterEach(() => cleanup())

describe('长期创作设定确认流程', () => {
  it('首次整理时保存当前生成并编辑后的结构', async () => {
    const user = userEvent.setup()
    const onSaveStructure = vi.fn().mockResolvedValue(undefined)
    render(
      <WritingInstructionsDialog
        open
        projectTitle="测试作品"
        value={'长期设定内容。'.repeat(40)}
        textProvider={textProvider}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onSaveStructure={onSaveStructure}
      />,
    )

    await user.click(screen.getByRole('button', { name: /整理结构/ }))
    const coreInput = await screen.findByLabelText(/核心规则/)
    await user.clear(coreInput)
    await user.type(coreInput, '用户确认后的核心规则。')
    await user.click(screen.getByRole('button', { name: /确认保存/ }))

    await waitFor(() => expect(onSaveStructure).toHaveBeenCalledTimes(1))
    const saved = JSON.parse(onSaveStructure.mock.calls[0][0]) as WritingInstructionsStructure
    expect(saved.core).toBe('用户确认后的核心规则。')
    expect(saved.sections[0]?.title).toBe('世界设定')
  })

  it('旧结构缺少数组字段时对话框不会崩溃', async () => {
    render(
      <WritingInstructionsDialog
        open
        projectTitle="测试作品"
        value="原始设定"
        structure={JSON.stringify({ core: '旧核心规则' })}
        textProvider={textProvider}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onSaveStructure={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(await screen.findByText(/已整理为分层结构：0 个分类、0 个风格范例/)).toBeDefined()
  })

  it('预计调用超过 10 次时先征求用户确认', async () => {
    const user = userEvent.setup()
    render(
      <WritingInstructionsDialog
        open
        projectTitle="测试作品"
        value={'很长的设定内容。'.repeat(6_000)}
        textProvider={{
          ...textProvider,
          manualContextLength: 8_000,
          manualMaxOutputTokens: 4_000,
        }}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onSaveStructure={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await user.click(screen.getByRole('button', { name: /整理结构/ }))
    expect(await screen.findByRole('alertdialog', { name: '整理调用次数较多' })).toBeDefined()
    expect(structureWritingInstructionsMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '仍要整理' }))
    await waitFor(() => expect(structureWritingInstructionsMock).toHaveBeenCalledTimes(1))
  })
})
