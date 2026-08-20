import type { ParagraphSourceType, StoredParagraph } from '../domain/models'
import { createParagraphFingerprint, normalizeText } from '../domain/paragraphs'

/**
 * Stable, source-addressable paragraph shape consumed by writing-context
 * construction. Future semantic retrievers must return this same structure.
 */
export interface RetrievedParagraph {
  paragraphId: string
  projectId: string
  sourceType: ParagraphSourceType
  chapterId: string
  messageId?: string
  paragraphIndex: number
  fingerprint: string
  text: string
  score: number
}

export interface RetrievalRequest {
  query: string
  paragraphs: readonly StoredParagraph[]
  /** Maximum number of complete paragraphs to return. Defaults to 5. */
  topK?: number
  /**
   * Maximum total source-text characters. Oversized paragraphs are skipped so
   * every returned result keeps its original fingerprint and precise text.
   */
  maxTotalCharacters?: number
}

/**
 * Retrieval seam for future semantic/vector implementations. The writing
 * provider only depends on `RetrievedParagraph`, never on a scoring method.
 */
export interface Retriever {
  retrieve(request: RetrievalRequest): Promise<RetrievedParagraph[]>
}

const TOKEN_RUN = /[\p{Script=Han}]+|[A-Za-z0-9]+/gu
const HAN_RUN = /^\p{Script=Han}+$/u

/**
 * Chinese is represented as overlapping character bigrams; ASCII letters and
 * numbers remain whole words. Prefixes prevent accidental collisions between
 * a Chinese bigram and an English/number token with the same characters.
 */
export function tokenizeForBm25(text: string, includeHanUnigrams = false) {
  const tokens: string[] = []
  const normalized = normalizeText(text).toLowerCase()
  for (const match of normalized.matchAll(TOKEN_RUN)) {
    const value = match[0]
    if (HAN_RUN.test(value)) {
      for (let index = 0; index < value.length - 1; index++) {
        tokens.push(`zh:${value.slice(index, index + 2)}`)
      }
      // A one-character query has no bigram. Documents additionally carry
      // these fallback terms; multi-character queries continue to use only
      // bigrams, so the normal Chinese ranking path stays BM25 bigram-based.
      if (value.length === 1 || includeHanUnigrams) {
        for (const character of value) tokens.push(`zh1:${character}`)
      }
    } else {
      tokens.push(`word:${value}`)
    }
  }
  return tokens
}

function hasUsableParagraphShape(paragraph: StoredParagraph): boolean {
  return Boolean(
    paragraph
    && (paragraph.sourceType === 'chapter' || paragraph.sourceType === 'message')
    && typeof paragraph.id === 'string'
    && paragraph.id.length > 0
    && typeof paragraph.projectId === 'string'
    && paragraph.projectId.length > 0
    && typeof paragraph.chapterId === 'string'
    && paragraph.chapterId.length > 0
    && Number.isInteger(paragraph.index)
    && paragraph.index >= 0
    && typeof paragraph.text === 'string'
    && paragraph.text.trim().length > 0
    && typeof paragraph.fingerprint === 'string'
    && paragraph.fingerprint.length > 0,
  )
}

/** 严格校验：结构 + fingerprint 与文本哈希一致。用于不可信输入（外部注入的 Retriever、测试构造段落）。 */
export function isUsableParagraph(paragraph: StoredParagraph): boolean {
  return hasUsableParagraphShape(paragraph) && paragraph.fingerprint === createParagraphFingerprint(paragraph.text)
}

/**
 * 结构可用性校验（不重算指纹哈希）：用于段落来自本地 DB 的检索路径（写入
 * 时 fingerprint 已权威计算并存库），避免每轮对全量段落做 O(文本长度) 的
 * 归一化 + FNV-1a 重算——12000 段作品的哈希开销可观，会抵消增量收益。
 * 保留 fingerprint 非空作为数据完整性底线。
 */
export function isUsableParagraphTrusted(paragraph: StoredParagraph): boolean {
  return hasUsableParagraphShape(paragraph)
}

