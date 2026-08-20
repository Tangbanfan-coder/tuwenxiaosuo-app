import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { ProjectWorkspace, StoredParagraph } from '../../domain/models'
import { createParagraphFingerprint } from '../../domain/paragraphs'
import { retrieveParagraphsSync, type RetrievedParagraph } from '../retriever'
import type { ProviderConfig } from '../types'
import { ParagraphBm25Index, computeWritingTurnContextWithIndex } from '../writing/paragraphIndex'
import { computeWritingTurnContext, computeWritingTurnContextWithRetrieval } from '../writing/writingTurnContext'

function paragraph(id: string, text: string, index = 0): StoredParagraph {
  return {
    id,
    projectId: 'project-1',
    sourceType: 'chapter',
    chapterId: 'chapter-1',
    index,
    text,
    fingerprint: createParagraphFingerprint(text),
    createdAt: 1,
  }
}

/** 构造一批风格各异的段落：含重复词、稀有词、英文数字、标点段落。 */
function corpus(): StoredParagraph[] {
  return [
    paragraph('p-common', '夜色渐深，街灯在湿漉漉的石板路上拉出细长的影子，他站在巷口，望着那扇半掩的木门，心里说不清是期待还是忐忑。'),
    paragraph('p-notebook', '她翻开泛黄的笔记本，字迹被岁月晕开，只剩下几行模糊的墨痕，却仍能辨认出那个熟悉的名字和落款的日期。'),
    paragraph('p-candle', '风从窗口灌进来，吹得桌上的烛火摇摇晃晃，他把外套搭在她肩上，轻声说了一句连自己都没听清的话。', 2),
    paragraph('p-rain', '远处的钟声敲了十一下，雨势更大了，屋檐下积起的水洼倒映着零星的灯火，像碎了一地的星子。', 3),
    paragraph('p-river', '他们沿着河岸慢慢走着，谁都没有先开口，只有河水在夜色里低声流淌，仿佛在替他们说完那些没说出口的话。', 4),
    paragraph('p-key', '那把银色钥匙的编号是 Version42，他一直贴身收着，谁也不知道它开启的是哪一扇门。', 5),
    paragraph('p-empty', '，。！？……', 6),
    paragraph('p-irrelevant', '天气预报说今天晴转多云，气温适宜，适合晾晒被褥和出门采购。', 7),
  ]
}

function freshIndex(paragraphs: readonly StoredParagraph[], maxEntries?: number) {
  const index = new ParagraphBm25Index({ maxEntries })
  index.sync(paragraphs)
  return index
}

/** 断言索引（可能经历增量操作）与全量基线完全等价。 */
function expectIndexMatchesFull(
  index: ParagraphBm25Index,
  finalParagraphs: readonly StoredParagraph[],
  query: string,
  topK?: number,
  maxChars?: number,
) {
  const expected = retrieveParagraphsSync({ query, paragraphs: finalParagraphs, topK, maxTotalCharacters: maxChars })
  expect(index.search(query, topK, maxChars)).toEqual(expected)
}

