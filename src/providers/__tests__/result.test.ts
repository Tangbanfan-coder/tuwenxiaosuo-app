import { describe, expect, it } from 'vitest'
import { parseWritingResult, projectStreamingProse } from '../writing'

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
})
