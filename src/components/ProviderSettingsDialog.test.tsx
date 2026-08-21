// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderCapabilities, ProviderSettings } from '../providers/types'
import ProviderSettingsDialog from './ProviderSettingsDialog'
import SettingsDrawer from './SettingsDrawer'

const secretStoreMocks = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
}))

const capacitorMocks = vi.hoisted(() => ({ native: true }))

vi.mock('../providers/secretStore', () => ({ secretStore: secretStoreMocks }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => capacitorMocks.native },
  CapacitorHttp: { request: vi.fn() },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capacitorMocks.native = true
})

const settings: ProviderSettings = {
  text: {
    id: 'text-provider',
    name: '文本服务',
    baseUrl: '',
    model: '',
    protocol: 'openai-compatible',
    secretRef: 'provider:text',
  },
  image: {
    id: 'image-provider',
    name: '图片服务',
    baseUrl: '',
    model: '',
    protocol: 'openai-compatible',
    secretRef: 'provider:image',
  },
  textProviders: [],
  imageProviders: [],
}

function SettingsProviderHandoff() {
  const [providerOpen, setProviderOpen] = useState(false)
  const [slot, setSlot] = useState<'text' | 'image'>('text')

  return (
    <>
      <SettingsDrawer
        open
        suspended={providerOpen}
        projectTitle="测试作品"
        activeThemeId="neutral"
        onClose={vi.fn()}
        onThemeChange={vi.fn().mockResolvedValue(undefined)}
        activeIllustrationStyleId="unconstrained"
        activeCustomStylePrompt=""
        onIllustrationStyleChange={vi.fn().mockResolvedValue(undefined)}
        activeWritingInstructions=""
        onEditWritingInstructions={vi.fn()}
        contextBudget="standard"
        onContextBudgetChange={vi.fn().mockResolvedValue(undefined)}
        contextUsageState="empty"
        onOpenContextUsage={vi.fn()}
        onOpenSummaryHistory={vi.fn()}
        providerSettings={settings}
        onOpenProviderSettings={(nextSlot) => {
          setSlot(nextSlot)
          setProviderOpen(true)
        }}
        appearanceMode="dark"
        onAppearanceChange={vi.fn()}
      />
      <ProviderSettingsDialog
        open={providerOpen}
        nested
        settings={settings}
        initialSlot={slot}
        onClose={() => setProviderOpen(false)}
        onSave={vi.fn()}
      />
    </>
  )
}

describe('ProviderSettingsDialog layering', () => {
  it('does not add another dark backdrop when opened above settings', async () => {
    const { container } = render(
      <ProviderSettingsDialog
        open
        nested
        settings={settings}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: '模型接口' })).toBeDefined()
    expect(container.querySelector('.dialog-backdrop')?.classList.contains('nested-dialog-backdrop')).toBe(true)
    expect(container.querySelector('.provider-dialog')?.classList.contains('nested-provider-dialog')).toBe(true)
    await waitFor(() => expect(secretStoreMocks.get).toHaveBeenCalled())
  })

  it('hands the first frame from settings to the nested provider page without exposing the app below', () => {
    const { container } = render(<SettingsProviderHandoff />)

    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    fireEvent.click(screen.getByRole('button', { name: /文本模型/ }))

    const settingsDrawer = container.querySelector('.settings-drawer')
    const providerDialog = screen.getByRole('dialog', { name: '模型接口' })
    expect(settingsDrawer?.getAttribute('data-suspended')).toBe('true')
    expect(container.querySelector('.settings-backdrop')).not.toBeNull()
    expect(providerDialog.classList.contains('nested-provider-dialog')).toBe(true)
  })

  it('keeps the regular backdrop when opened directly', () => {
    const { container } = render(
      <ProviderSettingsDialog
        open
        settings={settings}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(container.querySelector('.dialog-backdrop')?.classList.contains('nested-dialog-backdrop')).toBe(false)
    expect(container.querySelector('.provider-dialog')?.classList.contains('nested-provider-dialog')).toBe(false)
  })
})