describe('ParagraphBm25Index', () => {
  it('全量 sync 后检索结果与 Bigram BM25 基线完全一致（分数/顺序/截取）', () => {
    const paragraphs = corpus()
    const index = freshIndex(paragraphs)
    expectIndexMatchesFull(index, paragraphs, '寻找银色钥匙 version42')
    expectIndexMatchesFull(index, paragraphs, '夜色 木门 巷口')
    expectIndexMatchesFull(index, paragraphs, '笔记本 日期')
    expectIndexMatchesFull(index, paragraphs, '不存在的词')
    // topK 与字符上限截取
    expectIndexMatchesFull(index, paragraphs, '夜色 笔记本 烛火', 2)
    expectIndexMatchesFull(index, paragraphs, '夜色 笔记本 烛火', 5, 20)
  })

  it('增量追加：第二轮只新增段落，旧段落零重算且状态等价于全量重建', () => {
    const initial = corpus()
    const index = freshIndex(initial)
    const before = index.search('笔记本 日期')
    const added = paragraph('p-new', '他后来在抽屉最深处找到了那本笔记本，封皮上落满灰尘，却还夹着一片干枯的枫叶。', 8)
    index.sync([...initial, added])

    // 旧结果不变（DF 变化只会让分数变化，但顺序与命中集合由全量基线决定）
    expectIndexMatchesFull(index, [...initial, added], '笔记本 日期')
    expectIndexMatchesFull(index, [...initial, added], '抽屉 枫叶')
    expect(before.length).toBeGreaterThan(0)
    expect(index.search('抽屉 枫叶').some((item) => item.paragraphId === 'p-new')).toBe(true)
  })

  it('增量修改：fingerprint 变化时重建该段，状态等价于全量重建', () => {
    const initial = corpus()
    const index = freshIndex(initial)
    const modified = paragraph('p-key', '那把银色钥匙被他在雨夜丢进了河里，连同那段无人知晓的秘密。', 5)
    const finalParagraphs = initial.map((item) => item.id === 'p-key' ? modified : item)
    index.sync(finalParagraphs)

    expectIndexMatchesFull(index, finalParagraphs, '银色钥匙')
    expect(index.search('银色钥匙').some((item) => item.paragraphId === 'p-key')).toBe(true)
    expect(index.search('version42').some((item) => item.paragraphId === 'p-key')).toBe(false)
  })

  it('增量删除：移除段落，状态等价于全量重建', () => {
    const initial = corpus()
    const index = freshIndex(initial)
    const finalParagraphs = initial.filter((item) => item.id !== 'p-river')
    index.sync(finalParagraphs)

    expect(index.search('河岸 河水').some((item) => item.paragraphId === 'p-river')).toBe(false)
    expectIndexMatchesFull(index, finalParagraphs, '河岸 河水')
    expectIndexMatchesFull(index, finalParagraphs, '夜色 木门')
  })

  it('混合操作序列（追加+修改+删除）后状态等价于全量重建', () => {
    const initial = corpus()
    const index = freshIndex(initial)
    const modified = paragraph('p-candle', '烛火被风吹灭，屋里一下子暗了下来，只剩下窗外细碎的雨声。', 2)
    const added = paragraph('p-late', '天亮时她终于合上笔记本，在最后一页写下：雨停了。', 8)
    const finalParagraphs = [
      ...initial.map((item) => item.id === 'p-candle' ? modified : item).filter((item) => item.id !== 'p-key'),
      added,
    ]
    index.sync(finalParagraphs)

    expect(index.search('烛火 雨声').some((item) => item.paragraphId === 'p-candle')).toBe(true)
    expect(index.search('银色钥匙').length).toBe(0)
    expect(index.search('笔记本 雨').some((item) => item.paragraphId === 'p-late')).toBe(true)
    expectIndexMatchesFull(index, finalParagraphs, '烛火 雨声')
    expectIndexMatchesFull(index, finalParagraphs, '笔记本 雨')
  })

  it('段落顺序保持不变：同分时按原始顺序稳定排序', () => {
    const paragraphs = [
      paragraph('first', '木门 木门 木门'),
      paragraph('second', '木门 巷口'),
      paragraph('third', '木门 巷口 石板'),
    ]
    const index = freshIndex(paragraphs)
    const expected = retrieveParagraphsSync({ query: '木门 巷口', paragraphs })
    const actual = index.search('木门 巷口')
    expect(actual.map((item) => item.paragraphId)).toEqual(expected.map((item) => item.paragraphId))
    // 相同得分必须保持段落原始顺序（sourceIndex 升序）
    const scores = actual.map((item) => item.score)
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] === scores[i - 1]) {
        expect(actual[i].paragraphIndex).toBeGreaterThan(actual[i - 1].paragraphIndex)
      }
    }
  })

  it('段落顺序变化后同分排序跟随新顺序（每轮重建 order，缓存命中只刷新元数据）', () => {
    // 两段文本完全相同（得分必然相同），顺序交换后同分 tie-break 必须跟随新数组顺序
    const a = paragraph('a', '木门 巷口')
    const b = paragraph('b', '木门 巷口')
    const index = freshIndex([a, b])
    expect(index.search('木门 巷口').map((item) => item.paragraphId)).toEqual(['a', 'b'])
    index.sync([b, a])
    expect(index.search('木门 巷口').map((item) => item.paragraphId)).toEqual(['b', 'a'])
    expect(index.search('木门 巷口')).toEqual(retrieveParagraphsSync({ query: '木门 巷口', paragraphs: [b, a] }))
  })

  it('删除累计超阈值触发整索引重建（回收孤儿 term），检索仍与全量基线一致', () => {
    const many = Array.from({ length: 120 }, (_, i) => paragraph(`p-${i}`, `第${i}段，夜色里有一扇木门和一本笔记本。`))
    const index = new ParagraphBm25Index({ maxEntries: 1000 })  // 重建阈值 = max(100, 50) = 100
    index.sync(many)
    // 删除 105 段（≥ 阈值 100），应触发瘦身重建
    const remaining = many.filter((_, i) => i % 8 === 0)
    expect(remaining.length).toBe(15)
    index.sync(remaining)
    const query = '木门 笔记本'
    expect(index.search(query)).toEqual(retrieveParagraphsSync({ query, paragraphs: remaining }))
    expect(index.search(query)).toEqual(freshIndex(remaining).search(query))
    // 重建后仍可继续增量使用
    const added = paragraph('p-last', '最后一段，木门后面是笔记本。', 200)
    index.sync([...remaining, added])
    expect(index.search('木门 笔记本').some((item) => item.paragraphId === 'p-last')).toBe(true)
    expect(index.search('木门 笔记本')).toEqual(retrieveParagraphsSync({ query: '木门 笔记本', paragraphs: [...remaining, added] }))
  })

  it('超限保护：超过 maxEntries 时重建为最近段落，行为与同上限全量索引一致', () => {
    const many = Array.from({ length: 25 }, (_, i) => paragraph(`p-${i}`, `第${i}段，夜色里有一扇木门和一本笔记本。`))
    const index = new ParagraphBm25Index({ maxEntries: 10 })
    index.sync(many)
    expect(index.size).toBe(10)
    // 与"只保留最近 10 段"的全量索引一致
    const lastTen = many.slice(-10)
    const reference = freshIndex(lastTen, 10)
    expect(index.search('木门 笔记本')).toEqual(reference.search('木门 笔记本'))
    // 早期段落不再被检索
    expect(index.search('木门 笔记本').some((item) => item.paragraphId === 'p-0')).toBe(false)
  })

  it('不可用段落（fingerprint 不匹配）不进索引', () => {
    const bad = {
      ...paragraph('p-bad', '正文内容。'),
      fingerprint: 'wrong-fingerprint',
    }
    const index = freshIndex([bad])
    expect(index.size).toBe(0)
    expect(index.search('正文')).toEqual([])
  })

  it('trustFingerprint 模式跳过哈希重算：结构合法但指纹过期的段落被接受（DB 可信来源）', () => {
    const stale = {
      ...paragraph('p-stale', '正文内容。'),
      fingerprint: 'stale-fingerprint',
    }
    // 默认严格校验：指纹与文本哈希不一致 → 拒绝
    expect(retrieveParagraphsSync({ query: '正文', paragraphs: [stale] })).toEqual([])
    // 信任模式（worker/fallback 检索路径）：指纹以存库为准，不重算哈希 → 接受
    const trusted = retrieveParagraphsSync({ query: '正文', paragraphs: [stale] }, undefined, undefined, { trustFingerprint: true })
    expect(trusted.map((item) => item.paragraphId)).toEqual(['p-stale'])
  })

  it('reset 清空全部状态', () => {
    const index = freshIndex(corpus())
    expect(index.size).toBeGreaterThan(0)
    index.reset()
    expect(index.size).toBe(0)
    expect(index.search('夜色')).toEqual([])
  })
})

