import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeMocks = vi.hoisted(() => ({ native: true, write: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => nativeMocks.native },
  registerPlugin: () => ({ write: nativeMocks.write }),
}))

import { logImagePipeline } from './imagePipelineLog'

beforeEach(() => {
  nativeMocks.native = true
  nativeMocks.write.mockClear()
})

describe('logImagePipeline', () => {
  it('sends only whitelisted primitive metrics to the native logger', () => {
    logImagePipeline('info', {
      phase: 'download-complete',
      durationMs: 123,
      approximateBytes: 456,
      url: 'https://cdn.test/private?token=secret',
      data: 'base64-image-data',
      message: 'provider response body',
    })

    expect(nativeMocks.write).toHaveBeenCalledWith({
      level: 'info',
      message: '{"phase":"download-complete","durationMs":123,"approximateBytes":456}',
    })
  })

  it('keeps browser diagnostics on the console without invoking the native bridge', () => {
    nativeMocks.native = false
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    logImagePipeline('info', { phase: 'provider-complete', durationMs: 42 })

    expect(info).toHaveBeenCalledWith('[image-pipeline] {"phase":"provider-complete","durationMs":42}')
    expect(nativeMocks.write).not.toHaveBeenCalled()
    info.mockRestore()
  })

  it('keeps native download metrics but strips identifiers and URLs', () => {
    logImagePipeline('info', {
      phase: 'native-url-persist-complete', bytes: 123, responseMs: 20, status: 200,
      assetId: 'secret-id', url: 'https://cdn.test/signed', message: 'private',
    })
    expect(nativeMocks.write).toHaveBeenCalledWith({
      level: 'info',
      message: '{"phase":"native-url-persist-complete","bytes":123,"responseMs":20,"status":200}',
    })
  })
})
