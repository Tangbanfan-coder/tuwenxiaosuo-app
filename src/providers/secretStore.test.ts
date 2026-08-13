// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
}))

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {},
}))

import { secretStore } from './secretStore'

describe('secretStore web persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('persists values across page reloads through localStorage', async () => {
    await secretStore.set('provider:text', 'sk-test-token')
    expect(localStorage.getItem('illustrated-story-chat_provider:text')).toBe('sk-test-token')
    expect(await secretStore.get('provider:text')).toBe('sk-test-token')
    expect(await secretStore.has('provider:text')).toBe(true)
  })

  it('surfaces persisted values even when the in-memory cache was cleared', async () => {
    localStorage.setItem('illustrated-story-chat_provider:image', 'sk-image-token')
    expect(await secretStore.get('provider:image')).toBe('sk-image-token')
  })

  it('removes values from localStorage', async () => {
    await secretStore.set('provider:text', 'sk-test-token')
    await secretStore.remove('provider:text')
    expect(localStorage.getItem('illustrated-story-chat_provider:text')).toBeNull()
    expect(await secretStore.get('provider:text')).toBeNull()
  })
})
