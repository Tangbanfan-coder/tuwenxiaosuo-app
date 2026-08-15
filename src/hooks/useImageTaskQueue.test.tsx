// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useImageTaskQueue } from './useImageTaskQueue'

describe('useImageTaskQueue', () => {
  it('serializes work and suppresses a duplicate queued identifier', async () => {
    let queue: ReturnType<typeof useImageTaskQueue> | undefined
    function Probe() { queue = useImageTaskQueue(); return null }
    render(<Probe />)
    const calls: string[] = []
    let releaseFirst!: () => void
    const first = queue!.enqueueOnce('image-1', async () => { calls.push('first'); await new Promise<void>((resolve) => { releaseFirst = resolve }) })
    const duplicate = queue!.enqueueOnce('image-1', async () => { calls.push('duplicate') })
    const second = queue!.enqueueOnce('image-2', async () => { calls.push('second') })
    await Promise.resolve()
    expect(calls).toEqual(['first'])
    releaseFirst()
    await Promise.all([first, duplicate, second])
    expect(calls).toEqual(['first', 'second'])
  })
})
