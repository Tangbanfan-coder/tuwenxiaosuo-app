import { useCallback, useEffect, useRef, useState } from 'react'

interface TimelineNavigationOptions {
  booting: boolean
  projectId: string | undefined
  messageCount: number
  streamingText: string
  activeChapterId: string | undefined
  fallbackChapterId: string | undefined
}

export function useTimelineNavigation({ booting, projectId, messageCount, streamingText, activeChapterId, fallbackChapterId }: TimelineNavigationOptions) {
  const timelineRef = useRef<HTMLElement>(null)
  const [visibleChapterId, setVisibleChapterId] = useState<string>()
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const stickToBottomRef = useRef(true)
  const previousProjectIdRef = useRef<string | undefined>(undefined)
  const defaultChapterIdRef = useRef<string | undefined>(undefined)
  defaultChapterIdRef.current = activeChapterId ?? fallbackChapterId

  const syncVisibleChapterFromScroll = useCallback(() => {
    const timeline = timelineRef.current
    if (!timeline) return
    const anchors = Array.from(timeline.querySelectorAll<HTMLElement>('[data-chapter-id]'))
    if (!anchors.length) return
    const threshold = timeline.getBoundingClientRect().top + 24
    let nextChapterId = anchors[0].dataset.chapterId
    for (const anchor of anchors) {
      if (anchor.getBoundingClientRect().top > threshold) break
      nextChapterId = anchor.dataset.chapterId
    }
    if (nextChapterId) setVisibleChapterId((current) => current === nextChapterId ? current : nextChapterId)
  }, [])

  const scrollTimelineToBottom = useCallback((instant: boolean) => {
    const timeline = timelineRef.current
    if (!timeline) return
    if (instant) {
      timeline.style.scrollBehavior = 'auto'
      timeline.scrollTop = timeline.scrollHeight
      timeline.style.scrollBehavior = ''
    } else {
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'smooth' })
    }
  }, [])

  const handleTimelineScroll = useCallback(() => {
    const timeline = timelineRef.current
    if (!timeline) return
    const distance = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight
    const atBottom = distance < 48
    stickToBottomRef.current = atBottom
    setShowJumpToLatest(!atBottom)
    syncVisibleChapterFromScroll()
  }, [syncVisibleChapterFromScroll])

  useEffect(() => {
    if (booting) return
    const projectChanged = previousProjectIdRef.current !== projectId
    previousProjectIdRef.current = projectId
    if (projectChanged) {
      stickToBottomRef.current = true
      setShowJumpToLatest(false)
      const frame = window.requestAnimationFrame(() => {
        scrollTimelineToBottom(true)
        window.requestAnimationFrame(syncVisibleChapterFromScroll)
      })
      return () => window.cancelAnimationFrame(frame)
    }
    if (!stickToBottomRef.current) return
    const frame = window.requestAnimationFrame(() => {
      scrollTimelineToBottom(true)
      window.requestAnimationFrame(syncVisibleChapterFromScroll)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [booting, projectId, messageCount, streamingText, scrollTimelineToBottom, syncVisibleChapterFromScroll])

  useEffect(() => {
    setVisibleChapterId(defaultChapterIdRef.current)
  }, [projectId])

  const jumpToLatest = useCallback(() => {
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
    scrollTimelineToBottom(false)
  }, [scrollTimelineToBottom])

  return { handleTimelineScroll, jumpToLatest, showJumpToLatest, timelineRef, visibleChapterId }
}
