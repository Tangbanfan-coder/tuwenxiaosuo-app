import { useState, type CSSProperties } from 'react'
import { AlertTriangle, CheckCircle2, Gauge, LoaderCircle } from 'lucide-react'
import { runTokenEstimatorProbe, type TokenEstimatorProbeResult } from '../providers/tokenEstimatorProbe'

const PROBE_FLAG = 'xy-debug-probe'

/** 是否显示探针入口。默认对生产用户不可见；调试时在控制台设 localStorage 项 `xy-debug-probe=1` 后重进设置即可见。 */
export function tokenEstimatorProbeEnabled() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PROBE_FLAG) === '1'
  } catch {
    return false
  }
}

/**
 * 生产构建下的 Token 估算环境自检。验证目标 WebView 能否：
 *  1. 在生产构建（非 dev server）下构造并执行 module worker；
 *  2. 让 worker 内联 o200k_base 词表并真实 encode 中文（而非运行时 fetch 挂起）。
 * 失败即说明该环境不支持 module worker，正式 worker 化方案需回退主线程。
 */
export function TokenEstimatorProbe() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TokenEstimatorProbeResult>()
  if (!tokenEstimatorProbeEnabled()) return null

  async function run() {
    setRunning(true)
    try {
      setResult(await runTokenEstimatorProbe())
    } catch (error) {
      setResult({
        ok: false,
        stage: 'construct',
        error: error instanceof Error ? error.message : String(error),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        elapsedMs: 0,
      })
    } finally {
      setRunning(false)
    }
  }

  const statusOk = result?.ok

  return (
    <section style={sectionStyle} aria-label="Token 估算环境自检">
      <header style={headerStyle}>
        <Gauge size={16} aria-hidden="true" />
        <div>
          <h3 style={titleStyle}>环境自检</h3>
          <p style={descStyle}>验证当前 WebView 能否在生产构建下跑 module worker 并内联 o200k_base 词表。失败即说明需回退主线程。</p>
        </div>
      </header>
      <button className="icon-button" type="button" onClick={run} disabled={running} style={runButtonStyle}>
        {running ? <LoaderCircle size={16} className="context-usage-spinner" aria-hidden="true" /> : <Gauge size={16} aria-hidden="true" />}
        <span>{running ? '检测中…' : '运行检测'}</span>
      </button>
      {result && (
        <div style={{ ...resultStyle, borderLeftColor: statusOk ? 'var(--color-border-success, #1D9E75)' : 'var(--color-border-danger, #E24B4A)' }} role="status">
          <div style={statusRowStyle}>
            {statusOk ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
            <strong>{statusOk ? '通过' : '失败'}</strong>
            {statusOk && result.tokens != null && <span style={metaTextStyle}>· 返回 {result.tokens} token（o200k_base 真实编码）</span>}
            {!statusOk && <span style={metaTextStyle}>· 阶段：{result.stage}</span>}
          </div>
          {result.error && <p style={errorStyle}>{result.error}</p>}
          <dl style={metaGridStyle}>
            <div><dt style={dtStyle}>来源</dt><dd style={ddStyle}>{result.source ?? '—'}</dd></div>
            <div><dt style={dtStyle}>耗时</dt><dd style={ddStyle}>{result.elapsedMs}ms</dd></div>
            <div style={fullWidthItemStyle}><dt style={dtStyle}>UserAgent</dt><dd style={ddStyle}>{result.userAgent}</dd></div>
          </dl>
        </div>
      )}
    </section>
  )
}

const sectionStyle: CSSProperties = { marginTop: 16, padding: '12px 14px', border: '0.5px solid var(--color-border-tertiary, #B4B2A9)', borderRadius: 12, background: 'var(--color-background-secondary, #F1EFE8)' }
const headerStyle: CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }
const titleStyle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 500 }
const descStyle: CSSProperties = { margin: '4px 0 0', fontSize: 12, color: 'var(--color-text-secondary, #5F5E5A)', lineHeight: 1.5 }
const runButtonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 }
const resultStyle: CSSProperties = { marginTop: 10, padding: '10px 12px', borderLeft: '3px solid', borderRadius: 4, background: 'var(--color-background-primary, #FFFFFF)' }
const statusRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500 }
const metaTextStyle: CSSProperties = { fontWeight: 400, color: 'var(--color-text-secondary, #5F5E5A)' }
const errorStyle: CSSProperties = { margin: '6px 0 0', fontSize: 12, color: 'var(--color-text-danger, #791F1F)', lineHeight: 1.5, wordBreak: 'break-word' }
const metaGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', margin: '8px 0 0' }
const dtStyle: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary, #888780)', margin: 0 }
const ddStyle: CSSProperties = { fontSize: 11, margin: 0, wordBreak: 'break-all' }
const fullWidthItemStyle: CSSProperties = { gridColumn: '1 / -1' }
