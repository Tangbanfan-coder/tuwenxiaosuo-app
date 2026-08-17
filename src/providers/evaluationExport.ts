import { Capacitor } from '@capacitor/core'
import { FileSharer } from '@capgo/capacitor-file-sharer'
import type { ProseEvaluationEvent, ProseEvaluationEventType } from '../domain/models'

export type EvaluationReportType = 'summary' | 'events' | 'diagnostic'
export type EvaluationDateRange = '7d' | '30d' | '90d' | 'all' | 'custom'
export type EvaluationExportFormat = 'json' | 'csv'
export interface EvaluationExportOptions { reportType: EvaluationReportType; dateRange: EvaluationDateRange; projectId?: string; format: EvaluationExportFormat; customStartAt?: number; customEndAt?: number; linkReports?: boolean }

export interface AnonymousEvaluationEvent {
  eventType: ProseEvaluationEventType; occurredAt: number; schemaVersion: 1; appVersion: '0.1.0'; databaseVersion: 12; proseRuleVersion: number
  projectId?: string; messageId?: string; paragraphId?: string; ruleIds?: string[]; severities?: string[]; beforeRuleIds?: string[]; afterRuleIds?: string[]
  paragraphLengthBucket?: string; suggestionLengthBucket?: string; lengthChangeBucket?: string; rewriteStrength?: string; durationBucket?: string
  corpusFragmentCount?: number; contextBudget?: string; failureKind?: string; factProtection?: 'not_checked'
}

const DAY = 24 * 60 * 60 * 1000
const rangeDays: Record<Exclude<EvaluationDateRange, 'custom'>, number | undefined> = { '7d': 7, '30d': 30, '90d': 90, all: undefined }
const exportKeys = ['eventType', 'occurredAt', 'schemaVersion', 'appVersion', 'databaseVersion', 'proseRuleVersion', 'projectId', 'messageId', 'paragraphId', 'ruleIds', 'severities', 'beforeRuleIds', 'afterRuleIds', 'paragraphLengthBucket', 'suggestionLengthBucket', 'lengthChangeBucket', 'rewriteStrength', 'durationBucket', 'corpusFragmentCount', 'contextBudget', 'failureKind', 'factProtection'] as const

export function filterEvaluationEvents(events: readonly ProseEvaluationEvent[], options: Pick<EvaluationExportOptions, 'dateRange' | 'projectId' | 'customStartAt' | 'customEndAt'>, now = Date.now()) {
  if (options.dateRange === 'custom') {
    return events.filter((event) => (options.customStartAt === undefined || event.occurredAt >= options.customStartAt) && (options.customEndAt === undefined || event.occurredAt <= options.customEndAt) && (!options.projectId || event.projectId === options.projectId))
  }
  const days = rangeDays[options.dateRange]
  const since = days === undefined ? undefined : now - days * DAY
  return events.filter((event) => (since === undefined || event.occurredAt >= since) && (!options.projectId || event.projectId === options.projectId))
}

function anonymousId(reportId: string, index: number) { return `${reportId}-${index + 1}` }

/** Whitelist serialization prevents accidental disclosure if a local event gains fields in a later release. */
export function anonymizeEvaluationEvents(events: readonly ProseEvaluationEvent[], reportId = crypto.randomUUID()): AnonymousEvaluationEvent[] {
  const projectIds = new Map<string, string>(); const messageIds = new Map<string, string>(); const paragraphIds = new Map<string, string>()
  const map = (source: string | undefined, values: Map<string, string>, prefix: string) => {
    if (!source) return undefined
    let value = values.get(source)
    if (!value) { value = `${prefix}-${anonymousId(reportId, values.size)}`; values.set(source, value) }
    return value
  }
  return events.map((event) => {
    const output: Record<string, unknown> = {}
    for (const key of exportKeys) if (event[key] !== undefined) output[key] = Array.isArray(event[key]) ? [...event[key] as string[]] : event[key]
    output.projectId = map(event.projectId, projectIds, 'project')
    output.messageId = map(event.messageId, messageIds, 'message')
    output.paragraphId = map(event.paragraphId, paragraphIds, 'paragraph')
    if (!output.projectId) delete output.projectId
    if (!output.messageId) delete output.messageId
    if (!output.paragraphId) delete output.paragraphId
    return output as unknown as AnonymousEvaluationEvent
  })
}

