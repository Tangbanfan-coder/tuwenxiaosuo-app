// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSettings } from '../providers/types'
import ProviderSettingsDialog from './ProviderSettingsDialog'

const secretStoreMocks = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
}))

const capacitorMocks = vi.hoisted(() => ({ native: true }))

vi.mock('../providers/secretStore', () => ({ secretStore: secretStoreMocks }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => capacitorMocks.native },
  CapacitorHttp: { request: vi.fn() },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capacitorMocks.native = true
})

const settings: ProviderSettings = {
  text: {
    id: 'text-provider',
    name: '文本服务',
    baseUrl: '',
    model: '',
    protocol: 'openai-compatible',
    secretRef: 'provider:text',
  },
  image: {
    id: 'image-provider',
    name: '图片服务',
    baseUrl: '',
    model: '',
    protocol: 'openai-compatible',
    secretRef: 'provider:image',
  },
  textProviders: [],
  imageProviders: [],
}

describe('ProviderSettingsDialog layering', () => {
  it('does not add another dark backdrop when opened above settings', async () => {
    const { container } = render(
      <ProviderSettingsDialog
        open
        nested
        settings={settings}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: '模型接口' })).toBeDefined()
    expect(container.querySelector('.dialog-backdrop')?.classList.contains('nested-dialog-backdrop')).toBe(true)
    await waitFor(() => expect(secretStoreMocks.get).toHaveBeenCalled())
  })

  it('keeps the regular backdrop when opened directly', () => {
    const { container } = render(
      <ProviderSettingsDialog
        open
        settings={settings}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(container.querySelector('.dialog-backdrop')?.classList.contains('nested-dialog-backdrop')).toBe(false)
  })
})

describe('ProviderSettingsDialog Android streaming', () => {
  it('文本供应商默认关闭流式输出并保存用户选择', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<ProviderSettingsDialog open settings={settings} onClose={vi.fn()} onSave={onSave} />)

    const toggle = screen.getByRole('checkbox', { name: /流式输出/ })
    expect((toggle as HTMLInputElement).checked).toBe(false)
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].text.androidStreamingEnabled).toBe(true)
  })

  it('Web 环境不显示 Android 专用流式开关', () => {
    capacitorMocks.native = false
    render(<ProviderSettingsDialog open settings={settings} onClose={vi.fn()} onSave={vi.fn()} />)

    expect(screen.queryByRole('checkbox', { name: /流式输出/ })).toBeNull()
  })
})
