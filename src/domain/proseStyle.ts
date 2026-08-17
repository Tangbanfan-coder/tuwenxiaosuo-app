import type { ProseStyleIssue, ProseStyleRuleCategory, ProseStyleSeverity } from './models'

export const PROSE_STYLE_RULE_VERSION = 3

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
    explanation: '对白中的“不是……而是……”容易显得替人物解释；叙述中不必要的抽象转折也会显得刻意。',
    rewriteGoal: '对白优先改为自然直接的话；叙述保留真正的事实纠正，其余写具体动作或事实。',
    badExamples: ['那不是愤怒，而是一种更深的失望。'], goodExamples: ['他把信折好，推回桌子中央。'],
    detect: (text, allParagraphs) => {
      const found = matches(text, /不是[^。！？；]{1,30}?(?:，?而是|，?是)/g)
      const dialogue = /[“「『][^”」』]*(?:不是[^。！？；]{1,30}?(?:，?而是|，?是))[^”」』]*[”」』]/.test(text)
      if (dialogue) return found
      const abstract = /不是(?:单纯的?|真正的?|所谓的?)?(?:愤怒|悲伤|恐惧|爱|恨|失败|胜利|沉默|笑意?|拒绝|退让|妥协|试探|警告|回答|答案|选择|情绪|感觉)[^。！？；]{0,24}(?:而是|是)(?:一种|某种|更|近乎|彻底|无声的?|真正的?|拒绝|警告|宣判|试探|答案|选择)/.test(text)
      const chapterDensity = allParagraphs.reduce((count, paragraph) => count + matches(paragraph, /不是[^。！？；]{1,30}?(?:，?而是|，?是)/g).length, 0)
      return found.length >= 2 || abstract || chapterDensity >= 3 ? found : []
    },
  },
  {
    id: 'generic-animal-simile', category: 'animal-simile', severity: 'hint',
    explanation: '用猫、鹿、兽等通用动物套人物动作，往往没有提供场景独有的信息。',
    rewriteGoal: '删除通用动物标签，写清人物实际姿势、路线和反应。',
    badExamples: ['她像一只警觉的猫那样退开。'], goodExamples: ['她后退半步，鞋跟抵住门槛。'],
    detect: (text) => matches(text, /(?:像|仿佛|好像)(?:一只|一头)?(?:[^，。！？；\s]{0,8}的)?(?:小)?(?:猫|鹿|兽|狐狸|兔子|狼)(?:一样|那样|般)?/g)
      .filter((value) => !/(?:门口|院里|笼子里|树下|看见|有)(?:[^，。！？；]{0,8})?(?:好像|像|仿佛)/.test(text)),
  },
  {
    id: 'conditional-dialogue-ultimatum', category: 'conditional-dialogue', severity: 'hint',
    explanation: '“如果……以后就不……”式台词容易像预制誓言，缺少人物当下的具体意图。',
    rewriteGoal: '让人物直接说出这次会做什么，或用动作和后果表现决心。',
    badExamples: ['“如果你再骗我，以后我就不见你了。”'], goodExamples: ['“再骗我一次，我就把钥匙还给你。”'],
    detect: (text) => matches(text, /[“「『][^”」』]{0,45}(?:如果|要是)(?:再)?[^，。！？]{1,28}[，,][^”」』]{0,20}(?:以后|今后|再也)[^”」』]{0,20}(?:不|别)[^”」』]{0,20}[”」』]/g),
  },
  {
    id: 'concept-label-this-is-called', category: 'concept-label', severity: 'hint',
    explanation: '“这叫…… / 这就叫…… / 这才叫……”把当下动作贴成抽象概念，常像替人物下定义。',
    rewriteGoal: '让人物直接说出理由、关系或下一步动作，保留确有必要的命名与提问。',
    badExamples: ['“这叫审美共享。”她摊开手。'], goodExamples: ['“你喜欢，我也觉得顺眼。”她把袋子往前推。'],
    detect: (text) => Array.from(text.matchAll(/这(?:就|才)?叫([^，。！？；”」』]{1,14})/g), (match) => {
      const label = match[1].trim()
      if (!label || /^(?:什么|我(?:怎么|如何|[^，。！？；]{0,8}(?:办|做)))/.test(label)) return undefined
      // A short Chinese personal name after “这叫” is a naming statement, not a rhetorical label.
      if (/^(?:王|李|张|刘|陈|杨|黄|赵|周|吴|徐|孙|胡|朱|高|林|何|郭|马|罗|梁|宋|郑|谢|韩|唐|冯|于|董|萧|程|曹|袁|邓|许|傅|沈|曾|彭|吕|苏|卢|蒋|蔡|贾|丁|魏|薛|叶|阎|余|潘|杜|戴|夏|钟|汪|田|任|姜|范|方|石|姚|谭|廖|邹|熊|金|陆|郝|孔|白|崔|康|毛|邱|秦|江|史|顾|侯|邵|孟|龙|万|段|雷|钱|汤|尹|易|常|武|乔|贺|赖|龚|文)[\u4e00-\u9fff]{1,2}$/.test(label)) return undefined
      return match[0]
    }).filter((value): value is string => Boolean(value)),
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
