import { describe, expect, it } from 'vitest'
import { projectStreamingProse } from '../writing'

describe('流式正文投影', () => {
  it('隐藏 JSON 元数据，只显示已开始的正文段落', () => {
    expect(projectStreamingProse('{"assistant_note":"ok","prose":{"paragraphs":[')).toBe('')
    expect(projectStreamingProse('{"assistant_note":"ok","prose":{"paragraphs":["海风拂过')).toBe('海风拂过')
    expect(projectStreamingProse('{"assistant_note":"ok","prose":{"paragraphs":["海风拂过","第二段"],"chapter_summary":"..."},"scene_notes":{"time":"夜"}}')).toBe('海风拂过\n\n第二段')
  })

  it('处理 JSON 转义，并且不会把 scene_notes 等字段投影出来', () => {
    const stream = '{"prose":{"paragraphs":["第一行\\n第二行"]},"scene_notes":{"events":["不应显示"]}}'
    expect(projectStreamingProse(stream)).toBe('第一行\n第二行')
    expect(projectStreamingProse(stream)).not.toContain('scene_notes')
    expect(projectStreamingProse(stream)).not.toContain('不应显示')
  })

  it('模型返回普通文本时保留兼容回退', () => {
    expect(projectStreamingProse('暮色落在窗台。')).toBe('暮色落在窗台。')
    expect(projectStreamingProse('{"assistant_note":"等待正文')).toBe('')
  })
})
