// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderSettings } from '../providers/types'
import ProviderSettingsDialog from './ProviderSettingsDialog'

const secretStoreMocks = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../providers/secretStore', () => ({ secretStore: secretStoreMocks }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
