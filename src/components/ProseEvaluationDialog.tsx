import { useEffect, useMemo, useState } from 'react'
import { Download, FileBarChart2, LoaderCircle, Trash2, X } from 'lucide-react'
import { clearProseEvaluationEventsByIds, listProseEvaluationEvents } from '../data/storyDatabase'
import type { ProseEvaluationEvent } from '../domain/models'
import { buildEvaluationReport, evaluationReportCsv, filterEvaluationEvents, saveEvaluationReport, type EvaluationDateRange, type EvaluationExportFormat, type EvaluationReportType } from '../providers/evaluationExport'

const typeLabels: Record<EvaluationReportType, string> = { summary: '汇总统计', events: '匿名事件明细', diagnostic: '故障诊断' }
const rangeLabels: Record<EvaluationDateRange, string> = { '7d': '最近 7 天', '30d': '最近 30 天', '90d': '最近 90 天', all: '全部', custom: '自定义日期' }

export default function ProseEvaluationDialog({ open, currentProjectId, onClose }: { open: boolean; currentProjectId?: string; onClose: () => void }) {
  const [events, setEvents] = useState<ProseEvaluationEvent[]>([])
  const [reportType, setReportType] = useState<EvaluationReportType>('summary')
  const [range, setRange] = useState<EvaluationDateRange>('30d')
  const [scope, setScope] = useState<'all' | 'current'>('all')
  const [format, setFormat] = useState<EvaluationExportFormat>('json')
  const [customStart, setCustomStart] = useState(''); const [customEnd, setCustomEnd] = useState('')
  const [linkReports, setLinkReports] = useState(false); const [clearAfterExport, setClearAfterExport] = useState(false)
  const [preview, setPreview] = useState<ReturnType<typeof buildEvaluationReport>>()
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [confirmClear, setConfirmClear] = useState(false)
  const refresh = async () => { try { setEvents(await listProseEvaluationEvents()) } catch { setError('无法读取本地评估数据') } }
  useEffect(() => { if (open) { setPreview(undefined); setError(''); void refresh() } }, [open])
  useEffect(() => { if (!open) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) }, [onClose, open])
  const options = useMemo(() => ({ reportType, dateRange: range, projectId: scope === 'current' ? currentProjectId : undefined, format, customStartAt: customStart ? new Date(`${customStart}T00:00:00`).getTime() : undefined, customEndAt: customEnd ? new Date(`${customEnd}T23:59:59`).getTime() : undefined, linkReports }), [currentProjectId, customEnd, customStart, format, linkReports, range, reportType, scope])
  if (!open) return null
  const selectedCount = preview ? ('events' in preview ? preview.events.length : preview.summary.eventCount) : 0
  const previewSample = preview && 'events' in preview ? preview.events.slice(0, 2) : []
  const dateText = events.length ? `${new Date(events[0].occurredAt).toLocaleDateString()} 至 ${new Date(events.at(-1)!.occurredAt).toLocaleDateString()}` : '暂无记录'
  async function generatePreview() { setBusy(true); setError(''); try { setPreview(buildEvaluationReport(events, options)) } catch { setError('生成预览失败') } finally { setBusy(false) } }
  async function exportReport() { if (!preview) return; setBusy(true); setError(''); try { const content = format === 'json' ? JSON.stringify(preview, null, 2) : evaluationReportCsv(preview); await saveEvaluationReport(`叙影-文风评估-${new Date().toISOString().slice(0, 10)}.${format}`, content, format); if (clearAfterExport) { const selected = filterEvaluationEvents(events, options); const ids = (reportType === 'diagnostic' ? selected.filter((event) => event.eventType === 'rewrite_failed' || event.eventType === 'rewrite_apply_failed') : selected).map((event) => event.id); await clearProseEvaluationEventsByIds(ids); await refresh(); setPreview(undefined) } } catch { setError('导出失败，请检查设备存储权限后重试') } finally { setBusy(false) } }
  async function clear() { setBusy(true); setError(''); try { await clearProseEvaluationEventsByIds(events.map((event) => event.id)); setEvents([]); setPreview(undefined); setConfirmClear(false) } catch { setError('清除失败，请重试') } finally { setBusy(false) } }
  return <div className="settings-backdrop prose-evaluation-backdrop" role="presentation"><section className="prose-evaluation-dialog" role="dialog" aria-modal="true" aria-labelledby="prose-evaluation-title">
    <header className="drawer-header"><div><h2 id="prose-evaluation-title">文风优化数据</h2><p>{events.length} 条本地记录 · {dateText}</p></div><button className="icon-button" type="button" aria-label="关闭文风优化数据" onClick={onClose}><X size={20} /></button></header>
    <div className="prose-evaluation-content">
      <p className="settings-help">记录仅保存在本设备。导出前可审阅，默认不含正文、建议稿、作品或人物名称、语料、提示词、模型地址和密钥。</p>
      <fieldset><legend>报告类型</legend><div className="evaluation-options">{(Object.keys(typeLabels) as EvaluationReportType[]).map((value) => <button key={value} type="button" role="radio" aria-checked={reportType === value} onClick={() => { setReportType(value); if (value === 'diagnostic') setFormat('json'); setPreview(undefined) }}>{typeLabels[value]}</button>)}</div></fieldset>
      <fieldset><legend>时间范围</legend><div className="evaluation-options">{(Object.keys(rangeLabels) as EvaluationDateRange[]).map((value) => <button key={value} type="button" role="radio" aria-checked={range === value} onClick={() => { setRange(value); if (value !== 'custom') { setCustomStart(''); setCustomEnd('') }; setPreview(undefined) }}>{rangeLabels[value]}</button>)}</div></fieldset>
      {range === 'custom' && <div className="evaluation-date-inputs"><label>起始日期<input type="date" value={customStart} onChange={(event) => { setCustomStart(event.target.value); setPreview(undefined) }} /></label><label>结束日期<input type="date" value={customEnd} onChange={(event) => { setCustomEnd(event.target.value); setPreview(undefined) }} /></label></div>}
      <fieldset><legend>作品范围</legend><div className="evaluation-options"><button type="button" role="radio" aria-checked={scope === 'all'} onClick={() => { setScope('all'); setPreview(undefined) }}>所有作品</button><button type="button" role="radio" disabled={!currentProjectId} aria-checked={scope === 'current'} onClick={() => { setScope('current'); setPreview(undefined) }}>当前作品</button></div></fieldset>
      <fieldset><legend>文件格式</legend><div className="evaluation-options"><button type="button" role="radio" aria-checked={format === 'json'} onClick={() => { setFormat('json'); setPreview(undefined) }}>JSON</button><button type="button" role="radio" disabled={reportType === 'diagnostic'} aria-checked={format === 'csv'} onClick={() => { setFormat('csv'); setPreview(undefined) }}>CSV</button></div>{reportType === 'diagnostic' && <small>故障诊断仅支持 JSON，以保留版本和失败分类。</small>}</fieldset>
      <label className="evaluation-toggle"><input type="checkbox" checked={linkReports} onChange={(event) => { setLinkReports(event.target.checked); setPreview(undefined) }} />允许关联我多次导出的报告</label>
      {error && <p className="feedback-error" role="alert">{error}</p>}
      <button className="primary-button evaluation-action" type="button" disabled={busy} onClick={() => void generatePreview()}>{busy ? <LoaderCircle className="spin" size={17} /> : <FileBarChart2 size={17} />}生成预览</button>
      {preview && <section className="evaluation-preview" aria-label="导出预览"><h3>导出审阅</h3><p>{selectedCount} 条最终脱敏记录，覆盖 {preview.anonymousProjectCount} 个匿名作品，预计约 {Math.max(1, Math.ceil(JSON.stringify(preview).length / 1024))} KB。</p><p><strong>包含：</strong>规则 ID、枚举结果、时长区间、长度区间、匿名关联 ID。</p><p><strong>不包含：</strong>正文、建议稿、任何名称、语料原文、创作设定、提示词、接口地址、密钥或完整模型名。</p>{'summary' in preview && <pre>{JSON.stringify(preview.summary, null, 2)}</pre>}{previewSample.length > 0 && <pre>{JSON.stringify(previewSample, null, 2)}</pre>}<label className="evaluation-toggle"><input type="checkbox" checked={clearAfterExport} onChange={(event) => setClearAfterExport(event.target.checked)} />导出后清除本次报告包含的本地记录</label><button className="primary-button evaluation-action" type="button" disabled={busy} onClick={() => void exportReport()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}确认导出 {format.toUpperCase()}</button></section>}
      <section className="evaluation-danger"><h3>清除本地数据</h3><p>只会清除文风优化评估记录，不影响作品、语料库或模型配置。</p>{confirmClear ? <div><button type="button" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => void clear()}>{busy ? '清除中…' : '确认清除'}</button></div> : <button type="button" disabled={busy || !events.length} onClick={() => setConfirmClear(true)}><Trash2 size={16} />清除本地数据</button>}</section>
    </div>
  </section></div>
}
