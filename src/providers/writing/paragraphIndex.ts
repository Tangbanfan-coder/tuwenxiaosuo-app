import type { ParagraphSourceType, StoredParagraph } from '../../domain/models'
import { isUsableParagraph, tokenizeForBm25, type RetrievedParagraph } from '../retriever'
import { computeWritingTurnContext, type ComputeWritingTurnContextInput, type ComputedWritingTurnContext } from './writingTurnContext'

/**
 * 常驻段落检索索引，供 Web Worker 内跨轮复用。
 *
 * 设计目标（2026-08-19，方案 B）：
 * - 旧实现每次发送都对全量段落重新 tokenize（Bigram BM25），长篇 5000 段
 *   约 216ms、超长篇 12000 段约 478ms（桌面实测）；挪进 worker 后主线程不再
 *   承担，但 worker 内每轮全量重 tokenize 仍拖慢"发送→开始流式输出"的等待。
 * - 本索引把 token 序列池化（term→id 字符串池 + 每段 Int32Array id 序列），
 *   内存可控（5000 段约 10MB、12000 段约 24MB），并利用
 *   StoredParagraph.fingerprint（文本哈希）可靠检测段落增/改/删，实现增量
 *   tokenize：两次发送之间正文通常只追加几段，旧段落零重算。
 * - search() 的 DF、打分、排序、截取算法与 scoreBigramBm25 逐项一致（同
 *   k1=1.2、b=0.75、稳定排序按原始段落顺序），保证检索行为不漂移。
 *
 * 内存保护：段落数超过 maxEntries（默认 20000，约 40MB id 序列）时整索引
 * 重建并只保留最近 maxEntries 段。极端超长作品下检索范围收敛到近期段落，
 * 属有意的降级策略；普通长篇远达不到该上限。
 */

export interface ParagraphBm25IndexOptions {
  /** 缓存段落上限；超过后重建为最近 maxEntries 段。默认 20000。 */
  maxEntries?: number
}

interface IndexedParagraph {
  paragraphId: string
  projectId: string
  sourceType: ParagraphSourceType
  chapterId: string
  messageId?: string
  index: number
  fingerprint: string
  text: string
  /** 池化后的 token id 序列（含重复），等价于 tokenizeForBm25(text, true) 的输出。 */
  ids: Int32Array
}

const DEFAULT_MAX_ENTRIES = 20_000
const DEFAULT_K1 = 1.2
const DEFAULT_B = 0.75
/** 与 CONTEXT_COMPRESSION_PROFILES.normal.retrievalTopK 保持一致。 */
const DEFAULT_RETRIEVAL_TOP_K = 5

export class ParagraphBm25Index {
  private readonly termToId = new Map<string, number>()
  private readonly entries = new Map<string, IndexedParagraph>()
  /** 段落出现顺序（sourceIndex），即 BM25 相同分数时的稳定排序依据。 */
  private order: string[] = []
  private readonly maxEntries: number
  /** 删除段落累计数；达到阈值时整索引重建以回收池中孤儿 term。 */
  private removedSinceRebuild = 0