function termCounts(tokens: readonly string[]) {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

export interface Bm25Document<T> {
  value: T
  text: string
  sourceIndex: number
}

export interface Bm25ScoredDocument<T> extends Bm25Document<T> {
  score: number
}

/** Single scoring authority shared by story-history and style-corpus retrieval. */
export function scoreBigramBm25<T>(query: string, sourceDocuments: readonly Bm25Document<T>[], k1 = 1.2, b = 0.75): Bm25ScoredDocument<T>[] {
  const queryTerms = Array.from(new Set(tokenizeForBm25(query)))
  if (!queryTerms.length) return []
  const documents = sourceDocuments.flatMap((document) => {
    const tokens = tokenizeForBm25(document.text, true)
    return tokens.length ? [{ ...document, length: tokens.length, terms: termCounts(tokens) }] : []
  })
  if (!documents.length) return []
  const documentFrequency = new Map<string, number>()
  for (const document of documents) {
    for (const term of document.terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  }
  const averageDocumentLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length
  return documents.map((document) => {
    let score = 0
    for (const term of queryTerms) {
      const termFrequency = document.terms.get(term) ?? 0
      if (!termFrequency) continue
      const frequency = documentFrequency.get(term) ?? 0
      const inverseDocumentFrequency = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))
      const lengthNormalization = k1 * (1 - b + b * (document.length / averageDocumentLength))
      score += inverseDocumentFrequency * ((termFrequency * (k1 + 1)) / (termFrequency + lengthNormalization))
    }
    return { value: document.value, text: document.text, sourceIndex: document.sourceIndex, score }
  }).filter((document) => document.score > 0)
    .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)
}

function toRetrievedParagraph(paragraph: StoredParagraph, score: number): RetrievedParagraph {
  return {
    paragraphId: paragraph.id,
    projectId: paragraph.projectId,
    sourceType: paragraph.sourceType,
    chapterId: paragraph.chapterId,
    ...(paragraph.messageId ? { messageId: paragraph.messageId } : {}),
    paragraphIndex: paragraph.index,
    fingerprint: paragraph.fingerprint,
    text: paragraph.text,
    score,
  }
}

/**
 * Synchronous core of BigramBm25Retriever.retrieve, extracted so the same
 * filtering + scoring + truncation logic can run inside a Web Worker (with
 * the ParagraphBm25Index incremental cache) and on the main-thread fallback
 * path without duplicating behavior. Deterministic given the same input.
 *
 * trustFingerprint: 段落来自本地 DB 时跳过指纹哈希重算（与 worker 索引路径
 * 的信任策略一致）；默认保持严格校验，BigramBm25Retriever 行为不变。
 */
export function retrieveParagraphsSync(
  request: RetrievalRequest,
  k1 = 1.2,
  b = 0.75,
  options: { trustFingerprint?: boolean } = {},
): RetrievedParagraph[] {
  const { query, paragraphs } = request
  const isUsable = options.trustFingerprint ? isUsableParagraphTrusted : isUsableParagraph
  const documents: Array<Bm25Document<StoredParagraph>> = []
  for (const [sourceIndex, paragraph] of paragraphs.entries()) {
    if (!isUsable(paragraph)) continue
    documents.push({ value: paragraph, text: paragraph.text, sourceIndex })
  }
  const scored = scoreBigramBm25(query, documents, k1, b)

  const topK = request.topK === undefined ? 5 : Math.max(0, Math.floor(request.topK))
  const maxTotalCharacters = request.maxTotalCharacters === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(request.maxTotalCharacters))
  const results: RetrievedParagraph[] = []
  let usedCharacters = 0
  for (const item of scored) {
    if (results.length >= topK) break
    const textLength = item.value.text.length
    if (usedCharacters + textLength > maxTotalCharacters) continue
    results.push(toRetrievedParagraph(item.value, item.score))
    usedCharacters += textLength
  }
  return results
}

/** Zero-dependency BM25 retriever for the local paragraph store. */
export class BigramBm25Retriever implements Retriever {
  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  async retrieve(request: RetrievalRequest): Promise<RetrievedParagraph[]> {
    return retrieveParagraphsSync(request, this.k1, this.b)
  }
}
