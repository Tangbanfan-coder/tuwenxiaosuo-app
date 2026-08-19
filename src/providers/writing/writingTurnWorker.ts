import { runTokenEstimatorProbe } from '../tokenEstimatorProbe'
import type { ComputeWritingTurnContextInput, ComputedWritingTurnContext } from './writingTurnContext'
import type { WorkerOutboundMessage } from './writingTurnContext.worker'

type WorkerCapability = 'unknown' | 'available' | 'unavailable'

let workerCapability: WorkerCapability = 'unknown'
let workerInstance: Worker | undefined
let messageId = 0

interface PendingRequest {
  resolve: (result: ComputedWritingTurnContext) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingRequests = new Map<string, PendingRequest>()

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Capability is probed once per session (module-level, NOT localStorage): a
 * module-worker-unsupported WebView is a permanent property of that runtime,
 * so re-probing every turn would just add latency. Result cached in
 * `workerCapability`. Transient worker crashes never downgrade this — only
 * an actual probe failure (construct/encode fail) does.
 */
async function probeCapability(): Promise<boolean> {
  if (workerCapability === 'available') return true
  if (workerCapability === 'unavailable') return false
  const result = await runTokenEstimatorProbe()
  workerCapability = result.ok ? 'available' : 'unavailable'
  return workerCapability === 'available'
}

function wireWorker(worker: Worker) {
  // 本实例是否成功完成过至少一次 build：决定 onerror 是"加载期失败"（模块
  // worker 在本环境持久不可用，置 capability=unavailable 停止重试，否则每轮
  // 都会白建一个失败 worker 再走主线程 fallback 的无限循环）还是"已工作后
  // 崩溃"（偶发，重建实例、capability 不变）。
  let hasCompletedBuild = false
  worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
    const message = event.data
    if (!message || typeof message.id !== 'string') return
    const pending = pendingRequests.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingRequests.delete(message.id)
    if (message.type === 'plan') {
      hasCompletedBuild = true
      pending.resolve(message.payload)
    } else {
      pending.reject(new Error(message.error || 'worker 计算失败'))
    }
  }
  worker.onerror = (event) => {
    // Transient crash (NOT capability loss): reject all in-flight, terminate
    // this instance so the next call rebuilds a fresh one. Capability stays —
    // one crash must not slow the whole session down to main thread.
    const error = new Error(event.message || 'worker 异常退出')
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    pendingRequests.clear()
    if (workerInstance === worker) {
      workerInstance.terminate()
      workerInstance = undefined
    }
    if (!hasCompletedBuild) {
      // 加载期持久失败（从未成功 build 就 onerror）：视同能力缺失，整会话降级
      // 主线程，避免每轮"建失败 worker + fallback"的无限循环。
      workerCapability = 'unavailable'
    }
    // 已成功 build 后的崩溃：偶发，capability 不变，下次 getWorker 重建。
  }
}

function getWorker(): Worker | undefined {
  if (workerCapability === 'unavailable') return undefined
  if (workerInstance) return workerInstance
  try {
    // new URL MUST be inlined into new Worker for Vite static worker detection
    // (a separate const would be base64-inlined as a data URL and break bare
    // imports — same trap the probe hit). See tokenEstimatorProbe for evidence.
    workerInstance = new Worker(new URL('./writingTurnContext.worker.ts', import.meta.url), { type: 'module' })
    wireWorker(workerInstance)
    return workerInstance
  } catch {
    workerCapability = 'unavailable'
    return undefined
  }
}

/**
 * Send the pure context computation to the worker.
 *  - resolves with the result on success;
 *  - resolves null when the environment cannot run module workers (capability
 *    miss) → caller falls back to main thread computeWritingTurnContext;
 *  - rejects on worker error/timeout/crash → caller falls back to main thread
 *    for THIS request only; worker is rebuilt next call, capability is NOT
 *    downgraded (transient ≠ permanent).
 */
export async function sendPrepareToWorker(
  input: ComputeWritingTurnContextInput,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ComputedWritingTurnContext | null> {
  const capable = await probeCapability()
  if (!capable) return null
  const worker = getWorker()
  if (!worker) return null
  const id = `t${++messageId}`
  return new Promise<ComputedWritingTurnContext | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      // 止损：超时说明 worker 无响应（可能已挂死），terminate 该实例，下次
      // getWorker 重建（重新付一次冷启动）。极少触发（默认 30s）。
      workerInstance?.terminate()
      workerInstance = undefined
      reject(new Error(`worker ${timeoutMs}ms 超时`))
    }, timeoutMs)
    pendingRequests.set(id, {
      resolve: (result) => resolve(result),
      reject,
      timer,
    })
    worker.postMessage({ id, type: 'build', payload: input })
  })
}

/**
 * 发送"取消意图"信号给 worker。注意当前语义：computeWritingTurnContext 全同步
 * 执行、无检查点，worker 端也不处理 cancel 消息（onmessage 只认 build），所以
 * 此调用不会中断正在进行的上下文构建——真正的中止发生在模型请求 transport 层
 * （options.signal）。若未来要在 worker 内省 CPU，需在 compute 内插粗粒度检查
 * 点轮询 cancel（后续优化项，暂不做）。
 */
export function cancelWorkerRequest(id: string) {
  workerInstance?.postMessage({ id, type: 'cancel' })
}

/** Test hook: read current capability. */
export function __getWritingTurnWorkerCapability(): WorkerCapability {
  return workerCapability
}

/** Test hook: reset singleton + capability cache. */
export function __resetWritingTurnWorker() {
  workerInstance?.terminate()
  workerInstance = undefined
  workerCapability = 'unknown'
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error('test reset'))
  }
  pendingRequests.clear()
}

/** Test hook: inject a mock worker + capability, wired with the real handlers. */
export function __setWritingTurnWorkerForTest(worker: Worker | undefined, capability: WorkerCapability) {
  workerInstance?.terminate()
  workerInstance = worker
  workerCapability = capability
  if (worker) wireWorker(worker)
}

// Lifecycle: terminate the singleton when the page unloads so the worker thread
// is not leaked. Idle keep-alive is intentional — the tiktoken ranks are already
// loaded in the worker realm, so a live worker costs almost nothing and avoids
// re-paying the ~806ms cold start on the next turn. Lazy creation (first
// prepareWritingTurnContext) + crash-rebuild (onerror) are handled in getWorker.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    workerInstance?.terminate()
    workerInstance = undefined
  }, { once: true })
}
