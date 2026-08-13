import { describe, expect, it } from 'vitest'
import { detectProseStyleIssues, PROSE_STYLE_RULES } from './proseStyle'

describe('detectProseStyleIssues', () => {
  it('uses stable rule ids for representative novel style patterns', () => {
    const paragraphs = [
      '他说得非常平静，好像只是在讨论今天吃什么。',
      '她像一只警觉的猫一样退开，一种复杂的情绪涌上心头。',
      '“不用了。”他说，语气里带着不容拒绝的坚定。',
      '这一刻，他终于明白了人生真正的意义。',
    ]
    expect(detectProseStyleIssues(paragraphs).map((issues) => issues.map((issue) => issue.ruleId))).toEqual([
      ['template-calm-as-everyday'],
      ['generic-animal-simile', 'abstract-emotion-telling'],
      ['dialogue-explained-afterward'],
      ['generic-elevated-ending'],
    ])
    expect(new Set(PROSE_STYLE_RULES.map((rule) => rule.id)).size).toBe(PROSE_STYLE_RULES.length)
  })

  it('applies density thresholds and explicit ordinary-language exceptions', () => {
    expect(detectProseStyleIssues(['这不是钥匙，而是一枚旧徽章。'])[0]).toEqual([])
    expect(detectProseStyleIssues(['“不是我。”她说，“是门外的人。”'])[0]).toEqual([])
    expect(detectProseStyleIssues(['那不是迟疑，而是恐惧；不是退缩，而是等待。'])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(detectProseStyleIssues(['她呼吸一滞，随即关上窗。'])[0]).toEqual([])
    expect(detectProseStyleIssues(['她呼吸一滞，眸光一闪，指节泛白。'])[0].map((issue) => issue.ruleId)).toContain('stock-physical-reaction')
  })

  it('does not flag concrete prose without the targeted patterns', () => {
    const result = detectProseStyleIssues(['她把钥匙压进掌心，等脚步越过楼梯口才开门。', '门缝里没有光。'])
    expect(result).toEqual([[], []])
  })
})
