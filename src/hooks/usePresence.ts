import { useEffect, useRef, useState } from 'react'

export function usePresence(open: boolean, onClose: () => void, exitDurationMs: number) {
  const [present, setPresent] = useState(open)
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const startedRef = useRef(false)
  const wasOpenRef = useRef(open)

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      window.clearTimeout(timerRef.current)
      startedRef.current = false
      setClosing(false)
      setPresent(true)
      return
    }
    if (!wasOpenRef.current || startedRef.current) return
    startedRef.current = true
    setClosing(true)
    timerRef.current = window.setTimeout(() => {
      setPresent(false)
      setClosing(false)
      onCloseRef.current()
    }, exitDurationMs)
  }, [open, exitDurationMs])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  // Effects run after commit. Reflect an opening prop during this render so a
  // suspended parent cannot briefly reveal the page below its child dialog.
  return { present: open || present, closing }
}