describe('ProviderSettingsDialog Android streaming', () => {
  it('文本供应商默认关闭流式输出并保存用户选择', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<ProviderSettingsDialog open settings={settings} onClose={vi.fn()} onSave={onSave} />)

    const toggle = screen.getByRole('checkbox', { name: /流式输出/ })
    expect((toggle as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('status').textContent).toContain('流式传输已关闭')
    await user.click(toggle)
    expect(screen.getByRole('status').textContent).toContain('流式传输已开启')
    expect(screen.getByText('流式输出：已开启')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].text.androidStreamingEnabled).toBe(true)
  })

  it('Web 环境不显示 Android 专用流式开关', () => {
    capacitorMocks.native = false
    render(<ProviderSettingsDialog open settings={settings} onClose={vi.fn()} onSave={vi.fn()} />)

    expect(screen.queryByRole('checkbox', { name: /流式输出/ })).toBeNull()
  })

  it('OpenAI 官方预设（textTransport=stream）且开关关闭：开关禁用、有效状态显示已开启、提示来源为官方预设', async () => {
    const user = userEvent.setup()
    const withStreamPreset: ProviderSettings = {
      ...settings,
      text: {
        ...settings.text,
        androidStreamingEnabled: false,
        capabilities: {
          reasoningEffortParameter: 'supported',
          outputTokenParameter: 'auto',
          textTransport: 'stream',
          visionInput: 'supported',
          imageEdits: 'supported',
          tokenizerStrategy: 'o200k_base',
          structuredOutput: 'json_schema',
        },
      },
    }
    render(<ProviderSettingsDialog open settings={withStreamPreset} onClose={vi.fn()} onSave={vi.fn()} />)

    const toggle = screen.getByRole('checkbox', { name: /流式输出/ }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText('流式输出：已开启')).toBeDefined()
    expect(screen.getByRole('status').textContent).toContain('流式传输已开启')
    expect(screen.getAllByText(/由“OpenAI 官方”预设决定/).length).toBeGreaterThan(0)
  })

  it('严格中转预设（textTransport=non-stream）且开关开启：开关禁用、有效状态显示已关闭、提示来源为严格中转预设', async () => {
    const withNonStream: ProviderSettings = {
      ...settings,
      text: {
        ...settings.text,
        androidStreamingEnabled: true,
        capabilities: {
          reasoningEffortParameter: 'unsupported',
          outputTokenParameter: 'none',
          textTransport: 'non-stream',
          visionInput: 'unsupported',
          imageEdits: 'unsupported',
          tokenizerStrategy: 'conservative',
          structuredOutput: 'prompt_only',
        },
      },
    }
    render(<ProviderSettingsDialog open settings={withNonStream} onClose={vi.fn()} onSave={vi.fn()} />)

    const toggle = screen.getByRole('checkbox', { name: /流式输出/ }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText('流式输出：已关闭')).toBeDefined()
    expect(screen.getByRole('status').textContent).toContain('流式传输已关闭')
    expect(screen.getAllByText(/由“严格中转”预设决定/).length).toBeGreaterThan(0)
  })

  it('自定义中手动选择 stream：开关禁用、显示已开启、来源文案为兼容能力设置而非预设', async () => {
    const withCustomStream: ProviderSettings = {
      ...settings,
      text: { ...settings.text, capabilities: { textTransport: 'stream' } },
    }
    render(<ProviderSettingsDialog open settings={withCustomStream} onClose={vi.fn()} onSave={vi.fn()} />)

    const toggle = screen.getByRole('checkbox', { name: /流式输出/ }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText('流式输出：已开启')).toBeDefined()
    expect(screen.getAllByText(/由兼容能力设置决定（流式）/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/由“OpenAI 官方”预设决定/)).toBeNull()
  })

  it('自定义中手动选择 non-stream：开关禁用、显示已关闭、来源文案为兼容能力设置而非预设', async () => {
    const withCustomNonStream: ProviderSettings = {
      ...settings,
      text: { ...settings.text, capabilities: { textTransport: 'non-stream' } },
    }
    render(<ProviderSettingsDialog open settings={withCustomNonStream} onClose={vi.fn()} onSave={vi.fn()} />)

    const toggle = screen.getByRole('checkbox', { name: /流式输出/ }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText('流式输出：已关闭')).toBeDefined()
    expect(screen.getAllByText(/由兼容能力设置决定（非流式）/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/由“严格中转”预设决定/)).toBeNull()
  })

  it('auto + 开关开启：开关可用且开启，显示 WebView 流式与 CORS 提示', async () => {
    const withAutoOn: ProviderSettings = {
      ...settings,
      text: { ...settings.text, androidStreamingEnabled: true },
    }
    render(<ProviderSettingsDialog open settings={withAutoOn} onClose={vi.fn()} onSave={vi.fn()} />)

    const toggle = screen.getByRole('checkbox', { name: /流式输出/ }) as HTMLInputElement
    expect(toggle.disabled).toBe(false)
    expect(toggle.checked).toBe(true)
    expect(screen.getByText(/WebView/)).toBeDefined()
    expect(screen.getByText(/CORS/)).toBeDefined()
    expect(screen.getByRole('status').textContent).toContain('流式传输已开启')
  })

  it('auto + 开关关闭：开关可用且关闭，显示原生请求完成后展示全文', async () => {
    const withAutoOff: ProviderSettings = {
      ...settings,
      text: { ...settings.text, androidStreamingEnabled: false },
    }
    render(<ProviderSettingsDialog open settings={withAutoOff} onClose={vi.fn()} onSave={vi.fn()} />)

    const toggle = screen.getByRole('checkbox', { name: /流式输出/ }) as HTMLInputElement
    expect(toggle.disabled).toBe(false)
    expect(toggle.checked).toBe(false)
    expect(screen.getByText(/原生请求/)).toBeDefined()
    expect(screen.getByRole('status').textContent).toContain('流式传输已关闭')
  })

  it('从 OpenAI 官方切到自动兼容：开关恢复可操作并读取原保存的 androidStreamingEnabled', async () => {
    const user = userEvent.setup()
    const withOfficial: ProviderSettings = {
      ...settings,
      text: {
        ...settings.text,
        androidStreamingEnabled: true,
        capabilities: {
          reasoningEffortParameter: 'supported',
          outputTokenParameter: 'auto',
          textTransport: 'stream',
          visionInput: 'supported',
          imageEdits: 'supported',
          tokenizerStrategy: 'o200k_base',
        },
      },
    }
    render(<ProviderSettingsDialog open settings={withOfficial} onClose={vi.fn()} onSave={vi.fn()} />)

    expect((screen.getByRole('checkbox', { name: /流式输出/ }) as HTMLInputElement).disabled).toBe(true)
    await user.click(screen.getByRole('radio', { name: '自动兼容' }))
    const toggle = screen.getByRole('checkbox', { name: /流式输出/ }) as HTMLInputElement
    expect(toggle.disabled).toBe(false)
    expect(toggle.checked).toBe(true)
  })
})

