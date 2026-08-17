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

  it('covers free-form animal similes and dialogue-only template warnings', () => {
    expect(detectProseStyleIssues(['她好像一只偷腥成功的猫，悄悄把糖纸塞进口袋。'])[0].map((issue) => issue.ruleId)).toContain('generic-animal-simile')
    expect(detectProseStyleIssues(['他像只偷腥的狐狸，笑着避开她的眼睛。'])[0].map((issue) => issue.ruleId)).toContain('generic-animal-simile')
    expect(detectProseStyleIssues(['她像一只小鹿般缩到窗边。'])[0].map((issue) => issue.ruleId)).toContain('generic-animal-simile')
    expect(detectProseStyleIssues(['门口好像有一只猫，正在啃鱼骨。'])[0]).toEqual([])
    expect(detectProseStyleIssues(['“不是我，而是他拿走了信。”她说。'])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(detectProseStyleIssues(['这不是钥匙，而是一枚旧徽章。'])[0]).toEqual([])
    expect(detectProseStyleIssues(['那不是笑意，而是一种无声的警告。'])[0].map((issue) => issue.ruleId)).toContain('contrast-not-but-density')
    expect(detectProseStyleIssues(['那不是门响，而是风吹动了插销。'])[0]).toEqual([])
    expect(detectProseStyleIssues(['这不是迟疑，而是等待。', '那不是拒绝，而是试探。', '门后的声音不是哭声，而是水管在响。']).every((issues) => issues.some((issue) => issue.ruleId === 'contrast-not-but-density'))).toBe(true)
    expect(detectProseStyleIssues(['“如果你再骗我，以后我就不见你了。”'])[0].map((issue) => issue.ruleId)).toContain('conditional-dialogue-ultimatum')
  })

  it('flags rhetorical “this is called” labels without rewriting or mistaking ordinary language for one', () => {
    const flagged = detectProseStyleIssues(['“这叫审美共享。”林晚理直气壮地摊开手。', '这就叫懂得分寸。', '这才叫真正的默契。'])
    expect(flagged.every((issues) => issues.some((issue) => issue.ruleId === 'concept-label-this-is-called'))).toBe(true)
    expect(detectProseStyleIssues(['这叫什么名字？', '这叫我怎么办。', '这里叫青石巷。', '这叫林晚。']).every((issues) => issues.length === 0)).toBe(true)
  })
})
