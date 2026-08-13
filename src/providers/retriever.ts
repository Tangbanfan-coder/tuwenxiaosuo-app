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

function isUsableParagraph(paragraph: StoredParagraph): boolean {
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
    && paragraph.fingerprint === createParagraphFingerprint(paragraph.text),
  )
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

/** Zero-dependency BM25 retriever for the local paragraph store. */
export class BigramBm25Retriever implements Retriever {
  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  async retrieve(request: RetrievalRequest): Promise<RetrievedParagraph[]> {
    const documents: Array<Bm25Document<StoredParagraph>> = []
    for (const [sourceIndex, paragraph] of request.paragraphs.entries()) {
      if (!isUsableParagraph(paragraph)) continue
      documents.push({ value: paragraph, text: paragraph.text, sourceIndex })
    }
    const scored = scoreBigramBm25(request.query, documents, this.k1, this.b)

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
}