describe('ProviderSettingsDialog compatibility presets', () => {
  it('已识别官方 toggle-only 模型明确提示等级不生效', () => {
    const withToggleOnlyModel: ProviderSettings = {
      ...settings,
      text: {
        ...settings.text,
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-4.6',
      },
    }
    render(<ProviderSettingsDialog open settings={withToggleOnlyModel} onClose={vi.fn()} onSave={vi.fn()} />)

    expect(screen.getByText('该模型仅支持开/关思考，低、中、高等级不生效。')).toBeDefined()
  })

  it('旧配置（无 capabilities）默认选中自动兼容，保存时不新增能力字段', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<ProviderSettingsDialog open settings={settings} onClose={vi.fn()} onSave={onSave} />)

    expect(screen.getByRole('radio', { name: '自动兼容' }).getAttribute('aria-checked')).toBe('true')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].text.capabilities).toBeUndefined()
  })

  it('选择严格中转预设后保存对应能力配置', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<ProviderSettingsDialog open settings={settings} onClose={vi.fn()} onSave={onSave} />)

    await user.click(screen.getByRole('radio', { name: '严格中转' }))
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].text.capabilities).toEqual({
      reasoningEffortParameter: 'unsupported',
      outputTokenParameter: 'none',
      textTransport: 'non-stream',
      visionInput: 'unsupported',
      imageEdits: 'unsupported',
      tokenizerStrategy: 'conservative',
      structuredOutput: 'prompt_only',
    })
  })

  it('自定义预设显示详细能力设置并保存修改', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<ProviderSettingsDialog open settings={settings} onClose={vi.fn()} onSave={onSave} />)

    await user.click(screen.getByRole('radio', { name: '自定义' }))
    const select = screen.getByLabelText('思考等级参数') as HTMLSelectElement
    await user.selectOptions(select, 'unsupported')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].text.capabilities).toEqual({ reasoningEffortParameter: 'unsupported' })
  })

  it('已保存的 OpenAI 官方预设回显为对应预设（含遗留 responseFormat 字段也不受影响）', () => {
    const withPreset: ProviderSettings = {
      ...settings,
      text: {
        ...settings.text,
        capabilities: {
          reasoningEffortParameter: 'supported',
          outputTokenParameter: 'auto',
          textTransport: 'stream',
          visionInput: 'supported',
          imageEdits: 'supported',
          tokenizerStrategy: 'o200k_base',
          // 旧版本保存的字段：方案 B 删除后残留数据必须被忽略
          responseFormat: 'chat-completions',
        } as unknown as ProviderCapabilities,
      },
    }
    render(<ProviderSettingsDialog open settings={withPreset} onClose={vi.fn()} onSave={vi.fn()} />)

    expect(screen.getByRole('radio', { name: 'OpenAI 官方' }).getAttribute('aria-checked')).toBe('true')
  })

  it('图片供应商的自定义预设显示图片能力设置', async () => {
    const user = userEvent.setup()
    render(<ProviderSettingsDialog open settings={settings} initialSlot="image" onClose={vi.fn()} onSave={vi.fn()} />)

    await user.click(screen.getByRole('radio', { name: '自定义' }))
    expect(screen.getByLabelText('参考图编辑')).toBeDefined()
    expect(screen.getByLabelText('支持的图片尺寸')).toBeDefined()
    expect(screen.getByLabelText('竖版尺寸（角色定妆照）')).toBeDefined()
  })

  it('从严格中转切到自定义保留现有能力字段，不重置配置', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const withStrict: ProviderSettings = {
      ...settings,
      text: {
        ...settings.text,
        capabilities: {
          reasoningEffortParameter: 'unsupported',
          outputTokenParameter: 'none',
          textTransport: 'non-stream',
          visionInput: 'unsupported',
          imageEdits: 'unsupported',
          tokenizerStrategy: 'conservative',
          // 旧版本保存的字段：残留数据在自定义编辑与保存过程中不得丢失
          responseFormat: 'chat-completions',
        } as unknown as ProviderCapabilities,
      },
    }
    render(<ProviderSettingsDialog open settings={withStrict} onClose={vi.fn()} onSave={onSave} />)

    await user.click(screen.getByRole('radio', { name: '自定义' }))
    // 自定义面板可见，且视觉输入下拉仍为严格中转的 unsupported
    expect((screen.getByLabelText('视觉输入（识图）') as HTMLSelectElement).value).toBe('unsupported')
    // 用户随后开启视觉输入，其余字段保持不变
    await user.selectOptions(screen.getByLabelText('视觉输入（识图）'), 'supported')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].text.capabilities).toEqual({
      reasoningEffortParameter: 'unsupported',
      outputTokenParameter: 'none',
      textTransport: 'non-stream',
      visionInput: 'supported',
      imageEdits: 'unsupported',
      tokenizerStrategy: 'conservative',
      responseFormat: 'chat-completions',
    })
  })

  it('自定义面板不再提供响应格式选项（方案 B：解析统一自动探测）', async () => {
    const user = userEvent.setup()
    render(<ProviderSettingsDialog open settings={settings} onClose={vi.fn()} onSave={vi.fn()} />)

    await user.click(screen.getByRole('radio', { name: '自定义' }))
    expect(screen.queryByLabelText('响应格式')).toBeNull()
  })

  it('自定义预设可保存结构化输出策略', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<ProviderSettingsDialog open settings={settings} onClose={vi.fn()} onSave={onSave} />)

    await user.click(screen.getByRole('radio', { name: '自定义' }))
    await user.selectOptions(screen.getByLabelText('结构化输出'), 'prompt_only')
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].text.capabilities).toEqual({ structuredOutput: 'prompt_only' })
  })

  it('从自定义切回自动兼容时清空能力字段（明确选择整体替换）', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const withCustom: ProviderSettings = {
      ...settings,
      text: { ...settings.text, capabilities: { visionInput: 'unsupported' } },
    }
    render(<ProviderSettingsDialog open settings={withCustom} onClose={vi.fn()} onSave={onSave} />)

    await user.click(screen.getByRole('radio', { name: '自动兼容' }))
    await user.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].text.capabilities).toEqual({})
  })
})
