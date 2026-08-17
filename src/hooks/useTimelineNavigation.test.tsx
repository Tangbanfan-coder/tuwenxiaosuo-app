// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTimelineNavigation } from './useTimelineNavigation'

function Probe({ projectId, activeChapterId, fallbackChapterId, generationActive = false, streamingText = '', completedProseMessageId }: { projectId: string; activeChapterId?: string; fallbackChapterId?: string; generationActive?: boolean; streamingText?: string; completedProseMessageId?: string }) {
  const navigation = useTimelineNavigation({ booting: false, projectId, messageCount: completedProseMessageId ? 1 : 0, streamingText, activeChapterId, fallbackChapterId, generationActive, completedProseMessageId })
  return <><output>{navigation.visibleChapterId}</output><section aria-label="timeline-probe" ref={navigation.timelineRef} onScroll={navigation.handleTimelineScroll} onWheel={navigation.handleTimelineUserIntent}>{completedProseMessageId && <div data-message-id={completedProseMessageId} />}</section></>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useTimelineNavigation', () => {
  it('keeps the visible chapter during same-project chapter changes and resets it when switching projects', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const view = render(<Probe projectId="project-1" activeChapterId="chapter-1" />)
    expect(screen.getByRole('status').textContent).toBe('chapter-1')

    view.rerender(<Probe projectId="project-1" activeChapterId="chapter-2" />)
    expect(screen.getByRole('status').textContent).toBe('chapter-1')

    view.rerender(<Probe projectId="project-2" activeChapterId="chapter-3" />)
    expect(screen.getByRole('status').textContent).toBe('chapter-3')
    vi.unstubAllGlobals()
  })

  it('positions a non-streaming completion at the new prose start unless the user browsed during generation', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const view = render(<Probe projectId="project-1" completedProseMessageId="prose-old" />)
    view.rerender(<Probe projectId="project-1" generationActive completedProseMessageId="prose-old" />)
    const scrollIntoView = vi.fn()
    view.rerender(<Probe projectId="project-1" generationActive completedProseMessageId="prose-new" />)
    const newMessage = document.querySelector<HTMLElement>('[data-message-id="prose-new"]')!
    newMessage.scrollIntoView = scrollIntoView
    view.rerender(<Probe projectId="project-1" completedProseMessageId="prose-new" />)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })

    view.rerender(<Probe projectId="project-1" generationActive completedProseMessageId="prose-new" />)
    fireEvent.wheel(screen.getByLabelText('timeline-probe'))
    const preserved = vi.fn()
    view.rerender(<Probe projectId="project-1" generationActive completedProseMessageId="prose-third" />)
    document.querySelector<HTMLElement>('[data-message-id="prose-third"]')!.scrollIntoView = preserved
    view.rerender(<Probe projectId="project-1" completedProseMessageId="prose-third" />)
    expect(preserved).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not reinterpret a streamed completion as a non-streaming jump', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const view = render(<Probe projectId="project-1" completedProseMessageId="prose-old" />)
    view.rerender(<Probe projectId="project-1" generationActive streamingText="流式正文" completedProseMessageId="prose-old" />)
    const scrollIntoView = vi.fn()
    view.rerender(<Probe projectId="project-1" generationActive streamingText="流式正文" completedProseMessageId="prose-streamed" />)
    document.querySelector<HTMLElement>('[data-message-id="prose-streamed"]')!.scrollIntoView = scrollIntoView
    view.rerender(<Probe projectId="project-1" completedProseMessageId="prose-streamed" />)
    expect(scrollIntoView).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
