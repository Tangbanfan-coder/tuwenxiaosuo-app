import { describe, expect, it } from 'vitest'
import { parseWritingResult, projectStreamingProse } from '../writing'
import { writingResponseFormatForIllustrationMode } from '../writing/result'

describe('parseWritingResult turn kinds', () => {
  it('parses a structured prose result with its full metadata', () => {
    const result = parseWritingResult(JSON.stringify({
      assistant_note: '正文完成。',
      chapter_action: 'new',
      prose: { chapter_title: '第一章', paragraphs: ['第一段。', '第二段。'] },
      chapter_summary: '本章提要。',
      scene_notes: { events: ['发生了事件'] },
    }))

    expect(result).toMatchObject({
      kind: 'prose',
      assistantNote: '正文完成。',
      chapterAction: 'new',
      chapterTitle: '第一章',
      paragraphs: ['第一段。', '第二段。'],
      chapterSummary: '本章提要。',
    })
    if (result.kind !== 'prose') throw new Error('expected prose')
    expect(result.sceneNotes?.events).toEqual(['发生了事件'])
  })

  it('treats an explicit response_kind assistant_only as collaboration-only', () => {
    expect(parseWritingResult(JSON.stringify({
      response_kind: 'assistant_only',
      assistant_note: '收到，我们先讨论设定。',
      prose: { paragraphs: [] },
    }))).toEqual({ kind: 'assistant-only', assistantNote: '收到，我们先讨论设定。' })
  })

  it('infers a legacy note-only response as assistant-only', () => {
    expect(parseWritingResult('{"assistant_note":"只是简短回应"}')).toEqual({
      kind: 'assistant-only',
      assistantNote: '只是简短回应',
    })
  })

  it('still reports a parse error for a truly empty response', () => {
    expect(() => parseWritingResult('{}')).toThrow('模型没有返回可解析的写作结果')
    expect(() => parseWritingResult('{"prose":{"paragraphs":[]}}')).toThrow('模型没有返回可解析的写作结果')
    expect(() => parseWritingResult('')).toThrow('模型没有返回可解析的写作结果')
  })

  it('keeps the plain-text compatibility path as prose', () => {
    expect(parseWritingResult('第一段普通文本。\n\n第二段普通文本。')).toMatchObject({
      kind: 'prose',
      paragraphs: ['第一段普通文本。', '第二段普通文本。'],
      chapterAction: 'continue',
    })
  })

  it('keeps correctly escaped ASCII dialogue as one complete paragraph', () => {
    const result = parseWritingResult('{"prose":{"paragraphs":["林舟说：\\\"你来了。\\\""]}}')
    expect(result).toMatchObject({ kind: 'prose', paragraphs: ['林舟说："你来了。"'] })
  })

  it('recovers unescaped ASCII dialogue without exposing the model text in diagnostics', () => {
    const result = parseWritingResult('{"prose":{"paragraphs":["上一段。","林舟说："你来了。""]}')
    expect(result).toMatchObject({ kind: 'prose', paragraphs: ['上一段。', '林舟说："你来了。"'] })
    if (result.kind !== 'prose') throw new Error('expected prose')
    expect(result.assistantNote).toContain('英文引号未按 JSON 规则转义')
    expect(result.assistantNote).not.toContain('林舟')
  })

  it('does not mistake an unescaped dialogue quote before narration for an array separator', () => {
    const result = parseWritingResult('{"prose":{"paragraphs":["林舟说："好",然后推开门。","第二段。"]}}')
    expect(result).toMatchObject({ kind: 'prose', paragraphs: ['林舟说："好",然后推开门。', '第二段。'] })
  })

  it('diagnoses a truncated structured response without exposing its text', () => {
    const result = parseWritingResult('{"prose":{"paragraphs":["完整段落。","未完成')
    if (result.kind !== 'prose') throw new Error('expected prose')
    expect(result.assistantNote).toContain('JSON 结束前被截断')
    expect(result.assistantNote).not.toContain('完整段落')
  })

  it('uses a strict schema without visual_plan when illustrations are disabled', () => {
    const format = writingResponseFormatForIllustrationMode('none', 'json_schema')
    const schema = (format?.json_schema as { schema: { properties: Record<string, unknown> } }).schema
    expect(schema.properties.visual_plan).toBeUndefined()
    expect(schema.properties.scene_notes).toBeDefined()
  })

  it('makes every object in the strict schema closed with all properties required', () => {
    const format = writingResponseFormatForIllustrationMode('auto', 'json_schema')
    const root = (format?.json_schema as { schema: Record<string, unknown> }).schema
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      const schema = node as Record<string, unknown>
      if (schema.type === 'object') {
        const properties = schema.properties as Record<string, unknown>
        expect(schema.additionalProperties).toBe(false)
        expect(schema.required).toEqual(Object.keys(properties))
      }
      Object.values(schema).forEach(visit)
    }
    visit(root)
  })
})

describe('projectStreamingProse', () => {
  it('projects a structured stream into readable paragraphs', () => {
    const projected = projectStreamingProse(JSON.stringify({
      assistant_note: '说明',
      prose: { paragraphs: ['第一段。', '第二段。'] },
    }))
    expect(projected).toContain('第一段。')
    expect(projected).toContain('第二段。')
  })

  it('keeps unescaped ASCII dialogue visible while projecting a provider response', () => {
    expect(projectStreamingProse('{"prose":{"paragraphs":["林舟说："你来了。""]}}')).toBe('林舟说："你来了。"')
  })
})
