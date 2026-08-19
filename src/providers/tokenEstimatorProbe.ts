/**
 * Main-thread driver for the token-estimator environment probe.
 *
 * Hard requirements this probe must satisfy (per reviewer):
 *  1. The worker URL is the production-built chunk (Vite rewrites
 *     `new URL('./x.worker.ts', import.meta.url)` to the emitted asset), so
 *     this is only meaningful when run against a `vite build` / `cap sync`
 *     artifact on the target WebView — NOT the dev server.
 *  2. The worker actually runs `new Tiktoken(o200kBase).encode(...)`, so a
 *     green result also proves the ranks table is bundled, not fetched.
 *  3. Falls back to the main thread (memoize already in place) if the probe
 *     shows the target WebView cannot run module workers — this driver is the
 *     primitive for that capability check, not a hard dependency.
 */

export type TokenEstimatorProbeStage = 'construct' | 'load' | 'encode' | 'timeout'

export interface TokenEstimatorProbeResult {
  ok: boolean
  stage: TokenEstimatorProbeStage
  /** Token count returned by the worker's real encode. Present when ok. */
  tokens?: number
  /** Tokenizer source reported by the worker (should be 'o200k_base'). */
  source?: string
  /** Error message when ok is false. */
  error?: string
  /** WebView/Chromium UA, captured for evidence. */
  userAgent: string
  /** Wall-clock ms from worker construction to result. */
  elapsedMs: number
}

export async function runTokenEstimatorProbe(timeoutMs = 8_000): Promise<TokenEstimatorProbeResult> {
  const startedAt = performance.now()
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
  return new Promise<TokenEstimatorProbeResult>((resolve) => {
    let worker: Worker | undefined
    let settled = false
    const finish = (result: Omit<TokenEstimatorProbeResult, 'userAgent' | 'elapsedMs'>) => {
      if (settled) return
      settled = true
      worker?.terminate()
      clearTimeout(timer)
      resolve({ ...result, userAgent, elapsedMs: Math.round(performance.now() - startedAt) })
    }
    const timer = setTimeout(
      () => finish({ ok: false, stage: 'timeout', error: `worker 在 ${timeoutMs}ms 内无响应（可能 ranks 未内联导致 fetch 挂起，或 module worker 不被支持）` }),
      timeoutMs,
    )
    try {
      worker = new Worker(new URL('./tokenEstimatorProbe.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      finish({ ok: false, stage: 'construct', error: error instanceof Error ? error.message : String(error) })
      return
    }
    worker.onerror = (event) => {
      finish({
        ok: false,
        stage: 'load',
        error: `${event.message || 'worker 加载/执行失败'} (${event.filename || '?'}:${event.lineno ?? '?'})`,
      })
    }
    worker.onmessage = (event) => {
      const data = event.data as { ok?: boolean; tokens?: number; source?: string; error?: string; stage?: string }
      if (data?.ok) {
        finish({ ok: true, stage: 'encode', tokens: data.tokens, source: data.source })
      } else {
        finish({ ok: false, stage: 'encode', error: data?.error || 'worker 内执行失败' })
      }
    }
    worker.postMessage({ start: true })
  })
}
