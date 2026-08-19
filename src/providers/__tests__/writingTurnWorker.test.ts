import 'fake-indexeddb/auto'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sendPrepareToWorker, __resetWritingTurnWorker, __setWritingTurnWorkerForTest, __getWritingTurnWorkerCapability } from '../writing/writingTurnWorker'
import type { ComputeWritingTurnContextInput, ComputedWritingTurnContext } from '../writing/writingTurnContext'

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
}

const sampleInput = {
  workspace: { project: { id: 'p' }, messages: [], chapters: [], characters: [], illustrations: [] },
  scenes: [],
  retrievedParagraphs: [],
  preferenceSignals: [],
  styleCorpusFragments: [],
  config: { id: 'c', name: 'n', model: 'm', baseUrl: '', protocol: 'openai-compatible' as const, secretRef: 's' },
  userRequest: '写一段',
} as unknown as ComputeWritingTurnContextInput

const sampleResult = {
  initialPlan: {},
  finalPlan: {},
  contextMessage: 'ctx',
  rulesTruncated: false,
  styleFragmentIds: [],
} as unknown as ComputedWritingTurnContext

beforeEach(() => __resetWritingTurnWorker())
afterEach(() => __resetWritingTurnWorker())

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('writingTurnWorker', () => {
  it('能力缺失时返回 null 且不调 worker', async () => {
    const worker = new MockWorker()
    __setWritingTurnWorkerForTest(worker as unknown as Worker, 'unavailable')
    const result = await sendPrepareToWorker(sampleInput)
    expect(result).toBeNull()
    expect(worker.postMessage).not.toHaveBeenCalled()
  })

  it('能力可用：postMessage build，worker 回 plan 则 resolve 结果', async () => {
    const worker = new MockWorker()
    __setWritingTurnWorkerForTest(worker as unknown as Worker, 'available')
    const pending = sendPrepareToWorker(sampleInput)
    await flushMicrotasks()
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    const call = (worker.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.type).toBe('build')
    expect(typeof call.id).toBe('string')
    worker.onmessage?.({ data: { id: call.id, type: 'plan', payload: sampleResult } } as MessageEvent)
    await expect(pending).resolves.toBe(sampleResult)
  })

  it('worker 回 error 则 reject', async () => {
    const worker = new MockWorker()
    __setWritingTurnWorkerForTest(worker as unknown as Worker, 'available')
    const pending = sendPrepareToWorker(sampleInput)
    await flushMicrotasks()
    const call = (worker.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    worker.onmessage?.({ data: { id: call.id, type: 'error', error: 'boom' } } as MessageEvent)
    await expect(pending).rejects.toThrow('boom')
  })

  it('worker onerror（从未成功 build，加载期失败）：reject pending + terminate + capability 置 unavailable 停止重试', async () => {
    const worker = new MockWorker()
    __setWritingTurnWorkerForTest(worker as unknown as Worker, 'available')
    const pending = sendPrepareToWorker(sampleInput)
    await flushMicrotasks()
    worker.onerror?.({ message: 'load failed' } as unknown as ErrorEvent)
    await expect(pending).rejects.toThrow('load failed')
    expect(worker.terminate).toHaveBeenCalled()
    // 加载期持久失败（从未成功 build）视同能力缺失：后续不再每轮重建失败 worker
    expect(__getWritingTurnWorkerCapability()).toBe('unavailable')
  })

  it('成功 build 后的崩溃（偶发）：capability 保持 available，不降级', async () => {
    const worker = new MockWorker()
    __setWritingTurnWorkerForTest(worker as unknown as Worker, 'available')
    const pending = sendPrepareToWorker(sampleInput)
    await flushMicrotasks()
    const call = (worker.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    worker.onmessage?.({ data: { id: call.id, type: 'plan', payload: sampleResult } } as MessageEvent)
    await pending
    worker.onerror?.({ message: 'crashed after success' } as unknown as ErrorEvent)
    expect(__getWritingTurnWorkerCapability()).toBe('available')
  })

  it('超时则 reject', async () => {
    vi.useFakeTimers()
    try {
      const worker = new MockWorker()
      __setWritingTurnWorkerForTest(worker as unknown as Worker, 'available')
      const pending = sendPrepareToWorker(sampleInput, 1000)
      await flushMicrotasks()
      vi.advanceTimersByTime(1100)
      await expect(pending).rejects.toThrow('超时')
    } finally {
      vi.useRealTimers()
    }
  })
})
