import { AlertTriangle, Gauge, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ContextBudgetPlan, ContextCompressionStage } from '../providers/writing'

export type ContextUsageState = 'ready' | 'loading' | 'empty' | 'over-limit' | 'fallback' | 'error'
export const CONTEXT_USAGE_SECTION_SCALE_PROPERTY = '--context-usage-section-scale'

export interface ContextUsageDetailsProps {
  plan?: ContextBudgetPlan
  state: ContextUsageState
  error?: string
}

interface ContextUsageProps extends ContextUsageDetailsProps {
  detailsOpen?: boolean
  onDetailsOpenChange?: (open: boolean) => void
  detailsPresentation?: 'popover' | 'sheet'
}

function formatTokens(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString('zh-CN')
}

function formatCompactTokens(value: number) {
  const rounded = Math.max(0, Math.round(value))
  if (rounded < 1_000) return rounded.toLocaleString('zh-CN')
  if (rounded < 1_000_000) return `${Number((rounded / 1_000).toFixed(1))}k`
  return `${Number((rounded / 1_000_000).toFixed(1))}M`
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, value) * 100)}%`
}

function sectionBarStyle(value: number) {
  const percentage = Math.round(Math.min(100, Math.max(0, value * 100)) * 10) / 10
  return { [CONTEXT_USAGE_SECTION_SCALE_PROPERTY]: `${percentage / 100}` } as CSSProperties
}

/** Shared concise copy for the composer strip and Settings drawer entry. */
export function contextUsageSummary(plan: ContextBudgetPlan | undefined, state: ContextUsageState) {
  if (state === 'loading') return '上下文 · 估算中'
  if (state === 'empty') return '上下文 · 暂无输入'
  if (state === 'error') return '上下文 · 暂不可估算'
  if (!plan) return '上下文 · 暂无计划'
  return `上下文 · 约 ${formatTokens(plan.estimatedInputTokens)} / ${formatTokens(plan.inputLimitTokens)}`
}

function ContextUsageStateMessage({ state, error }: Pick<ContextUsageDetailsProps, 'state' | 'error'>) {
  if (state === 'loading') {
    return (
      <div className="context-usage-state" role="status">
        <LoaderCircle size={17} className="context-usage-spinner" aria-hidden="true" />
        <p>正在按当前模型、工作区和检索内容估算本轮上下文…</p>
      </div>
    )
  }
  if (state === 'empty') {
    return <p className="context-usage-empty">暂无输入或未配置文本模型。开始输入后会显示本轮真实预算。</p>
  }
  if (state === 'error') {
    return (
      <div className="context-usage-error" role="alert">
        <AlertTriangle size={17} aria-hidden="true" />
        <p>预算预览暂不可用，仍可继续发送。{error ? ` ${error}` : ''}</p>
      </div>
    )
  }
  return null
}

interface ContextCompressionStatus {
  label: string
  description: string
  recoverySuggestion?: string
}

export function contextCompressionStatus(stage: ContextCompressionStage): ContextCompressionStatus {
  switch (stage) {
    case 'organizing':
      return {
        label: '正在整理上下文',
        description: '接近预算，已轻度收紧近期对话和时间线。',
      }
    case 'compressed':
      return {
        label: '已压缩上下文',
        description: '优先保留章节提要、核心记忆和当前工作区。',
      }
    case 'critical':
      return {
        label: '紧凑上下文',
        description: '预算压力很高，当前只保留核心规则、章节状态与必要锚点。',
        recoverySuggestion: '如需更多历史细节，可缩短本条输入、降低最大输出，或改用更大窗口的模型。',
      }
    default:
      return {
        label: '常规上下文',
        description: '当前按完整工作区资料组织本轮内容。',
      }
  }
}

function ContextCompressionNotice({ plan }: { plan: ContextBudgetPlan }) {
  const status = contextCompressionStatus(plan.compressionStage)
  return (
    <section
      className={`context-usage-compression context-usage-compression--${plan.compressionStage}`}
      aria-label={`上下文档位：${status.label}`}
    >
      <Gauge size={17} aria-hidden="true" />
      <div>
        <strong>{status.label}</strong>
        <p>{status.description}</p>
        {status.recoverySuggestion && <p className="context-usage-compression-recovery">建议：{status.recoverySuggestion}</p>}
      </div>
    </section>
  )
}

/**
 * Shared detail renderer. The composer dialog and Settings entry both use the
 * same ContextBudgetPlan snapshot prepared by App.
 */
export function ContextUsageDetails({ plan, state, error }: ContextUsageDetailsProps) {
  if (state === 'loading' || state === 'empty' || state === 'error') {
    return <div className="context-usage-details"><ContextUsageStateMessage state={state} error={error} /></div>
  }
  if (!plan) return <div className="context-usage-details"><p className="context-usage-empty">暂无可显示的上下文计划。</p></div>

  const isOverLimit = state === 'over-limit' || plan.isOverLimit

  return (
    <div className="context-usage-details">
      {isOverLimit && (
        <div className="context-usage-warning" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <p><strong>本轮可能超出上下文窗口。</strong>缩短本条输入、降低最大输出，或改用更大窗口的模型后再试。</p>
        </div>
      )}
      {plan.estimator.isFallback && (
        <div className="context-usage-fallback" role="status">
          <Gauge size={17} aria-hidden="true" />
          <p><strong>估算回退</strong> · 当前使用 {plan.estimator.source}，结果为近似值。</p>
        </div>
      )}

      <ContextCompressionNotice plan={plan} />

      <dl className="context-usage-summary-grid">
        <div><dt>已用窗口</dt><dd>{formatTokens(plan.usedTokens)} / {formatTokens(plan.windowTokens)}</dd></div>
        <div><dt>窗口占比</dt><dd>{formatPercent(plan.windowUsageRatio)}</dd></div>
        <div><dt>输出预留</dt><dd>{formatTokens(plan.outputReserveTokens)}</dd></div>
        <div><dt>安全余量</dt><dd>{formatTokens(plan.safetyMarginTokens)}</dd></div>
        <div><dt>剩余 token</dt><dd className={plan.remainingTokens < 0 ? 'is-negative' : undefined}>{plan.remainingTokens < 0 ? '-' : ''}{formatTokens(Math.abs(plan.remainingTokens))}</dd></div>
        <div><dt>输入估算</dt><dd>{formatTokens(plan.estimatedInputTokens)}</dd></div>
      </dl>

      <section className="context-usage-sections" aria-labelledby="context-usage-section-title">
        <div className="context-usage-section-heading">
          <h3 id="context-usage-section-title">本轮内容分项</h3>
          <span>占输入比例</span>
        </div>
        <ul>
          {plan.sections.map((section) => (
            <li key={section.key}>
              <div className="context-usage-section-copy">
                <span>{section.label}</span>
                <strong>{formatTokens(section.tokens)} token · {formatPercent(section.percentageOfEstimatedInput)}</strong>
              </div>
              <div className="context-usage-section-bar" aria-hidden="true">
                <span style={sectionBarStyle(section.percentageOfEstimatedInput)} />
              </div>
            </li>
          ))}
        </ul>
      </section>
      <p className="context-usage-provenance">计数来源：{plan.estimator.source} · 已按当前输出预留和安全余量计算。</p>
    </div>
  )
}

export default function ContextUsage({
  plan,
  state,
  error,
  detailsOpen,
  onDetailsOpenChange,
  detailsPresentation = 'popover',
}: ContextUsageProps) {
  const [internalDetailsOpen, setInternalDetailsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const isDetailsOpen = detailsOpen ?? internalDetailsOpen
  const summary = contextUsageSummary(plan, state)

  function setDetailsOpen(nextOpen: boolean) {
    if (nextOpen) previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (detailsOpen === undefined) setInternalDetailsOpen(nextOpen)
    onDetailsOpenChange?.(nextOpen)
    if (!nextOpen) {
      window.setTimeout(() => {
        if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus()
      }, 0)
    }
  }

  useEffect(() => {
    if (!isDetailsOpen) return
    if (!previousFocusRef.current?.isConnected) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0)
    const handlePointerDown = (event: MouseEvent) => {
      if (detailsPresentation !== 'popover' || rootRef.current?.contains(event.target as Node)) return
      setDetailsOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setDetailsOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [detailsPresentation, isDetailsOpen])

  const compactSummary = state === 'loading'
    ? '估算中'
    : state === 'error'
      ? '暂不可估算'
      : plan
        ? `${formatCompactTokens(plan.estimatedInputTokens)} / ${formatCompactTokens(plan.inputLimitTokens)}`
        : '上下文'

  return (
    <div
      ref={rootRef}
      className="context-usage"
      data-status={state}
      data-compression-stage={plan?.compressionStage}
      data-details-presentation={detailsPresentation}
    >
      <button
        className="context-usage-trigger"
        type="button"
        aria-label={`${summary}，查看本轮上下文用量明细`}
        aria-expanded={isDetailsOpen}
        aria-haspopup="dialog"
        onClick={() => setDetailsOpen(true)}
      >
        {state === 'loading' ? <LoaderCircle size={14} className="context-usage-spinner" aria-hidden="true" /> : <Gauge size={14} aria-hidden="true" />}
        <span>{compactSummary}</span>
        {state === 'over-limit' && <AlertTriangle size={14} aria-label="预算超限警告" />}
      </button>

      {isDetailsOpen && (
        <div className={`context-usage-surface context-usage-surface--${detailsPresentation}`} role="presentation" onMouseDown={(event) => {
          if (detailsPresentation === 'sheet' && event.currentTarget === event.target) setDetailsOpen(false)
        }}>
          <section className="context-usage-dialog" role="dialog" aria-modal={detailsPresentation === 'sheet'} aria-labelledby="context-usage-dialog-title">
            <header className="context-usage-dialog-header">
              <div>
                <h2 id="context-usage-dialog-title">本轮上下文用量</h2>
                <p>发送前的真实预算预览</p>
              </div>
              <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭上下文用量明细" onClick={() => setDetailsOpen(false)}>
                <X size={20} />
              </button>
            </header>
            <div className="context-usage-dialog-body">
              <ContextUsageDetails plan={plan} state={state} error={error} />
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