  constructor(options: ParagraphBm25IndexOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * 与当前全量段落集合对齐索引：新增段落 tokenize 入缓存，fingerprint 变化
   * 的段落重建，本轮不存在的段落移除；超限或删除累计超阈值时重建。
   *
   * 增量细节（2026-08-19 审查修复）：
   * - 缓存命中且 fingerprint 一致（文本未变）的段落直接复用 token 序列并
   *   刷新元数据，跳过 isUsableParagraph 的指纹哈希重算。该哈希是 O(段落
   *   长度) 的归一化 + FNV-1a 字符串操作，每轮对全量段落重算会抵消增量
   *   收益；DB 写入时 fingerprint 已权威计算并存库，缓存命中即可信。
   * - 段落顺序（sourceIndex，同分排序 tie-break）每轮按本次数组顺序重建，
   *   支持章节重排等顺序变化，避免同分排序用旧顺序。
   * - 删除段落累计达到阈值时整索引重建（termToId 清空重建），回收删除
   *   段落留下的孤儿 term，避免超长作品频繁删改时词表单调增长。
   */
  sync(paragraphs: readonly StoredParagraph[]): void {
    const usable: StoredParagraph[] = []
    const newOrder: string[] = []
    const seen = new Set<string>()
    for (const paragraph of paragraphs) {
      const cached = this.entries.get(paragraph.id)
      if (cached && cached.fingerprint === paragraph.fingerprint) {
        // 文本未变：复用已校验的 token 序列，仅刷新元数据（章节/序号可能变化）
        this.entries.set(paragraph.id, {
          ...cached,
          projectId: paragraph.projectId,
          chapterId: paragraph.chapterId,
          messageId: paragraph.messageId,
          index: paragraph.index,
        })
        seen.add(paragraph.id)
        usable.push(paragraph)
        newOrder.push(paragraph.id)
        continue
      }
      // 新段落或文本变更：完整校验（含指纹哈希）后入缓存
      if (!isUsableParagraph(paragraph)) continue
      if (!this.upsertEntry(paragraph)) continue  // 空 token 段落（如纯标点）不入索引
      seen.add(paragraph.id)
      usable.push(paragraph)
      newOrder.push(paragraph.id)
    }
    if (this.entries.size > 0) {
      for (const id of Array.from(this.entries.keys())) {
        if (!seen.has(id)) this.removeEntry(id)
      }
    }
    this.order = newOrder
    if (this.entries.size > this.maxEntries || this.removedSinceRebuild >= this.removalRebuildThreshold) {
      this.rebuild(usable)
    }
  }

  /**
   * 与 scoreBigramBm25 同算法的检索：返回按分数降序（同分按原始顺序）的
   * topK 完整段落，超过 maxTotalCharacters 的段落整体跳过。
   */
  search(query: string, topK = DEFAULT_RETRIEVAL_TOP_K, maxTotalCharacters = Number.POSITIVE_INFINITY): RetrievedParagraph[] {
    const queryTerms = Array.from(new Set(tokenizeForBm25(query)))
    if (!queryTerms.length || this.order.length === 0) return []
    const queryTermIds: number[] = []
    for (const term of queryTerms) {
      const id = this.termToId.get(term)
      if (id !== undefined) queryTermIds.push(id)
    }
    if (!queryTermIds.length) return []

    const docCount = this.order.length
    const df = new Int32Array(this.termToId.size)
    const lastSeen = new Int32Array(this.termToId.size).fill(-1)
    let totalLength = 0
    for (let d = 0; d < docCount; d++) {
      const entry = this.entries.get(this.order[d])!
      totalLength += entry.ids.length
      for (const termId of entry.ids) {
        if (lastSeen[termId] !== d) {
          lastSeen[termId] = d
          df[termId]++
        }
      }
    }
    const averageDocumentLength = totalLength / docCount

    const queryTermSet = new Set(queryTermIds)
    const scored: Array<{ entry: IndexedParagraph; score: number }> = []
    for (let d = 0; d < docCount; d++) {
      const entry = this.entries.get(this.order[d])!
      const counts = new Map<number, number>()
      for (const termId of entry.ids) {
        if (queryTermSet.has(termId)) counts.set(termId, (counts.get(termId) ?? 0) + 1)
      }
      let score = 0
      for (const termId of queryTermIds) {
        const termFrequency = counts.get(termId) ?? 0
        if (!termFrequency) continue
        const frequency = df[termId]
        const inverseDocumentFrequency = Math.log(1 + (docCount - frequency + 0.5) / (frequency + 0.5))
        const lengthNormalization = DEFAULT_K1 * (1 - DEFAULT_B + DEFAULT_B * (entry.ids.length / averageDocumentLength))
        score += inverseDocumentFrequency * ((termFrequency * (DEFAULT_K1 + 1)) / (termFrequency + lengthNormalization))
      }
      if (score > 0) scored.push({ entry, score })
    }
    // 稳定排序：score 降序，同分保持段落原始顺序（与 scoreBigramBm25 的
    // sourceIndex tie-break 一致）。Array.prototype.sort 稳定性为 ES2019+ 规范要求。
    scored.sort((left, right) => right.score - left.score)

    const k = Math.max(0, Math.floor(topK))
    const maxChars = Number.isFinite(maxTotalCharacters)
      ? Math.max(0, Math.floor(maxTotalCharacters))
      : Number.POSITIVE_INFINITY
    const output: RetrievedParagraph[] = []
    let usedCharacters = 0
    for (const item of scored) {
      if (output.length >= k) break
      const textLength = item.entry.text.length
      if (usedCharacters + textLength > maxChars) continue
      output.push(this.toRetrievedParagraph(item.entry, item.score))
      usedCharacters += textLength
    }
    return output
  }

  reset(): void {
    this.termToId.clear()
    this.entries.clear()
    this.order.length = 0
    this.removedSinceRebuild = 0
  }

  /** 删除累计达到该阈值时整索引重建（回收孤儿 term），按 maxEntries 的 5% 且不低于 100。 */
  private get removalRebuildThreshold(): number {
    return Math.max(100, Math.floor(this.maxEntries * 0.05))
  }

  /** 入缓存成功返回 true；空 token 段落（纯标点等）不入缓存返回 false。 */
  private upsertEntry(paragraph: StoredParagraph): boolean {
    const tokens = tokenizeForBm25(paragraph.text, true)
    if (!tokens.length) return false
    const ids = new Int32Array(tokens.length)
    for (let index = 0; index < tokens.length; index++) {
      let id = this.termToId.get(tokens[index])
      if (id === undefined) {
        id = this.termToId.size
        this.termToId.set(tokens[index], id)
      }
      ids[index] = id
    }
    if (!this.entries.has(paragraph.id)) this.order.push(paragraph.id)
    this.entries.set(paragraph.id, {
      paragraphId: paragraph.id,
      projectId: paragraph.projectId,
      sourceType: paragraph.sourceType,
      chapterId: paragraph.chapterId,
      ...(paragraph.messageId ? { messageId: paragraph.messageId } : {}),
      index: paragraph.index,
      fingerprint: paragraph.fingerprint,
      text: paragraph.text,
      ids,
    })
    return true
  }

  private removeEntry(paragraphId: string): void {
    if (!this.entries.delete(paragraphId)) return
    this.removedSinceRebuild++
  }

  private rebuild(usable: readonly StoredParagraph[]): void {
    this.termToId.clear()
    this.entries.clear()
    this.order.length = 0
    this.removedSinceRebuild = 0
    const keepFrom = Math.max(0, usable.length - this.maxEntries)
    for (let i = keepFrom; i < usable.length; i++) {
      this.upsertEntry(usable[i])
    }
  }

  private toRetrievedParagraph(entry: IndexedParagraph, score: number): RetrievedParagraph {
    return {
      paragraphId: entry.paragraphId,
      projectId: entry.projectId,
      sourceType: entry.sourceType,
      chapterId: entry.chapterId,
      ...(entry.messageId ? { messageId: entry.messageId } : {}),
      paragraphIndex: entry.index,
      fingerprint: entry.fingerprint,
      text: entry.text,
      score,
    }
  }
}

/**
 * Worker 内的完整流程：段落索引增量同步 → BM25 检索 → 上下文构建。
 * 主线程 fallback 用 computeWritingTurnContextWithRetrieval（无缓存）。
 */
export function computeWritingTurnContextWithIndex(
  input: ComputeWritingTurnContextInput,
  index: ParagraphBm25Index,
): ComputedWritingTurnContext {
  const { paragraphs, retrievalQuery, retrievalTopK, ...rest } = input
  if (paragraphs && retrievalQuery) {
    index.sync(paragraphs)
    const retrieved = index.search(retrievalQuery, retrievalTopK ?? DEFAULT_RETRIEVAL_TOP_K)
    return computeWritingTurnContext({ ...rest, retrievedParagraphs: retrieved })
  }
  return computeWritingTurnContext(input)
}
