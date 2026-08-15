// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTimelineNavigation } from './useTimelineNavigation'

function Probe({ projectId, activeChapterId, fallbackChapterId }: { projectId: string; activeChapterId?: string; fallbackChapterId?: string }) {
  const navigation = useTimelineNavigation({ booting: false, projectId, messageCount: 0, streamingText: '', activeChapterId, fallbackChapterId })
  return <output>{navigation.visibleChapterId}</output>
}

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
})
