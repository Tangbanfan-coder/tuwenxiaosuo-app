import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ native: false, platform: 'android' }))
const plugin = vi.hoisted(() => ({ enqueue: vi.fn(), list: vi.fn(), readResult: vi.fn(), acknowledge: vi.fn(), cancel: vi.fn() }))
const secrets = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.native, getPlatform: () => native.platform },
  registerPlugin: () => plugin,
}))
vi.mock('./secretStore', () => ({ secretStore: secrets }))

import {
  acknowledgeBackgroundGenerationTask,
  cancelBackgroundGenerationTask,
  enqueueBackgroundTextTask,
  listBackgroundGenerationTasks,
  readBackgroundGenerationTask,
  waitForBackgroundGenerationTask,
} from './backgroundGeneration'

beforeEach(() => {
  native.native = false
  native.platform = 'android'
  vi.clearAllMocks()
  secrets.get.mockResolvedValue('token')
})

describe('background generation bridge', () => {
  it('keeps Web on the existing path without reading a secret or enqueueing', async () => {
    await expect(enqueueBackgroundTextTask({ endpoint: 'https://api.test/chat/completions', body: '{}', secretRef: 'text', metadata: { projectId: 'p', userMessageId: 'u', noticeId: 'n', autoIllustrate: false, forceNewChapter: false } })).resolves.toBeUndefined()
    await expect(listBackgroundGenerationTasks()).resolves.toEqual([])
    expect(secrets.get).not.toHaveBeenCalled()
    expect(plugin.enqueue).not.toHaveBeenCalled()
  })

  it('observes completed, failed and unknown tasks without creating another request', async () => {
    native.native = true
    plugin.readResult.mockResolvedValueOnce({ id: 'done', kind: 'image', state: 'completed', localUri: 'file://image.png', bytes: 2_400_000, format: 'png', responseMode: 'b64_json', responseMs: 60_000, writeMs: 35, validationAndReplaceMs: 12, durationMs: 60_047 })
      .mockResolvedValueOnce({ id: 'failed', kind: 'text', state: 'failed', error: 'HTTP 500' })
      .mockResolvedValueOnce({ id: 'unknown', kind: 'text', state: 'unknown' })
    await expect(waitForBackgroundGenerationTask('done', 0)).resolves.toMatchObject({ state: 'completed', localUri: 'file://image.png', bytes: 2_400_000, format: 'png', responseMode: 'b64_json', responseMs: 60_000, writeMs: 35, validationAndReplaceMs: 12, durationMs: 60_047 })
    await expect(waitForBackgroundGenerationTask('failed', 0)).resolves.toMatchObject({ state: 'failed' })
    await expect(waitForBackgroundGenerationTask('unknown', 0)).resolves.toMatchObject({ state: 'unknown' })
    expect(plugin.enqueue).not.toHaveBeenCalled()
  })

  it('forwards acknowledgement only on Android', async () => {
    native.native = true
    await acknowledgeBackgroundGenerationTask('task-1')
    expect(plugin.acknowledge).toHaveBeenCalledWith({ id: 'task-1' })
    native.native = false
    await acknowledgeBackgroundGenerationTask('task-2')
    expect(plugin.acknowledge).toHaveBeenCalledTimes(1)
    await expect(readBackgroundGenerationTask('task-2')).resolves.toBeUndefined()
  })

  it('forwards cancellation only on Android', async () => {
    native.native = true
    await cancelBackgroundGenerationTask('task-1')
    expect(plugin.cancel).toHaveBeenCalledWith({ id: 'task-1' })
    native.native = false
    await cancelBackgroundGenerationTask('task-2')
    expect(plugin.cancel).toHaveBeenCalledTimes(1)
  })

  it('observes a cancelled task as cancelled without creating another request', async () => {
    native.native = true
    plugin.readResult.mockResolvedValueOnce({ id: 'cancelled', kind: 'text', state: 'cancelled' })
    await expect(waitForBackgroundGenerationTask('cancelled', 0)).resolves.toMatchObject({ state: 'cancelled' })
    expect(plugin.enqueue).not.toHaveBeenCalled()
  })
})
