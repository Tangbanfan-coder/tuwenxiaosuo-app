import type { ContextBudget, ProseEvaluationEvent, ProseStyleIssue, RewriteStrength } from './models'

export const PROSE_EVALUATION_SCHEMA_VERSION = 1 as const
export const PROSE_EVALUATION_DATABASE_VERSION = 11 as const
export const PROSE_EVALUATION_APP_VERSION = '0.1.0' as const

export type EvaluationFailureKind = NonNullable<ProseEvaluationEvent['failureKind']>

export function proseLengthBucket(value: string): NonNullable<ProseEvaluationEvent['paragraphLengthBucket']> {
  const length = value.length
  if (length <= 100) return '0-100'
  if (length <= 300) return '101-300'
  if (length <= 800) return '301-800'
  return '801+'
}

export function proseLengthChangeBucket(before: string, after: string): NonNullable<ProseEvaluationEvent['lengthChangeBucket']> {
  if (!before.length) return 'similar'
  const ratio = (after.length - before.length) / before.length
  if (ratio <= -0.3) return 'shorter-30+'
  if (ratio <= -0.1) return 'shorter-10-29'
  if (ratio < 0.1) return 'similar'
  if (ratio < 0.3) return 'longer-10-29'
  return 'longer-30+'
}

export function proseDurationBucket(durationMs: number): NonNullable<ProseEvaluationEvent['durationBucket']> {
  if (durationMs < 1_000) return 'under-1s'
  if (durationMs < 5_000) return '1-5s'
  if (durationMs < 15_000) return '5-15s'
  if (durationMs < 60_000) return '15-60s'
  return '60s+'
}

export function evaluationIssueFields(issues: readonly ProseStyleIssue[]) {
  return { ruleIds: issues.map((issue) => issue.ruleId), severities: issues.map((issue) => issue.severity) }
}

export function createEvaluationEvent(
  eventType: ProseEvaluationEvent['eventType'],
  input: Omit<Partial<ProseEvaluationEvent>, 'id' | 'eventType' | 'occurredAt' | 'schemaVersion' | 'appVersion' | 'databaseVersion'> = {},
) {
  return {
    eventType,
    proseRuleVersion: input.proseRuleVersion ?? 1,
    ...input,
  } satisfies Omit<ProseEvaluationEvent, 'id' | 'occurredAt' | 'schemaVersion' | 'appVersion' | 'databaseVersion'>
}

export function rewriteRequestedEvaluation(input: {
  projectId: string; messageId: string; paragraphId: string; originalText: string; issues: readonly ProseStyleIssue[]; strength: RewriteStrength
}) {
  return createEvaluationEvent('rewrite_requested', {
    projectId: input.projectId, messageId: input.messageId, paragraphId: input.paragraphId,
    paragraphLengthBucket: proseLengthBucket(input.originalText), rewriteStrength: input.strength,
    factProtection: 'not_checked', ...evaluationIssueFields(input.issues),
  })
}

export function writingTurnCompletedEvaluation(input: { projectId: string; corpusFragmentCount: number; contextBudget: ContextBudget }) {
  return createEvaluationEvent('writing_turn_completed', {
    projectId: input.projectId, corpusFragmentCount: input.corpusFragmentCount, contextBudget: input.contextBudget,
  })
}
