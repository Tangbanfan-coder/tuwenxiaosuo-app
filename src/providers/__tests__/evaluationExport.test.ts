import { describe, expect, it, vi } from 'vitest'
import type { ProseEvaluationEvent } from '../../domain/models'
import { anonymizeEvaluationEvents, buildEvaluationReport, evaluationReportCsv, filterEvaluationEvents } from '../evaluationExport'

const event = (patch: Partial<ProseEvaluationEvent> = {}): ProseEvaluationEvent => ({
  id: 'local-1', eventType: 'prose_analyzed', occurredAt: 1_000, schemaVersion: 1, appVersion: '0.1.0', databaseVersion: 12, proseRuleVersion: 3,
  projectId: 'real-project', messageId: 'real-message', paragraphId: 'real-paragraph', ruleIds: ['rule-a'], severities: ['warning'], ...patch,
})

describe('evaluation export', () => {
  it('uses a whitelist and stable IDs within a report while changing report IDs', () => {
    const first = anonymizeEvaluationEvents([event(), event({ id: 'local-2', messageId: 'real-message' })], '00000000-0000-4000-8000-000000000001')
    const second = anonymizeEvaluationEvents([event()], '00000000-0000-4000-8000-000000000002')
    expect(first[0].projectId).toBe(first[1].projectId)
    expect(first[0].messageId).toBe(first[1].messageId)
    expect(first[0].projectId).not.toContain('real-project')
    expect(second[0].projectId).not.toBe(first[0].projectId)
    expect(first[0]).not.toHaveProperty('matchedText')
  })

  it('filters by date and project and diagnostic only emits failures', () => {
    const events = [event({ occurredAt: 1_000 }), event({ id: '2', occurredAt: 10_000, projectId: 'other', eventType: 'rewrite_failed' }), event({ id: '3', occurredAt: 10_000, eventType: 'rewrite_succeeded' })]
    expect(filterEvaluationEvents(events, { dateRange: 'all', projectId: 'real-project' }, 10_000)).toHaveLength(2)
    const report = buildEvaluationReport(events, { reportType: 'diagnostic', dateRange: 'all', format: 'json' }, 10_000)
    expect('events' in report && report.events.every((item) => item.eventType.includes('failed'))).toBe(true)
  })

  it('aggregates rates without exposing content', () => {
    const report = buildEvaluationReport([event({ eventType: 'rewrite_requested' }), event({ id: '2', eventType: 'rewrite_succeeded' }), event({ id: '3', eventType: 'rewrite_applied' })], { reportType: 'summary', dateRange: 'all', format: 'json' }, 2_000)
    expect('summary' in report && report.summary.rates.rewriteApplyRate).toBe(1)
    expect(JSON.stringify(report)).not.toContain('real-')
  })

  it('uses an explicit custom range in both filtering and report metadata', () => {
    const events = [event({ occurredAt: 1_000 }), event({ id: '2', occurredAt: 2_000 }), event({ id: '3', occurredAt: 3_000 })]
    const options = { reportType: 'events' as const, dateRange: 'custom' as const, customStartAt: 2_000, customEndAt: 2_000, format: 'json' as const }
    expect(filterEvaluationEvents(events, options, 10_000)).toEqual([events[1]])
    const report = buildEvaluationReport(events, options, 10_000)
    expect(report.dateRange).toBe('custom')
    expect(report.customDateRange).toEqual({ startAt: 2_000, endAt: 2_000 })
    expect('events' in report && report.events).toHaveLength(1)
    expect(() => buildEvaluationReport(events, { ...options, customEndAt: 1_000 }, 10_000)).toThrow('有效的自定义起止日期')
  })

  it('keeps a custom range beginning at the Unix epoch explicit', () => {
    const options = { reportType: 'events' as const, dateRange: 'custom' as const, customStartAt: 0, customEndAt: 1_000, format: 'json' as const }
    const report = buildEvaluationReport([event({ occurredAt: 0 }), event({ id: '2', occurredAt: 1_001 })], options, 10_000)
    expect('events' in report && report.events).toHaveLength(1)
    expect(report.customDateRange).toEqual({ startAt: 0, endAt: 1_000 })
  })

  it('includes all summary dimensions in CSV', () => {
    const report = buildEvaluationReport([
      event({ eventType: 'prose_analyzed', ruleIds: ['rule-a'] }),
      event({ id: '2', eventType: 'rewrite_requested' }),
      event({ id: '3', eventType: 'rewrite_succeeded' }),
      event({ id: '4', eventType: 'rewrite_applied' }),
    ], { reportType: 'summary', dateRange: 'all', format: 'csv' }, 2_000)
    const csv = evaluationReportCsv(report)
    expect(csv).toContain('"countsByType","prose_analyzed","1"')
    expect(csv).toContain('"ruleCounts","rule-a","1"')
    expect(csv).toContain('"rates","rewriteSuccessRate","1"')
  })
})
