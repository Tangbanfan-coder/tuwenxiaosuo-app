import { useCallback, useEffect, useRef, useState } from 'react'

interface TimelineNavigationOptions {
  booting: boolean
  projectId: string | undefined
  messageCount: number
  streamingText: string
  activeChapterId: string | undefined
  fallbackChapterId: string | undefined
  generationActive?: boolean
  completedProseMessageId?: string
}

export function useTimelineNavigation({ booting, projectId, messageCount, streamingText, activeChapterId, fallbackChapterId, generationActive = false, completedProseMessageId }: TimelineNavigationOptions) {
  const timelineRef = useRef<HTMLElement>(null)
  const [visibleChapterId, setVisibleChapterId] = useState<string>()
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const stickToBottomRef = useRef(true)
  const previousProjectIdRef = useRef<string | undefined>(undefined)
  const defaultChapterIdRef = useRef<string | undefined>(undefined)
  const userScrolledDuringGenerationRef = useRef(false)
  const streamedDuringGenerationRef = useRef(false)
  const previousGenerationActiveRef = useRef(generationActive)
  const generationStartProseRef = useRef<string | undefined>(completedProseMessageId)
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
  }, [generationActive, syncVisibleChapterFromScroll])

  const handleTimelineUserIntent = useCallback(() => {
    if (generationActive) userScrolledDuringGenerationRef.current = true
  }, [generationActive])

  useEffect(() => {
    if (booting) return
    const projectChanged = previousProjectIdRef.current !== projectId
    previousProjectIdRef.current = projectId
    if (projectChanged) {
      stickToBottomRef.current = true
      generationStartProseRef.current = completedProseMessageId
      setShowJumpToLatest(false)
      const frame = window.requestAnimationFrame(() => {
        scrollTimelineToBottom(true)
        window.requestAnimationFrame(syncVisibleChapterFromScroll)
      })
      return () => window.cancelAnimationFrame(frame)
    }
    if (generationActive && streamingText) streamedDuringGenerationRef.current = true
    const startedTurn = !previousGenerationActiveRef.current && generationActive
    const completedTurn = previousGenerationActiveRef.current && !generationActive
    if (startedTurn) generationStartProseRef.current = completedProseMessageId
    const completedNonStreamingTurn = completedTurn && !streamedDuringGenerationRef.current
      && completedProseMessageId && completedProseMessageId !== generationStartProseRef.current
    previousGenerationActiveRef.current = generationActive
    if (completedNonStreamingTurn && !streamingText) {
      if (!userScrolledDuringGenerationRef.current) {
        const frame = window.requestAnimationFrame(() => {
          timelineRef.current?.querySelector<HTMLElement>(`[data-message-id="${completedProseMessageId}"]`)?.scrollIntoView({ block: 'start', behavior: 'auto' })
          window.requestAnimationFrame(syncVisibleChapterFromScroll)
        })
        userScrolledDuringGenerationRef.current = false
        streamedDuringGenerationRef.current = false
        return () => window.cancelAnimationFrame(frame)
      }
      userScrolledDuringGenerationRef.current = false
      streamedDuringGenerationRef.current = false
      return
    }
    if (completedTurn) {
      streamedDuringGenerationRef.current = false
      userScrolledDuringGenerationRef.current = false
      generationStartProseRef.current = completedProseMessageId
    }
    if (!streamingText || !stickToBottomRef.current) return
    const frame = window.requestAnimationFrame(() => {
      scrollTimelineToBottom(true)
      window.requestAnimationFrame(syncVisibleChapterFromScroll)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [booting, projectId, messageCount, streamingText, generationActive, completedProseMessageId, scrollTimelineToBottom, syncVisibleChapterFromScroll])

  useEffect(() => {
    setVisibleChapterId(defaultChapterIdRef.current)
  }, [projectId])

  const jumpToLatest = useCallback(() => {
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
    scrollTimelineToBottom(false)
  }, [scrollTimelineToBottom])

  return { handleTimelineScroll, handleTimelineUserIntent, jumpToLatest, showJumpToLatest, timelineRef, visibleChapterId }
}
