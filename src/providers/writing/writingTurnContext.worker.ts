/// <reference lib="webworker" />
import { computeWritingTurnContext, type ComputeWritingTurnContextInput, type ComputedWritingTurnContext } from './writingTurnContext'

/**
 * Thin worker wrapper around computeWritingTurnContext. Receives a build
 * request keyed by id, runs the pure tokenizer-bound computation off the main
 * thread, and posts back either a plan result or an error with the same id so
 * the main-thread driver can match responses to requests.
 *
 * Cancel at coarse checkpoints inside compute is added in step 4; for now this
 * worker is build-only and synchronous within a single message. computeWriting
 * TurnContext is synchronous, so a worker cannot be interrupted mid-encode —
 * cancel will only take effect at the inter-section / inter-message / inter-
 * pass checkpoints wired later, never inside a single encode() call.
 */
interface BuildMessage {
  id: string
  type: 'build'
  payload: ComputeWritingTurnContextInput
}

export type BuildResultMessage = { id: string; type: 'plan'; payload: ComputedWritingTurnContext }
export type BuildErrorMessage = { id: string; type: 'error'; error: string }
export type WorkerOutboundMessage = BuildResultMessage | BuildErrorMessage

self.onmessage = (event: MessageEvent<BuildMessage>) => {
  const message = event.data
  if (!message || message.type !== 'build' || typeof message.id !== 'string') return
  try {
    const result = computeWritingTurnContext(message.payload)
    const outbound: BuildResultMessage = { id: message.id, type: 'plan', payload: result }
    self.postMessage(outbound)
  } catch (error) {
    const outbound: BuildErrorMessage = { id: message.id, type: 'error', error: error instanceof Error ? error.message : String(error) }
    self.postMessage(outbound)
  }
}
