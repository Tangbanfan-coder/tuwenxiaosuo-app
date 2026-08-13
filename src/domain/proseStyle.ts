import type { ProseStyleIssue, ProseStyleRuleCategory, ProseStyleSeverity } from './models'

export const PROSE_STYLE_RULE_VERSION = 1

export interface ProseStyleRuleDefinition {
  id: string
  category: ProseStyleRuleCategory
  severity: ProseStyleSeverity
  explanation: string
  rewriteGoal: string
  badExamples: string[]
  goodExamples: string[]
}

interface RuleMatcher extends ProseStyleRuleDefinition {
  detect: (paragraph: string, allParagraphs: readonly string[], paragraphIndex: number) => string[]
}

const sentences = (text: string) => text.split(/(?<=[。！？!?])/).map((item) => item.trim()).filter(Boolean)
const matches = (text: string, pattern: RegExp) => Array.from(text.matchAll(pattern), (match) => match[0])

const rules: RuleMatcher[] = [
  {
    id: 'template-calm-as-everyday', category: 'template-simile', severity: 'warning',
    explanation: '用固定的日常谈话类比来说明平静，容易形成可识别的模板句。',
    rewriteGoal: '改用当下可观察的语速、动作或现场反应呈现平静。',
    badExamples: ['他说得很平静，像是在讨论今天吃什么。'], goodExamples: ['他说完，把杯盖重新旋紧。'],
    detect: (text) => matches(text, /(平静|淡然|随意|轻松)(?:得|地)?[^。！？]{0,18}?(?:像|仿佛|好像)(?:只是在|只是在|只?是|在)?(?:讨论|谈论|说起)[^。！？]{0,12}(?:吃什么|天气|家常|小事)/g),
  },
  {
    id: 'contrast-not-but-density', category: 'contrast', severity: 'hint',
    explanation: '“不是……而是……”在短段落内反复出现，会显得刻意抬高和解释。',
    rewriteGoal: '保留真正需要纠正的对比，其余直接陈述具体事实。',
    badExamples: ['那不是愤怒，而是一种更深的失望。'], goodExamples: ['他把信折好，推回桌子中央。'],
    detect: (text) => {
      const found = matches(text, /不是[^。！？；]{1,30}?(?:而是|是)/g)
      // A single factual correction or dialogue is ordinary Chinese, not a defect.
      return found.length >= 2 ? found : []
    },
  },
  {
    id: 'generic-animal-simile', category: 'animal-simile', severity: 'hint',
    explanation: '用猫、鹿、兽等通用动物套人物动作，往往没有提供场景独有的信息。',
    rewriteGoal: '删除通用动物标签，写清人物实际姿势、路线和反应。',
    badExamples: ['她像一只警觉的猫那样退开。'], goodExamples: ['她后退半步，鞋跟抵住门槛。'],
    detect: (text) => matches(text, /(?:像|仿佛|好像)(?:一只|一头)?(?:受惊的|警觉的|慵懒的|困倦的)?(?:猫|鹿|兽|狐狸|兔子|狼)(?:一样|那样)?/g),
  },
  {
    id: 'abstract-emotion-telling', category: 'emotion-telling', severity: 'hint',
    explanation: '抽象命名复杂情绪替代了人物在当前场景中的具体反应。',
    rewriteGoal: '用有因果关系的动作、选择、对白或身体感觉承载情绪。',
    badExamples: ['一种复杂的情绪涌上心头。'], goodExamples: ['她删掉已经输入的名字，屏幕重新空了。'],
    detect: (text) => matches(text, /(?:一种|某种)(?:难以言喻的|复杂的|莫名的|说不清的)?(?:情绪|感觉|滋味)[^。！？]{0,10}(?:涌上|漫上|浮上|掠过)(?:心头|心间|心底)?/g),
  },
  {
    id: 'stock-physical-reaction', category: 'stock-reaction', severity: 'warning',
    explanation: '同一段堆叠多种常见身体反应，会让人物反应像预设套餐。',
    rewriteGoal: '只保留最能改变现场关系的一项反应，并补足其具体后果。',
    badExamples: ['她呼吸一滞，眸光一闪，指节泛白。'], goodExamples: ['她没接那只杯子。'],
    detect: (text) => {
      const found = matches(text, /(?:呼吸一滞|眸光一闪|瞳孔一缩|嘴角(?:微微)?(?:勾起|上扬)|指节泛白|喉结滚动|心头一颤|身体一僵)/g)
      return found.length >= 2 ? found : []
    },
  },
  {
    id: 'dialogue-explained-afterward', category: 'dialogue-explanation', severity: 'hint',
    explanation: '对白已经表达态度，紧随其后的解释又替读者复述了一遍。',
    rewriteGoal: '保留对白和能改变场面的动作，删除同义态度说明。',
    badExamples: ['“不用了。”他说，语气里带着不容拒绝的坚定。'], goodExamples: ['“不用了。”他把名单扣在桌上。'],
    detect: (text) => matches(text, /[”」』][^。！？]{0,12}(?:语气|声音|话里|这句话)[^。！？]{0,20}(?:透着|带着|充满|说明|意味着|显得)/g),
  },
  {
    id: 'adjacent-sentence-repetition', category: 'repetition', severity: 'hint',
    explanation: '相邻句共享过多内容词，后句可能只是在换词解释前句。',
    rewriteGoal: '合并重复信息，让后一句推进动作、关系或新事实。',
    badExamples: ['他没有回答。沉默就是他的回答。'], goodExamples: ['他没有回答，转身关了灯。'],
    detect: (text) => {
      const parts = sentences(text)
      for (let index = 1; index < parts.length; index++) {
        const left = new Set(Array.from(parts[index - 1].replace(/[，。！？“”]/g, '')).filter((char) => !/[的是了在和就也]/.test(char)))
        const right = Array.from(parts[index].replace(/[，。！？“”]/g, '')).filter((char) => !/[的是了在和就也]/.test(char))
        if (right.length >= 6 && right.filter((char) => left.has(char)).length / right.length >= 0.65) return [`${parts[index - 1]}${parts[index]}`]
      }
      return []
    },
  },
  {
    id: 'mechanical-three-part-list', category: 'mechanical-list', severity: 'hint',
    explanation: '连续三项同构短语容易形成机械排比，尤其在普通叙述中。',
    rewriteGoal: '保留有递进关系的要点，打破完全对称的句法。',
    badExamples: ['不是退缩，不是犹豫，不是恐惧。'], goodExamples: ['他停下，不再往门口看。'],
    detect: (text) => matches(text, /(?:不是|没有|不再|既不)[^，。！？]{1,12}，(?:不是|没有|不再|也不)[^，。！？]{1,12}，(?:不是|没有|不再|更不)[^。！？]{1,12}/g),
  },
  {
    id: 'generic-elevated-ending', category: 'elevated-ending', severity: 'warning',
    explanation: '段尾用抽象人生或命运结论收束，可能越过了当前场景实际发生的事。',
    rewriteGoal: '以当前动作、物件、未解决的问题或关系变化收束。',
    badExamples: ['这一刻，他终于明白了人生真正的意义。'], goodExamples: ['门外的脚步停了，钥匙却没有转动。'],
    detect: (text, all, index) => index === all.length - 1
      ? matches(text, /(?:终于明白|这才明白|仿佛预示着|命运的齿轮|人生的意义|一切才刚刚开始|新的篇章)[^。！？]{0,18}[。！？]?$/g)
      : [],
  },
]

export const PROSE_STYLE_RULES: readonly ProseStyleRuleDefinition[] = rules.map(({ detect: _detect, ...rule }) => rule)

export function detectProseStyleIssues(paragraphs: readonly string[]): ProseStyleIssue[][] {
  return paragraphs.map((paragraph, paragraphIndex) => rules.flatMap((rule) => {
    const detected = rule.detect(paragraph, paragraphs, paragraphIndex)
    if (!detected.length) return []
    return [{
      ruleId: rule.id,
      category: rule.category,
      severity: rule.severity,
      explanation: rule.explanation,
      rewriteGoal: rule.rewriteGoal,
      matchedText: detected.slice(0, 3).join('；'),
    }]
  }))
}
