import { useRef } from 'react'

/** Serializes potentially billable image work without retaining failed tasks. */
export function useImageTaskQueue() {
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const queuedIdsRef = useRef(new Set<string>())

  function enqueueImageTask<T>(task: () => Promise<T>) {
    const queued = queueRef.current.then(task, task)
    queueRef.current = queued.then(() => undefined, () => undefined)
    return queued
  }

  function enqueueOnce<T>(id: string, task: () => Promise<T>) {
    if (queuedIdsRef.current.has(id)) return Promise.resolve(undefined)
    queuedIdsRef.current.add(id)
    return enqueueImageTask(async () => {
      try { return await task() } finally { queuedIdsRef.current.delete(id) }
    })
  }

  return { enqueueImageTask, enqueueOnce }
}
