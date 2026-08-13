// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMocks = vi.hoisted(() => ({
  createStyleCorpusDraftFragments: vi.fn(), deleteStyleCorpusSource: vi.fn(), listStyleCorpusFragments: vi.fn(),
  listStyleCorpusSources: vi.fn(), saveStyleCorpusImport: vi.fn(), splitStyleCorpusText: vi.fn(),
}))
const writingMocks = vi.hoisted(() => ({ suggestStyleCorpusLabels: vi.fn() }))
vi.mock('../data/storyDatabase', () => databaseMocks)
vi.mock('../providers/writing', () => writingMocks)

import StyleCorpusDialog from './StyleCorpusDialog'

const labels = { genres: [], sceneTypes: [], pace: [], techniques: [], emotionalTone: [], imitate: [], avoid: [] }
const config = { id: 'text', name: '文本', baseUrl: 'https://example.test/v1', model: 'model', protocol: 'openai-compatible' as const, secretRef: 'secret' }

beforeEach(() => {
  databaseMocks.listStyleCorpusSources.mockResolvedValue([])
  databaseMocks.listStyleCorpusFragments.mockResolvedValue([])
  databaseMocks.createStyleCorpusDraftFragments.mockImplementation((text: string) => text ? [{ id: 'f1', paragraphIds: ['p1'], text, fingerprint: 'fp', labels }] : [])
  databaseMocks.splitStyleCorpusText.mockReturnValue([{ id: 'p1', text: '原始语料。', fingerprint: 'fp' }])
  databaseMocks.saveStyleCorpusImport.mockResolvedValue(undefined)
  databaseMocks.deleteStyleCorpusSource.mockResolvedValue(undefined)
})
afterEach(() => cleanup())

describe('StyleCorpusDialog', () => {
  it('allows manual editing and confirmation without a successful model call', async () => {
    const user = userEvent.setup()
    render(<StyleCorpusDialog open textProvider={{ ...config, baseUrl: '', model: '' }} transport={{} as never} onClose={vi.fn()} onChanged={vi.fn()} />)
    await user.type(screen.getByPlaceholderText('例如：我喜欢的悬疑对白'), '手动语料')
    await user.type(screen.getByPlaceholderText(/粘贴你有权使用/), '原始语料。')
    await user.type(await screen.findByLabelText('第 1 个片段希望模仿'), '对白节奏')
    await user.click(screen.getByRole('button', { name: /确认入库/ }))
    await waitFor(() => expect(databaseMocks.saveStyleCorpusImport).toHaveBeenCalledWith(expect.objectContaining({ title: '手动语料', rawText: '原始语料。' })))
    expect(databaseMocks.saveStyleCorpusImport.mock.calls[0][0].fragments[0].labels.imitate).toEqual(['对白节奏'])
  })

  it('prefills AI labels while leaving them editable before confirmation', async () => {
    const user = userEvent.setup()
    writingMocks.suggestStyleCorpusLabels.mockResolvedValue([{ paragraphIds: ['p1'], labels: { ...labels, genres: ['悬疑'], sceneTypes: ['审讯'], imitate: ['留白'] } }])
    render(<StyleCorpusDialog open textProvider={config} transport={{} as never} onClose={vi.fn()} onChanged={vi.fn()} />)
    await user.type(screen.getByPlaceholderText(/粘贴你有权使用/), '原始语料。')
    await user.click(screen.getByRole('button', { name: /AI 辅助整理/ }))
    const input = await screen.findByLabelText('第 1 个片段希望模仿')
    expect((input as HTMLInputElement).value).toBe('留白')
    await user.clear(input)
    await user.type(input, '对白节奏')
    await user.click(screen.getByRole('button', { name: /确认入库/ }))
    await waitFor(() => expect(databaseMocks.saveStyleCorpusImport.mock.calls[0][0].fragments[0].labels.imitate).toEqual(['对白节奏']))
  })

  it('keeps deletion busy and reports a deletion failure', async () => {
    const user = userEvent.setup()
    databaseMocks.listStyleCorpusSources.mockResolvedValue([{ id: 'source-1', title: '失败来源', rawText: '原文', fingerprint: 'fp', createdAt: 1, updatedAt: 1 }])
    let rejectDelete!: (error: Error) => void
    databaseMocks.deleteStyleCorpusSource.mockReturnValue(new Promise((_resolve, reject) => { rejectDelete = reject }))
    render(<StyleCorpusDialog open textProvider={config} transport={{} as never} onClose={vi.fn()} onChanged={vi.fn()} />)
    const button = await screen.findByRole('button', { name: '删除语料来源失败来源' })
    await user.click(button)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    rejectDelete(new Error('删除被拒绝'))
    expect((await screen.findByRole('alert')).textContent).toContain('删除被拒绝')
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })
})
