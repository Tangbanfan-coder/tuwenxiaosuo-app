import { describe, expect, it } from 'vitest'
import { systemPromptForIllustrationMode } from './prompt'

describe('systemPromptForIllustrationMode', () => {
  it('removes the visual response schema in text-only mode', () => {
    const prompt = systemPromptForIllustrationMode('none')

    expect(prompt).not.toContain('"visual_plan": {')
    expect(prompt).not.toContain('"style_prompt"')
    expect(prompt).toContain('不要输出 visual_plan 字段或任何视觉指令。')
    expect(prompt).toContain('"scene_notes"')
  })

  it.each(['manual', 'auto'] as const)('keeps visual planning available for %s mode', (mode) => {
    expect(systemPromptForIllustrationMode(mode)).toContain('"visual_plan": {')
  })
})