describe('检索路径组装', () => {
  const textProvider: ProviderConfig = {
    id: 'test',
    name: 'Test',
    baseUrl: 'https://example/v1',
    model: 'deepseek-chat',
    protocol: 'openai-compatible',
    secretRef: 'provider:text',
  }

  const emptyWorkspace = (): ProjectWorkspace => ({
    project: {
      id: 'project-1',
      title: '测试作品',
      themeId: 'neutral' as const,
      autoIllustrate: false,
      createdAt: 0,
      updatedAt: 0,
      lastOpenedAt: 0,
    },
    messages: [],
    chapters: [],
    characters: [],
    illustrations: [],
    style: undefined,
  })

  const baseInput = {
    workspace: emptyWorkspace(),
    scenes: [],
    preferenceSignals: [],
    styleCorpusFragments: [],
    config: textProvider,
    userRequest: '继续写',
  }

  it('fallback（computeWritingTurnContextWithRetrieval）与 worker 路径（computeWritingTurnContextWithIndex）结果一致', () => {
    const paragraphs = corpus()
    const retrievalQuery = '寻找银色钥匙 version42'
    const fromFallback = computeWritingTurnContextWithRetrieval({
      ...baseInput,
      paragraphs,
      retrievalQuery,
    })
    const index = new ParagraphBm25Index()
    const fromWorker = computeWritingTurnContextWithIndex({
      ...baseInput,
      paragraphs,
      retrievalQuery,
    }, index)
    expect(fromWorker).toEqual(fromFallback)
    // 检索结果确实进入上下文（银色钥匙段落被带上）
    expect(fromFallback.contextMessage).toContain('银色钥匙')
  })

  it('自定义检索注入路径（预置 retrievedParagraphs）直接透传 computeWritingTurnContext', () => {
    const injected: RetrievedParagraph[] = [{
      paragraphId: 'injected-1',
      projectId: 'project-1',
      sourceType: 'chapter',
      chapterId: 'chapter-1',
      paragraphIndex: 0,
      fingerprint: createParagraphFingerprint('自定义检索返回的原文。'),
      text: '自定义检索返回的原文。',
      score: 1,
    }]
    const direct = computeWritingTurnContext({ ...baseInput, retrievedParagraphs: injected })
    const viaFallback = computeWritingTurnContextWithRetrieval({ ...baseInput, retrievedParagraphs: injected })
    const viaWorker = computeWritingTurnContextWithIndex({ ...baseInput, retrievedParagraphs: injected }, new ParagraphBm25Index())
    expect(viaFallback).toEqual(direct)
    expect(viaWorker).toEqual(direct)
    expect(direct.contextMessage).toContain('自定义检索返回的原文。')
  })

  it('连续两次走索引：第二次增量，结果与全量基线一致（回归：索引跨轮状态）', () => {
    const initial = corpus()
    const index = new ParagraphBm25Index()
    const first = computeWritingTurnContextWithIndex({ ...baseInput, paragraphs: initial, retrievalQuery: '夜色 木门' }, index)
    const added = paragraph('p-extra', '他在木门背后发现了一串钥匙和一张旧地图。', 8)
    const second = computeWritingTurnContextWithIndex({ ...baseInput, paragraphs: [...initial, added], retrievalQuery: '钥匙 地图' }, index)
    const reference = computeWritingTurnContextWithRetrieval({ ...baseInput, paragraphs: [...initial, added], retrievalQuery: '钥匙 地图' })
    expect(second).toEqual(reference)
    expect(second.contextMessage).toContain('钥匙')
    expect(first.contextMessage).toBeDefined()
  })
})