export function summarizeEvaluationEvents(events: readonly AnonymousEvaluationEvent[]) {
  const countsByType = Object.fromEntries(Object.entries(events.reduce<Record<string, number>>((result, event) => { result[event.eventType] = (result[event.eventType] ?? 0) + 1; return result }, {})).sort())
  const ruleHits = events.filter((event) => event.eventType === 'prose_analyzed').flatMap((event) => event.ruleIds ?? [])
  const ruleCounts = Object.fromEntries(Object.entries(ruleHits.reduce<Record<string, number>>((result, ruleId) => { result[ruleId] = (result[ruleId] ?? 0) + 1; return result }, {})).sort())
  const succeeded = countsByType.rewrite_succeeded ?? 0; const applied = countsByType.rewrite_applied ?? 0
  const requested = countsByType.rewrite_requested ?? 0; const failed = countsByType.rewrite_failed ?? 0
  return { eventCount: events.length, countsByType, ruleCounts, rates: {
    rewriteSuccessRate: requested ? succeeded / requested : null,
    rewriteApplyRate: succeeded ? applied / succeeded : null,
    rewriteFailureRate: requested ? failed / requested : null,
  } }
}

export function buildEvaluationReport(events: readonly ProseEvaluationEvent[], options: EvaluationExportOptions, now = Date.now()) {
  if (options.dateRange === 'custom' && (options.customStartAt === undefined || options.customEndAt === undefined || options.customStartAt > options.customEndAt)) {
    throw new Error('请选择有效的自定义起止日期')
  }
  const filtered = filterEvaluationEvents(events, options, now); const diagnostic = options.reportType === 'diagnostic' ? filtered.filter((event) => event.eventType === 'rewrite_failed' || event.eventType === 'rewrite_apply_failed') : filtered
  const reportId = crypto.randomUUID(); const anonymized = anonymizeEvaluationEvents(diagnostic, reportId)
  const installationAnonymousId = options.linkReports ? getInstallationAnonymousId() : undefined
  const metadata = {
    reportId,
    ...(installationAnonymousId ? { installationAnonymousId } : {}),
    generatedAt: now,
    reportType: options.reportType,
    dateRange: options.dateRange,
    ...(options.dateRange === 'custom' ? { customDateRange: { startAt: options.customStartAt!, endAt: options.customEndAt! } } : {}),
    projectScope: options.projectId ? 'current' : 'all',
    anonymousProjectCount: new Set(anonymized.map((event) => event.projectId).filter(Boolean)).size,
    schemaVersion: 1,
    privacy: 'No prose, suggestions, titles, names, prompts, corpus text, provider URLs, keys, or model IDs are included.',
  }
  return options.reportType === 'summary' ? { ...metadata, summary: summarizeEvaluationEvents(anonymized) } : { ...metadata, events: anonymized }
}

const INSTALLATION_ID_KEY = 'illustrated-story-chat.evaluation-installation-anonymous-id.v1'
function getInstallationAnonymousId() { let id = localStorage.getItem(INSTALLATION_ID_KEY); if (!id) { id = crypto.randomUUID(); localStorage.setItem(INSTALLATION_ID_KEY, id) }; return id }

function csvValue(value: unknown) { const string = Array.isArray(value) ? value.join('|') : value == null ? '' : String(value); return `"${string.replaceAll('"', '""')}"` }
export function evaluationReportCsv(report: ReturnType<typeof buildEvaluationReport>) {
  const rows = 'events' in report
    ? report.events
    : [
        { section: 'summary', key: 'eventCount', value: report.summary.eventCount },
        ...Object.entries(report.summary.countsByType).map(([key, value]) => ({ section: 'countsByType', key, value })),
        ...Object.entries(report.summary.ruleCounts).map(([key, value]) => ({ section: 'ruleCounts', key, value })),
        ...Object.entries(report.summary.rates).map(([key, value]) => ({ section: 'rates', key, value })),
      ]
  const headers = rows.length ? Object.keys(rows[0]) : ['eventType', 'count']
  return [headers.join(','), ...rows.map((row) => headers.map((key) => csvValue((row as Record<string, unknown>)[key])).join(','))].join('\n')
}

function base64Utf8(value: string) { const bytes = new TextEncoder().encode(value); let binary = ''; bytes.forEach((byte) => { binary += String.fromCharCode(byte) }); return btoa(binary) }
export async function saveEvaluationReport(fileName: string, content: string, format: EvaluationExportFormat) {
  const contentType = format === 'json' ? 'application/json' : 'text/csv'
  if (Capacitor.isNativePlatform()) { await FileSharer.save({ base64Data: `data:${contentType};base64,${base64Utf8(content)}`, filename: fileName, contentType, android: { saveDirectory: 'documents', relativePath: '叙影' } }); return }
  const url = URL.createObjectURL(new Blob([content], { type: `${contentType};charset=utf-8` })); const link = document.createElement('a'); link.href = url; link.download = fileName; link.click(); URL.revokeObjectURL(url)
}
