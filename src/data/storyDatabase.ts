import Dexie, { type Table, type Transaction } from 'dexie'
import type {
  Chapter,
  CharacterAsset,
  ContextBudget,
  ConversationMessage,
  Feedback,
  FeedbackBatchInput,
  FeedbackScope,
  FeedbackTargetInput,
  Foreshadowing,
  IllustrationStylePresetId,
  IllustrationAsset,
  ProjectStyle,
  ProjectWorkspace,
  ReferenceStyleMode,
  SceneNotes,
  StoryProject,
  StoredParagraph,
  SummaryVersion,
  ThemePresetId,
  UpsertFeedbackInput,
  WritingTurnResult,
} from '../domain/models'
import { DEFAULT_ILLUSTRATION_STYLE_ID, getIllustrationStylePreset } from '../domain/illustrationStyles'
import { materializeWritingSceneNotes, reconcileForeshadowing } from '../domain/foreshadowing'
import { createParagraphFingerprint, hashText as hashTextImpl, normalizeText as normalizeParagraphText } from '../domain/paragraphs'
import { loadGlobalWritingInstructions } from '../providers/config'

export { hashText, normalizeText } from '../domain/paragraphs'

export const STORY_DATABASE_NAME = 'illustrated-story-chat'

export class StoryDatabase extends Dexie {
  projects!: Table<StoryProject, string>
  messages!: Table<ConversationMessage, string>
  chapters!: Table<Chapter, string>
  characters!: Table<CharacterAsset, string>
  illustrations!: Table<IllustrationAsset, string>
  styles!: Table<ProjectStyle, string>
  scenes!: Table<StoredScene, string>
  paragraphs!: Table<StoredParagraph, string>
  summaryVersions!: Table<SummaryVersion, string>
  feedback!: Table<Feedback, string>

  constructor(databaseName = STORY_DATABASE_NAME) {
    super(databaseName)
    this.version(1).stores({
      projects: 'id, updatedAt, lastOpenedAt',
      messages: 'id, projectId, [projectId+order], createdAt',
      chapters: 'id, projectId, [projectId+order], updatedAt',
      characters: 'id, projectId, [projectId+createdAt], status',
      illustrations: 'id, projectId, [projectId+createdAt], status',
      styles: 'id, &projectId, updatedAt',
    })
    this.version(2).stores({
      projects: 'id, updatedAt, lastOpenedAt',
      messages: 'id, projectId, [projectId+order], createdAt',
      chapters: 'id, projectId, [projectId+order], updatedAt',
      characters: 'id, projectId, [projectId+createdAt], status',
      illustrations: 'id, projectId, [projectId+createdAt], status',
      styles: 'id, &projectId, updatedAt',
      scenes: 'id, projectId, [projectId+order], createdAt',
    })
    this.version(3)
      .stores({
        projects: 'id, updatedAt, lastOpenedAt',
        messages: 'id, projectId, [projectId+order], createdAt',
        chapters: 'id, projectId, [projectId+order], updatedAt',
        characters: 'id, projectId, [projectId+createdAt], status',
        illustrations: 'id, projectId, [projectId+createdAt], status',
        styles: 'id, &projectId, updatedAt',
        scenes: 'id, projectId, [projectId+order], createdAt',
        paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      })
      .upgrade(async (transaction) => {
        await backfillParagraphsFromV2(transaction)
      })
    this.version(4)
      .stores({
        projects: 'id, updatedAt, lastOpenedAt',
        messages: 'id, projectId, [projectId+order], createdAt',
        chapters: 'id, projectId, [projectId+order], updatedAt',
        characters: 'id, projectId, [projectId+createdAt], status',
        illustrations: 'id, projectId, [projectId+createdAt], status',
        styles: 'id, &projectId, updatedAt',
        scenes: 'id, projectId, [projectId+order], createdAt',
        paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      })
      .upgrade(async (transaction) => {
        await upgradeForeshadowingFromV3(transaction)
      })
    this.version(5)
      .stores({
        projects: 'id, updatedAt, lastOpenedAt',
        messages: 'id, projectId, [projectId+order], createdAt',
        chapters: 'id, projectId, [projectId+order], updatedAt',
        characters: 'id, projectId, [projectId+createdAt], status',
        illustrations: 'id, projectId, [projectId+createdAt], status',
        styles: 'id, &projectId, updatedAt',
        scenes: 'id, projectId, [projectId+order], createdAt',
        paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
        summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt',
      })
      .upgrade(async (transaction) => {
        await backfillSummaryVersionsFromV4(transaction)
      })
    this.version(6).stores({
      projects: 'id, updatedAt, lastOpenedAt',
      messages: 'id, projectId, [projectId+order], createdAt',
      chapters: 'id, projectId, [projectId+order], updatedAt',
      characters: 'id, projectId, [projectId+createdAt], status',
      illustrations: 'id, projectId, [projectId+createdAt], status',
      styles: 'id, &projectId, updatedAt',
      scenes: 'id, projectId, [projectId+order], createdAt',
      paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt',
      feedback: 'id, projectId, messageId, [projectId+messageId], &targetKey, [projectId+updatedAt], updatedAt',
    })
    // v7 adds optional narrativePronoun to character records. The field is not
    // indexed, so preserving the prior schema keeps every legacy record readable.
    this.version(7).stores({
      projects: 'id, updatedAt, lastOpenedAt',
      messages: 'id, projectId, [projectId+order], createdAt',
      chapters: 'id, projectId, [projectId+order], updatedAt',
      characters: 'id, projectId, [projectId+createdAt], status',
      illustrations: 'id, projectId, [projectId+createdAt], status',
      styles: 'id, &projectId, updatedAt',
      scenes: 'id, projectId, [projectId+order], createdAt',
      paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt',
      feedback: 'id, projectId, messageId, [projectId+messageId], &targetKey, [projectId+updatedAt], updatedAt',
    })
    // v8 adds optional sceneAnchor fields to illustrations. No index or data
    // rewrite is required; legacy records remain valid and opt out of reuse.
    this.version(8).stores({
      projects: 'id, updatedAt, lastOpenedAt',
      messages: 'id, projectId, [projectId+order], createdAt',
      chapters: 'id, projectId, [projectId+order], updatedAt',
      characters: 'id, projectId, [projectId+createdAt], status',
      illustrations: 'id, projectId, [projectId+createdAt], status',
      styles: 'id, &projectId, updatedAt',
      scenes: 'id, projectId, [projectId+order], createdAt',
      paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt',
      feedback: 'id, projectId, messageId, [projectId+messageId], &targetKey, [projectId+updatedAt], updatedAt',
    })
  }
}

export interface StoredScene {
  id: string
  projectId: string
  chapterId?: string
  order: number
  createdAt: number
  notes: SceneNotes
  excerpt: string
}

export const storyDatabase = new StoryDatabase()

const ACTIVE_PROJECT_KEY = 'illustrated-story-chat.active-project.v1'

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
}

function optionalString(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

function foreshadowingArray(value: unknown): Foreshadowing[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const id = optionalString(record.id)
    const text = optionalString(record.text)
    if (!id || !text) return []
    const aliases = stringArray(record.aliases)
    return aliases.length ? [{ id, text, aliases }] : [{ id, text }]
  })
}

function stateChanges(value: unknown): SceneNotes['stateChanges'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const change = item as Record<string, unknown>
    const character = optionalString(change.character)
    const aspect = optionalString(change.aspect)
    const state = optionalString(change.state)
    return character && aspect && state ? [{ character, aspect, state }] : []
  })
}

function knowledgeChanges(value: unknown): SceneNotes['knowledgeChanges'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const change = item as Record<string, unknown>
    const character = optionalString(change.character)
    const nowKnows = optionalString(change.nowKnows)
    return character && nowKnows ? [{ character, nowKnows }] : []
  })
}

function emptySceneNotes(): SceneNotes {
  return {
    time: undefined,
    location: undefined,
    povCharacter: undefined,
    charactersPresent: [],
    events: [],
    stateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingPlanted: [],
    resolvedForeshadowingIds: [],
    unresolvedThreads: [],
  }
}

function migrateSceneNotes(scene: StoredScene, priorNotes: SceneNotes[]): SceneNotes {
  const raw = scene.notes && typeof scene.notes === 'object'
    ? scene.notes as unknown as Record<string, unknown>
    : {}
  const legacyPlanted = stringArray(raw.cluesPlanted)
  const reconciliation = reconcileForeshadowing(priorNotes, {
    foreshadowingPlanted: [
      ...foreshadowingArray(raw.foreshadowingPlanted),
      ...legacyPlanted.map((text, index) => ({
        id: `foreshadowing-legacy-${scene.id}-${index}`,
        text,
      })),
    ],
    resolvedForeshadowingIds: stringArray(raw.resolvedForeshadowingIds),
    legacyResolvedForeshadowingTexts: stringArray(raw.cluesResolved),
  })
  const historicalUnmatched = stringArray(raw.legacyUnmatchedResolvedForeshadowingTexts)
  const unmatched = [
    ...historicalUnmatched,
    ...(reconciliation.legacyUnmatchedResolvedForeshadowingTexts ?? []),
  ]

  return {
    time: optionalString(raw.time),
    location: optionalString(raw.location),
    povCharacter: optionalString(raw.povCharacter),
    charactersPresent: stringArray(raw.charactersPresent),
    events: stringArray(raw.events),
    stateChanges: stateChanges(raw.stateChanges),
    relationshipChanges: stringArray(raw.relationshipChanges),
    knowledgeChanges: knowledgeChanges(raw.knowledgeChanges),
    unresolvedThreads: stringArray(raw.unresolvedThreads),
    foreshadowingPlanted: reconciliation.foreshadowingPlanted,
    resolvedForeshadowingIds: reconciliation.resolvedForeshadowingIds,
    ...(unmatched.length ? { legacyUnmatchedResolvedForeshadowingTexts: unmatched } : {}),
  }
}

async function upgradeForeshadowingFromV3(transaction: Transaction) {
  const sceneTable = transaction.table('scenes') as Table<StoredScene, string>
  const scenes = await sceneTable.toArray()
  const histories = new Map<string, SceneNotes[]>()
  const upgraded = scenes
    .slice()
    .sort((left, right) => {
      if (left.projectId !== right.projectId) return left.projectId < right.projectId ? -1 : 1
      return left.order - right.order || left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    })
    .map((scene) => {
      const priorNotes = histories.get(scene.projectId) ?? []
      const notes = migrateSceneNotes(scene, priorNotes)
      histories.set(scene.projectId, [...priorNotes, notes])
      return { ...scene, notes }
    })

  if (upgraded.length) await sceneTable.bulkPut(upgraded)
}

function hasNonEmptySummary(summary: unknown): summary is string {
  return typeof summary === 'string' && summary.trim().length > 0
}

function summaryVersionCreatedAt(chapter: Chapter) {
  if (Number.isFinite(chapter.updatedAt)) return chapter.updatedAt
  if (Number.isFinite(chapter.createdAt)) return chapter.createdAt
  return Date.now()
}

/**
 * v4 already has immutable paragraph rows. Only bind migration records to
 * exact current chapter rows; never infer an association from matching text.
 */
async function backfillSummaryVersionsFromV4(transaction: Transaction) {
  const chapterTable = transaction.table('chapters') as Table<Chapter, string>
  const paragraphTable = transaction.table('paragraphs') as Table<StoredParagraph, string>
  const summaryVersionTable = transaction.table('summaryVersions') as Table<SummaryVersion, string>
  const chapters = await chapterTable.toArray()
  const versions: SummaryVersion[] = []

  for (const chapter of chapters) {
    if (!hasNonEmptySummary(chapter.summary)) continue

    const sourceContentHash = hashTextImpl(chapter.content)
    versions.push({
      id: createId('summary-version'),
      projectId: chapter.projectId,
      chapterId: chapter.id,
      version: 1,
      summary: chapter.summary,
      sourceContentHash,
      sourceParagraphIds: await listVerifiedCurrentChapterParagraphIds(chapter, paragraphTable),
      reason: 'migration',
      createdAt: summaryVersionCreatedAt(chapter),
    })
  }

  if (versions.length) await summaryVersionTable.bulkAdd(versions)
}

function createMessageParagraphRecords(message: ConversationMessage, createdAt = message.createdAt): StoredParagraph[] {
  if (message.kind !== 'prose' || !message.chapterId || !Array.isArray(message.paragraphs)) return []

  return message.paragraphs.map((text, index) => ({
    id: `paragraph-message-${message.id}-${index}`,
    projectId: message.projectId,
    sourceType: 'message',
    messageId: message.id,
    chapterId: message.chapterId!,
    index,
    text,
    fingerprint: createParagraphFingerprint(text),
    createdAt,
  }))
}

function splitChapterContent(content: string) {
  return content
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

function createChapterParagraphRecords(chapter: Chapter, createdAt = chapter.updatedAt): StoredParagraph[] {
  return splitChapterContent(chapter.content).map((text, index) => ({
    id: createChapterParagraphId(chapter, index),
    projectId: chapter.projectId,
    sourceType: 'chapter',
    chapterId: chapter.id,
    index,
    text,
    fingerprint: createParagraphFingerprint(text),
    createdAt,
  }))
}

function createChapterParagraphId(chapter: Chapter, index: number) {
  return `paragraph-chapter-${chapter.id}-${hashTextImpl(chapter.content)}-${index}`
}

async function backfillParagraphsFromV2(transaction: Transaction) {
  const paragraphTable = transaction.table('paragraphs') as Table<StoredParagraph, string>
  const messages = transaction.table('messages') as Table<ConversationMessage, string>
  const chapters = transaction.table('chapters') as Table<Chapter, string>
  const paragraphs: StoredParagraph[] = []

  await messages.toCollection().each((message) => {
    paragraphs.push(...createMessageParagraphRecords(message))
  })
  await chapters.toCollection().each((chapter) => {
    paragraphs.push(...createChapterParagraphRecords(chapter, chapter.updatedAt || chapter.createdAt))
  })

  if (paragraphs.length) await paragraphTable.bulkPut(paragraphs)
}

async function upsertMessageParagraphs(message: ConversationMessage) {
  const paragraphs = createMessageParagraphRecords(message)
  if (paragraphs.length) await storyDatabase.paragraphs.bulkPut(paragraphs)
  return paragraphs
}

/**
 * Stores one immutable paragraph version for the chapter's current content.
 * Call this in the same transaction as any future manual chapter-save path.
 */
export async function upsertChapterParagraphs(chapter: Chapter) {
  const paragraphs = createChapterParagraphRecords(chapter)
  if (!paragraphs.length) return paragraphs

  const existing = await storyDatabase.paragraphs.bulkGet(paragraphs.map((paragraph) => paragraph.id))
  const rowsToWrite = paragraphs
    .map((paragraph, index) => {
      const existingParagraph = existing[index]
      return existingParagraph ? { ...paragraph, createdAt: existingParagraph.createdAt } : paragraph
    })
    .filter((paragraph, index) => {
      const existingParagraph = existing[index]
      return !existingParagraph
        || existingParagraph.text !== paragraph.text
        || existingParagraph.fingerprint !== paragraph.fingerprint
        || existingParagraph.projectId !== paragraph.projectId
    })

  if (rowsToWrite.length) await storyDatabase.paragraphs.bulkPut(rowsToWrite)
  return paragraphs
}

function isExactStoredChapterParagraph(stored: StoredParagraph | undefined, expected: StoredParagraph) {
  return Boolean(
    stored
    && stored.id === expected.id
    && stored.projectId === expected.projectId
    && stored.sourceType === 'chapter'
    && stored.chapterId === expected.chapterId
    && stored.index === expected.index
    && stored.text === expected.text
    && stored.fingerprint === expected.fingerprint,
  )
}

/**
 * Uses deterministic IDs plus full record equality rather than text matching.
 * Missing or malformed historical paragraph rows are deliberately omitted.
 */
async function listVerifiedCurrentChapterParagraphIds(
  chapter: Chapter,
  paragraphTable: Table<StoredParagraph, string> = storyDatabase.paragraphs,
) {
  const expectedParagraphs = createChapterParagraphRecords(chapter)
  if (!expectedParagraphs.length) return []

  const storedParagraphs = await paragraphTable.bulkGet(expectedParagraphs.map((paragraph) => paragraph.id))
  return expectedParagraphs.flatMap((expected, index) => (
    isExactStoredChapterParagraph(storedParagraphs[index], expected) ? [expected.id] : []
  ))
}

function isVerifiedChapterParagraphForContentHash(
  paragraph: StoredParagraph | undefined,
  chapter: Chapter,
  sourceContentHash: string,
) {
  return Boolean(
    paragraph
    && paragraph.projectId === chapter.projectId
    && paragraph.sourceType === 'chapter'
    && paragraph.chapterId === chapter.id
    && Number.isInteger(paragraph.index)
    && paragraph.index >= 0
    && typeof paragraph.text === 'string'
    && paragraph.fingerprint === createParagraphFingerprint(paragraph.text)
    && paragraph.id === `paragraph-chapter-${chapter.id}-${sourceContentHash}-${paragraph.index}`,
  )
}

/**
 * Restore records retain the restored version's source provenance, but only
 * keep paragraph IDs that still resolve to a verified same-project chapter row.
 */
async function listVerifiedVersionSourceParagraphIds(
  chapter: Chapter,
  sourceContentHash: string,
  sourceParagraphIds: readonly string[],
  paragraphTable: Table<StoredParagraph, string> = storyDatabase.paragraphs,
) {
  const uniqueIds = Array.from(new Set(sourceParagraphIds.filter((id): id is string => typeof id === 'string' && id.length > 0)))
  if (!uniqueIds.length) return []

  const paragraphs = await paragraphTable.bulkGet(uniqueIds)
  return uniqueIds.flatMap((id, index) => (
    isVerifiedChapterParagraphForContentHash(paragraphs[index], chapter, sourceContentHash) ? [id] : []
  ))
}

function compareSummaryVersions(left: SummaryVersion, right: SummaryVersion) {
  if (left.version !== right.version) return left.version - right.version
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

async function readChapterSummaryVersions(
  projectId: string,
  chapterId: string,
  summaryVersionTable: Table<SummaryVersion, string> = storyDatabase.summaryVersions,
) {
  const versions = await summaryVersionTable.where('[projectId+chapterId]').equals([projectId, chapterId]).toArray()
  return versions.sort(compareSummaryVersions)
}

function nextSummaryVersionNumber(versions: readonly SummaryVersion[]) {
  return versions.reduce((highest, version) => (
    Number.isInteger(version.version) && version.version > highest ? version.version : highest
  ), 0) + 1
}

async function appendGeneratedChapterSummaryVersion(chapter: Chapter, summary: string, createdAt: number) {
  const sourceContentHash = hashTextImpl(chapter.content)
  const versions = await readChapterSummaryVersions(chapter.projectId, chapter.id)
  const latest = versions.at(-1)
  if (latest?.summary === summary && latest.sourceContentHash === sourceContentHash) return latest

  const version: SummaryVersion = {
    id: createId('summary-version'),
    projectId: chapter.projectId,
    chapterId: chapter.id,
    version: nextSummaryVersionNumber(versions),
    summary,
    sourceContentHash,
    sourceParagraphIds: await listVerifiedCurrentChapterParagraphIds(chapter),
    reason: 'generation',
    createdAt,
  }
  await storyDatabase.summaryVersions.add(version)
  return version
}

/** Returns immutable summary history in ascending version order for one chapter only. */
export async function listChapterSummaryVersions(projectId: string, chapterId: string) {
  return readChapterSummaryVersions(projectId, chapterId)
}

/**
 * Restores a summary without mutating history. The new record preserves the
 * selected version's proven source snapshot and points back to it explicitly.
 */
export async function restoreChapterSummaryVersion(projectId: string, chapterId: string, versionId: string) {
  const now = Date.now()
  return storyDatabase.transaction(
    'rw',
    [storyDatabase.chapters, storyDatabase.paragraphs, storyDatabase.summaryVersions],
    async () => {
      const chapter = await storyDatabase.chapters.get(chapterId)
      if (!chapter || chapter.projectId !== projectId) throw new Error('章节不存在或不属于当前作品')

      const restoredFrom = await storyDatabase.summaryVersions.get(versionId)
      if (!restoredFrom || restoredFrom.projectId !== projectId || restoredFrom.chapterId !== chapterId) {
        throw new Error('摘要版本不属于当前章节')
      }

      const versions = await readChapterSummaryVersions(projectId, chapterId)
      const restoredVersion: SummaryVersion = {
        id: createId('summary-version'),
        projectId,
        chapterId,
        version: nextSummaryVersionNumber(versions),
        summary: restoredFrom.summary,
        sourceContentHash: restoredFrom.sourceContentHash,
        sourceParagraphIds: await listVerifiedVersionSourceParagraphIds(
          chapter,
          restoredFrom.sourceContentHash,
          restoredFrom.sourceParagraphIds,
        ),
        reason: 'restore',
        restoredFromId: restoredFrom.id,
        createdAt: now,
      }

      await storyDatabase.chapters.update(chapterId, { summary: restoredVersion.summary, updatedAt: now })
      await storyDatabase.summaryVersions.add(restoredVersion)
      return restoredVersion
    },
  )
}

/** Minimal project-scoped query for future retrieval and feedback features. */
export async function listProjectParagraphs(projectId: string) {
  return storyDatabase.paragraphs.where('projectId').equals(projectId).sortBy('createdAt')
}

interface ResolvedFeedbackTarget {
  projectId: string
  messageId: string
  chapterId: string
  scope: FeedbackScope
  paragraphId?: string
  paragraphIndex?: number
  paragraphFingerprint?: string
  targetKey: string
}

function requiredFeedbackString(value: unknown, label: string) {
  const normalized = optionalString(value)
  if (!normalized) throw new Error(`${label}不能为空`)
  return normalized
}

function normalizeFeedbackScope(value: unknown): FeedbackScope {
  if (value === 'message' || value === 'paragraph') return value
  throw new Error('反馈范围必须是 message 或 paragraph')
}

function normalizeFeedbackPayload(input: Pick<UpsertFeedbackInput, 'verdict' | 'reason' | 'customNote'>) {
  if (input.verdict !== 'up' && input.verdict !== 'down') {
    throw new Error('反馈结论必须是 up 或 down')
  }
  return {
    verdict: input.verdict,
    reason: optionalString(input.reason),
    customNote: optionalString(input.customNote),
  }
}

function createFeedbackTargetKey(target: Pick<ResolvedFeedbackTarget, 'projectId' | 'messageId' | 'chapterId' | 'scope' | 'paragraphId'>) {
  // JSON avoids delimiter collisions when validating persisted, externally supplied IDs.
  return JSON.stringify([
    target.projectId,
    target.messageId,
    target.chapterId,
    target.scope,
    target.scope === 'paragraph' ? target.paragraphId : null,
  ])
}

async function getOwnedFeedbackMessage(projectIdValue: string, messageIdValue: string) {
  const projectId = requiredFeedbackString(projectIdValue, '作品 ID')
  const messageId = requiredFeedbackString(messageIdValue, '消息 ID')
  const project = await storyDatabase.projects.get(projectId)
  if (!project) throw new Error('作品不存在')

  const message = await storyDatabase.messages.get(messageId)
  if (!message || message.projectId !== projectId) throw new Error('消息不存在或不属于当前作品')
  return { projectId, messageId, message }
}

async function resolveFeedbackTarget(input: FeedbackTargetInput): Promise<ResolvedFeedbackTarget> {
  const { projectId, messageId, message } = await getOwnedFeedbackMessage(input.projectId, input.messageId)
  if (message.kind !== 'prose') throw new Error('仅正文消息支持反馈')

  const chapterId = requiredFeedbackString(input.chapterId, '章节 ID')
  const chapter = await storyDatabase.chapters.get(chapterId)
  if (!chapter || chapter.projectId !== projectId) throw new Error('章节不存在或不属于当前作品')
  if (message.chapterId !== chapterId) throw new Error('消息不属于当前章节')

  const scope = normalizeFeedbackScope(input.scope)
  if (scope === 'message') {
    const target = { projectId, messageId, chapterId, scope }
    return { ...target, targetKey: createFeedbackTargetKey(target) }
  }

  const paragraphId = requiredFeedbackString(input.paragraphId, '段落 ID')
  const rawParagraphIndex = input.paragraphIndex
  if (typeof rawParagraphIndex !== 'number' || !Number.isInteger(rawParagraphIndex) || rawParagraphIndex < 0) {
    throw new Error('段落序号必须是非负整数')
  }
  const paragraphIndex = rawParagraphIndex
  const paragraphFingerprint = requiredFeedbackString(input.paragraphFingerprint, '段落指纹')
  const paragraph = await storyDatabase.paragraphs.get(paragraphId)
  if (
    !paragraph
    || paragraph.projectId !== projectId
    || paragraph.sourceType !== 'message'
    || paragraph.messageId !== messageId
    || paragraph.chapterId !== chapterId
  ) {
    throw new Error('段落不存在或不属于当前正文消息')
  }

  const currentText = message.paragraphs?.[paragraphIndex]
  if (
    paragraph.index !== paragraphIndex
    || paragraph.fingerprint !== paragraphFingerprint
    || paragraph.fingerprint !== createParagraphFingerprint(paragraph.text)
    || typeof currentText !== 'string'
    || paragraph.text !== currentText
    || createParagraphFingerprint(currentText) !== paragraphFingerprint
  ) {
    throw new Error('段落已变化，无法将反馈绑定到过期锚点')
  }

  const target = {
    projectId,
    messageId,
    chapterId,
    scope,
    paragraphId,
    paragraphIndex,
    paragraphFingerprint,
  }
  return { ...target, targetKey: createFeedbackTargetKey(target) }
}

function assertFeedbackMatchesTarget(feedback: Feedback, target: ResolvedFeedbackTarget) {
  if (
    feedback.targetKey !== target.targetKey
    || feedback.projectId !== target.projectId
    || feedback.messageId !== target.messageId
    || feedback.chapterId !== target.chapterId
    || feedback.scope !== target.scope
    || feedback.paragraphId !== target.paragraphId
    || feedback.paragraphIndex !== target.paragraphIndex
    || feedback.paragraphFingerprint !== target.paragraphFingerprint
  ) {
    throw new Error('已有反馈记录与当前目标不一致，拒绝漂移绑定')
  }
}

async function findFeedbackForTarget(target: ResolvedFeedbackTarget) {
  const existing = await storyDatabase.feedback.where('targetKey').equals(target.targetKey).first()
  if (existing) assertFeedbackMatchesTarget(existing, target)
  return existing
}

function createFeedbackRecord(
  target: ResolvedFeedbackTarget,
  payload: ReturnType<typeof normalizeFeedbackPayload>,
  now: number,
): Feedback {
  return {
    id: createId('feedback'),
    ...target,
    ...payload,
    createdAt: now,
    updatedAt: now,
  }
}

function updateFeedbackRecord(
  feedback: Feedback,
  payload: ReturnType<typeof normalizeFeedbackPayload>,
  now: number,
): Feedback {
  return {
    ...feedback,
    ...payload,
    // Keep recency meaningful even if two clicks share the same clock tick.
    updatedAt: Number.isFinite(feedback.updatedAt) ? Math.max(now, feedback.updatedAt + 1) : now,
  }
}

/**
 * Creates or updates exactly one judgement for a stable feedback target.
 * Existing targets retain their original identity and createdAt timestamp.
 */
export async function upsertFeedback(input: UpsertFeedbackInput) {
  const payload = normalizeFeedbackPayload(input)
  const now = Date.now()
  return storyDatabase.transaction(
    'rw',
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.paragraphs, storyDatabase.feedback],
    async () => {
      const target = await resolveFeedbackTarget(input)
      const existing = await findFeedbackForTarget(target)
      if (!existing) {
        const feedback = createFeedbackRecord(target, payload, now)
        await storyDatabase.feedback.add(feedback)
        return feedback
      }

      const updated = updateFeedbackRecord(existing, payload, now)
      await storyDatabase.feedback.put(updated)
      return updated
    },
  )
}

/**
 * Taps are stateful: the same verdict removes the target's feedback, while a
 * different verdict updates the existing row and preserves createdAt.
 */
export async function toggleFeedback(input: UpsertFeedbackInput): Promise<Feedback | null> {
  const payload = normalizeFeedbackPayload(input)
  const now = Date.now()
  return storyDatabase.transaction(
    'rw',
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.paragraphs, storyDatabase.feedback],
    async () => {
      const target = await resolveFeedbackTarget(input)
      const existing = await findFeedbackForTarget(target)
      if (!existing) {
        const feedback = createFeedbackRecord(target, payload, now)
        await storyDatabase.feedback.add(feedback)
        return feedback
      }
      if (existing.verdict === payload.verdict) {
        await storyDatabase.feedback.delete(existing.id)
        return null
      }

      const updated = updateFeedbackRecord(existing, payload, now)
      await storyDatabase.feedback.put(updated)
      return updated
    },
  )
}

/** Applies one verdict to multiple exact paragraph/message targets atomically. */
export async function toggleFeedbackBatch(input: FeedbackBatchInput): Promise<Feedback[]> {
  if (!Array.isArray(input.targets) || input.targets.length === 0) throw new Error('至少选择一个反馈目标')
  const payload = normalizeFeedbackPayload(input)
  const now = Date.now()
  return storyDatabase.transaction(
    'rw',
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.paragraphs, storyDatabase.feedback],
    async () => {
      const changed: Feedback[] = []
      for (const targetInput of input.targets) {
        const target = await resolveFeedbackTarget(targetInput)
        const existing = await findFeedbackForTarget(target)
        if (existing?.verdict === payload.verdict) {
          await storyDatabase.feedback.delete(existing.id)
          continue
        }
        if (existing) {
          const updated = updateFeedbackRecord(existing, payload, now)
          await storyDatabase.feedback.put(updated)
          changed.push(updated)
        } else {
          const feedback = createFeedbackRecord(target, payload, now)
          await storyDatabase.feedback.add(feedback)
          changed.push(feedback)
        }
      }
      return changed
    },
  )
}

/** Removes one exact, still-valid feedback target and reports whether it existed. */
export async function removeFeedback(input: FeedbackTargetInput) {
  return storyDatabase.transaction(
    'rw',
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.paragraphs, storyDatabase.feedback],
    async () => {
      const target = await resolveFeedbackTarget(input)
      const existing = await findFeedbackForTarget(target)
      if (!existing) return false
      await storyDatabase.feedback.delete(existing.id)
      return true
    },
  )
}

function compareFeedbackByCreatedAt(left: Feedback, right: Feedback) {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function compareRecentFeedback(left: Feedback, right: Feedback) {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

/** Returns all feedback for an owned message in deterministic creation order. */
export async function listMessageFeedback(projectIdValue: string, messageIdValue: string) {
  const { projectId, messageId } = await getOwnedFeedbackMessage(projectIdValue, messageIdValue)
  const feedback = await storyDatabase.feedback
    .where('[projectId+messageId]')
    .equals([projectId, messageId])
    .toArray()
  return feedback.sort(compareFeedbackByCreatedAt)
}

/** Returns the most recently changed feedback records for one existing project. */
export async function listRecentProjectFeedback(projectIdValue: string, limit = 8) {
  const projectId = requiredFeedbackString(projectIdValue, '作品 ID')
  if (!Number.isInteger(limit) || limit < 0) throw new Error('反馈数量上限必须是非负整数')
  const project = await storyDatabase.projects.get(projectId)
  if (!project) throw new Error('作品不存在')
  if (limit === 0) return []

  const feedback = await storyDatabase.feedback
    .where('[projectId+updatedAt]')
    .between([projectId, Dexie.minKey], [projectId, Dexie.maxKey])
    .toArray()
  return feedback.sort(compareRecentFeedback).slice(0, limit)
}

function hasValidParagraphFingerprint(paragraph: StoredParagraph) {
  return typeof paragraph.text === 'string'
    && paragraph.text.trim().length > 0
    && typeof paragraph.fingerprint === 'string'
    && paragraph.fingerprint === createParagraphFingerprint(paragraph.text)
}

function isCurrentChapterParagraph(paragraph: StoredParagraph, chapter: Chapter) {
  if (
    paragraph.projectId !== chapter.projectId
    || paragraph.sourceType !== 'chapter'
    || paragraph.chapterId !== chapter.id
  ) return false
  if (!Number.isInteger(paragraph.index) || paragraph.index < 0) return false
  const currentTexts = splitChapterContent(chapter.content)
  return paragraph.id === createChapterParagraphId(chapter, paragraph.index)
    && paragraph.text === currentTexts[paragraph.index]
    && paragraph.fingerprint === createParagraphFingerprint(paragraph.text)
}

function paragraphCopyKey(paragraph: StoredParagraph) {
  return `${paragraph.chapterId}\u0000${paragraph.fingerprint}\u0000${normalizeParagraphText(paragraph.text)}`
}

/**
 * Returns only retrievable paragraphs for a project:
 * - current chapter-content versions (old immutable versions stay stored);
 * - fingerprint-valid message paragraphs;
 * - chapter/message copies collapsed within the same chapter only, with the
 *   current chapter record winning so it retains the chapter paragraph index.
 */
export async function listRetrievableProjectParagraphs(projectId: string): Promise<StoredParagraph[]> {
  const [paragraphs, chapters] = await Promise.all([
    storyDatabase.paragraphs.where('projectId').equals(projectId).toArray(),
    storyDatabase.chapters.where('projectId').equals(projectId).sortBy('order'),
  ])
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]))
  const validRows = paragraphs.filter((paragraph) => hasValidParagraphFingerprint(paragraph))
  const currentChapterRows = validRows.filter((paragraph) => {
    const chapter = chapterById.get(paragraph.chapterId)
    return Boolean(chapter && isCurrentChapterParagraph(paragraph, chapter))
  })
  const chapterCopies = new Set(currentChapterRows.map(paragraphCopyKey))
  const messageRows = validRows.filter((paragraph) => (
    paragraph.sourceType === 'message'
    && typeof paragraph.chapterId === 'string'
    && paragraph.chapterId.length > 0
    && !chapterCopies.has(paragraphCopyKey(paragraph))
  ))
  const chapterOrder = new Map(chapters.map((chapter) => [chapter.id, chapter.order]))

  return [...currentChapterRows, ...messageRows].sort((left, right) => {
    const leftOrder = chapterOrder.get(left.chapterId) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = chapterOrder.get(right.chapterId) ?? Number.MAX_SAFE_INTEGER
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    if (left.chapterId !== right.chapterId) return left.chapterId < right.chapterId ? -1 : 1
    if (left.sourceType !== right.sourceType) return left.sourceType === 'chapter' ? -1 : 1
    if (left.index !== right.index) return left.index - right.index
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

export async function initializeStoryDatabase() {
  await storyDatabase.open()
}

export async function listProjects() {
  return storyDatabase.projects.orderBy('lastOpenedAt').reverse().toArray()
}

export async function loadProjectWorkspace(projectId: string): Promise<ProjectWorkspace | null> {
  const project = await storyDatabase.projects.get(projectId)
  if (!project) return null

  const [messages, chapters, characters, illustrations, style] = await Promise.all([
    storyDatabase.messages.where('projectId').equals(projectId).sortBy('order'),
    storyDatabase.chapters.where('projectId').equals(projectId).sortBy('order'),
    storyDatabase.characters.where('projectId').equals(projectId).sortBy('createdAt'),
    storyDatabase.illustrations.where('projectId').equals(projectId).sortBy('createdAt'),
    storyDatabase.styles.where('projectId').equals(projectId).first(),
  ])

  const globalWritingInstructions = loadGlobalWritingInstructions()
  return globalWritingInstructions
    ? { project, globalWritingInstructions, messages, chapters, characters, illustrations, style }
    : { project, messages, chapters, characters, illustrations, style }
}

export async function listGeneratingImageAssets() {
  const [illustrations, characters] = await Promise.all([
    storyDatabase.illustrations.where('status').equals('generating').toArray(),
    storyDatabase.characters.toArray(),
  ])
  return {
    illustrations,
    characters: characters.filter((character) => character.portraitStatus === 'generating'),
  }
}

export async function listReadyLocalIllustrations() {
  return storyDatabase.illustrations
    .where('status')
    .equals('ready')
    .filter((illustration) => Boolean(illustration.localUri))
    .toArray()
}

export async function createProject(title: string) {
  const now = Date.now()
  const projectId = createId('project')
  const project: StoryProject = {
    id: projectId,
    title: title.trim(),
    themeId: 'neutral',
    autoIllustrate: true,
    writingInstructions: '',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  }
  const style: ProjectStyle = {
    id: createId('style'),
    projectId,
    presetId: 'neutral',
    illustrationStyleId: DEFAULT_ILLUSTRATION_STYLE_ID,
    visualPrompt: getIllustrationStylePreset(DEFAULT_ILLUSTRATION_STYLE_ID).visualPrompt,
    negativePrompt: getIllustrationStylePreset(DEFAULT_ILLUSTRATION_STYLE_ID).negativePrompt,
    updatedAt: now,
  }

  await storyDatabase.transaction('rw', [storyDatabase.projects, storyDatabase.styles], async () => {
    await storyDatabase.projects.add(project)
    await storyDatabase.styles.add(style)
  })
  setActiveProjectId(projectId)
  return project
}

export async function renameProject(projectId: string, title: string) {
  const normalizedTitle = title.trim()
  if (!normalizedTitle) throw new Error('请填写作品名称')
  if (normalizedTitle.length > 60) throw new Error('作品名称不能超过 60 个字')
  const now = Date.now()
  await storyDatabase.transaction('rw', [storyDatabase.projects], async () => {
    await storyDatabase.projects.update(projectId, { title: normalizedTitle, updatedAt: now })
  })
  return normalizedTitle
}

export async function createCharacterDraft(projectId: string, name: string, role: string) {
  const normalizedName = name.trim()
  if (!normalizedName) throw new Error('请填写角色名称')

  const existingCharacters = await storyDatabase.characters.where('projectId').equals(projectId).toArray()
  if (existingCharacters.some((character) => character.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
    throw new Error('当前作品已经有同名角色')
  }

  const now = Date.now()
  const character: CharacterAsset = {
    id: createId('character'),
    projectId,
    name: normalizedName,
    role: role.trim() || '主要角色',
    identity: {
      ageAndBuild: '',
      fixedTraits: [],
    },
    appearance: {
      defaultLook: '',
      wardrobe: '',
    },
    continuity: { revision: 0, referenceStyleMode: 'project' },
    portraitStatus: 'planned',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  }

  await storyDatabase.transaction('rw', [storyDatabase.characters, storyDatabase.projects], async () => {
    await storyDatabase.characters.add(character)
    await storyDatabase.projects.update(projectId, { updatedAt: now })
  })
  return character
}

export async function deleteProject(projectId: string) {
  await storyDatabase.transaction(
    'rw',
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.characters, storyDatabase.illustrations, storyDatabase.styles, storyDatabase.scenes, storyDatabase.paragraphs, storyDatabase.summaryVersions, storyDatabase.feedback],
    async () => {
      await Promise.all([
        storyDatabase.messages.where('projectId').equals(projectId).delete(),
        storyDatabase.chapters.where('projectId').equals(projectId).delete(),
        storyDatabase.characters.where('projectId').equals(projectId).delete(),
        storyDatabase.illustrations.where('projectId').equals(projectId).delete(),
        storyDatabase.styles.where('projectId').equals(projectId).delete(),
        storyDatabase.scenes.where('projectId').equals(projectId).delete(),
        storyDatabase.paragraphs.where('projectId').equals(projectId).delete(),
        storyDatabase.summaryVersions.where('projectId').equals(projectId).delete(),
        storyDatabase.feedback.where('projectId').equals(projectId).delete(),
      ])
      await storyDatabase.projects.delete(projectId)
    },
  )
  if (getActiveProjectId() === projectId) localStorage.removeItem(ACTIVE_PROJECT_KEY)
}

export async function markProjectOpened(projectId: string) {
  const now = Date.now()
  await storyDatabase.projects.update(projectId, { lastOpenedAt: now })
  setActiveProjectId(projectId)
}

export async function updateProjectTheme(projectId: string, themeId: ThemePresetId) {
  const now = Date.now()
  await storyDatabase.transaction('rw', [storyDatabase.projects, storyDatabase.styles], async () => {
    await storyDatabase.projects.update(projectId, { themeId, updatedAt: now })
    const style = await storyDatabase.styles.where('projectId').equals(projectId).first()
    if (style) await storyDatabase.styles.update(style.id, { presetId: themeId, updatedAt: now })
  })
}

export async function updateIllustrationStyle(projectId: string, styleId: IllustrationStylePresetId, customPrompt?: string) {
  const now = Date.now()
  const preset = getIllustrationStylePreset(styleId)
  const normalizedCustomPrompt = customPrompt?.trim() ?? ''
  if (styleId === 'custom' && !normalizedCustomPrompt) throw new Error('请填写自定义画风')
  if (normalizedCustomPrompt.length > 500) throw new Error('自定义画风不能超过 500 个字')

  const visualPrompt = styleId === 'custom' ? normalizedCustomPrompt : preset.visualPrompt
  const style = await storyDatabase.styles.where('projectId').equals(projectId).first()
  await storyDatabase.transaction('rw', [storyDatabase.projects, storyDatabase.styles], async () => {
    if (style) {
      await storyDatabase.styles.update(style.id, {
        illustrationStyleId: styleId,
        customVisualPrompt: styleId === 'custom' ? normalizedCustomPrompt : undefined,
        visualPrompt,
        negativePrompt: preset.negativePrompt,
        updatedAt: now,
      })
    } else {
      await storyDatabase.styles.add({
        id: createId('style'),
        projectId,
        presetId: 'neutral',
        illustrationStyleId: styleId,
        customVisualPrompt: styleId === 'custom' ? normalizedCustomPrompt : undefined,
        visualPrompt,
        negativePrompt: preset.negativePrompt,
        updatedAt: now,
      })
    }
    await storyDatabase.projects.update(projectId, { updatedAt: now })
  })
}

export async function updateAutoIllustrate(projectId: string, autoIllustrate: boolean) {
  await storyDatabase.projects.update(projectId, { autoIllustrate, updatedAt: Date.now() })
}

export async function updateWritingInstructions(projectId: string, writingInstructions: string) {
  const normalized = writingInstructions.trim()
  if (normalized.length > 50_000) throw new Error('局部创作设定不能超过 50000 个字')
  await storyDatabase.projects.update(projectId, {
    writingInstructions: normalized,
    writingStructure: '',
    updatedAt: Date.now(),
  })
}

export async function updateWritingStructure(projectId: string, writingStructure: string) {
  const project = await storyDatabase.projects.get(projectId)
  const sourceHash = hashTextImpl(project?.writingInstructions ?? '')
  let stored: string
  if (writingStructure) {
    try {
      const parsed = JSON.parse(writingStructure) as Record<string, unknown>
      stored = JSON.stringify({ ...parsed, sourceHash })
    } catch {
      stored = writingStructure
    }
  } else {
    stored = ''
  }
  await storyDatabase.projects.update(projectId, {
    writingStructure: stored,
    updatedAt: Date.now(),
  })
}

export async function loadProjectScenes(projectId: string) {
  return storyDatabase.scenes.where('projectId').equals(projectId).sortBy('order')
}

export async function updateContextBudget(projectId: string, contextBudget: ContextBudget) {
  await storyDatabase.projects.update(projectId, {
    contextBudget,
    updatedAt: Date.now(),
  })
}

async function getLastMessageOrder(projectId: string) {
  const last = await storyDatabase.messages
    .where('[projectId+order]')
    .between([projectId, Dexie.minKey], [projectId, Dexie.maxKey])
    .last()
  return last?.order ?? 0
}

export async function beginWritingTurn(projectId: string, text: string, autoIllustrate: boolean, chapterId?: string) {
  const now = Date.now()
  const nextOrder = (await getLastMessageOrder(projectId)) + 1
  const messages: ConversationMessage[] = [
    {
      id: createId('message'),
      projectId,
      chapterId,
      kind: 'user',
      order: nextOrder,
      createdAt: now,
      text,
    },
    {
      id: createId('message'),
      projectId,
      chapterId,
      kind: 'notice',
      order: nextOrder + 1,
      createdAt: now + 1,
      text: autoIllustrate ? '正在创作正文并整理视觉计划…' : '正在创作正文…',
      status: 'pending',
    },
  ]

  await storyDatabase.transaction('rw', [storyDatabase.messages, storyDatabase.projects], async () => {
    await storyDatabase.messages.bulkAdd(messages)
    await storyDatabase.projects.update(projectId, { autoIllustrate, updatedAt: now })
  })
  return messages
}

export async function completeWritingTurn(
  projectId: string,
  userMessageId: string,
  noticeId: string,
  result: WritingTurnResult,
  autoIllustrate: boolean,
  forceNewChapter = false,
) {
  const now = Date.now()
  const generatedSummary = result.chapterSummary?.trim() || undefined
  await storyDatabase.transaction(
    'rw',
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.characters, storyDatabase.illustrations, storyDatabase.scenes, storyDatabase.paragraphs, storyDatabase.summaryVersions],
    async () => {
      const project = await storyDatabase.projects.get(projectId)
      if (!project) throw new Error('当前作品不存在')
      let nextOrder = (await getLastMessageOrder(projectId)) + 1

      const chapters = await storyDatabase.chapters.where('projectId').equals(projectId).sortBy('order')
      const activeChapter = project.activeChapterId
        ? chapters.find((chapter) => chapter.id === project.activeChapterId)
        : chapters[chapters.length - 1]
      let targetChapter: Chapter

      if (!activeChapter || forceNewChapter || result.chapterAction === 'new') {
        const chapterId = createId('chapter')
        const chapterOrder = chapters.reduce((highest, chapter) => Math.max(highest, chapter.order), 0) + 1
        targetChapter = {
          id: chapterId,
          projectId,
          title: result.chapterTitle || `第${chapterOrder}章`,
          order: chapterOrder,
          content: result.paragraphs.join('\n\n'),
          status: 'draft',
          summary: generatedSummary,
          createdAt: now,
          updatedAt: now,
        }
        await storyDatabase.chapters.add(targetChapter)
        project.activeChapterId = chapterId
      } else {
        const title = result.chapterTitle || activeChapter.title
        const content = [activeChapter.content.trim(), result.paragraphs.join('\n\n')].filter(Boolean).join('\n\n')
        await storyDatabase.chapters.update(activeChapter.id, {
          title,
          content,
          summary: generatedSummary ?? activeChapter.summary,
          updatedAt: now,
        })
        targetChapter = { ...activeChapter, title, content, updatedAt: now, summary: generatedSummary ?? activeChapter.summary }
        project.activeChapterId = activeChapter.id
      }

      const priorScenes = await storyDatabase.scenes.where('projectId').equals(projectId).sortBy('order')
      const nextSceneOrder = priorScenes.reduce((highest, scene) => Math.max(highest, scene.order), 0) + 1
      const sceneNotes = result.sceneNotes
        ? materializeWritingSceneNotes(result.sceneNotes, priorScenes.map((scene) => scene.notes))
        : emptySceneNotes()
      await storyDatabase.scenes.add({
        id: createId('scene'),
        projectId,
        chapterId: targetChapter.id,
        order: nextSceneOrder,
        createdAt: now,
        notes: sceneNotes,
        excerpt: result.paragraphs.join('\n\n').slice(-6_000),
      })

      await storyDatabase.messages.update(userMessageId, { chapterId: targetChapter.id })
      await storyDatabase.messages.update(noticeId, {
        chapterId: targetChapter.id,
        text: result.assistantNote,
        status: 'ready',
      })

      const proseMessage: ConversationMessage = {
        id: createId('message'),
        projectId,
        chapterId: targetChapter.id,
        kind: 'prose',
        order: nextOrder++,
        createdAt: now,
        paragraphs: result.paragraphs,
        status: 'ready',
      }
      await storyDatabase.messages.add(proseMessage)
      await upsertMessageParagraphs(proseMessage)
      await upsertChapterParagraphs(targetChapter)
      if (generatedSummary) await appendGeneratedChapterSummaryVersion(targetChapter, generatedSummary, now)

      // Visual planning and character continuity are durable writing metadata.
      // The auto-illustrate switch controls paid generation only, never whether
      // characters or a recoverable illustration plan are recorded.
      if (result.visualPlan) {
        const referenceCharacterIds: string[] = []
        for (const characterPlan of result.visualPlan.characters) {
          const existingCharacters = await storyDatabase.characters.where('projectId').equals(projectId).toArray()
          const existing = existingCharacters.find((character) => character.name.toLocaleLowerCase() === characterPlan.name.toLocaleLowerCase())
          if (existing) {
            referenceCharacterIds.push(existing.id)
            continue
          }
          const characterId = createId('character')
          const character: CharacterAsset = {
            id: characterId,
            projectId,
            name: characterPlan.name,
            role: characterPlan.role,
            identity: {
              ageAndBuild: characterPlan.ageAndBuild,
              fixedTraits: characterPlan.fixedTraits,
            },
            appearance: {
              defaultLook: characterPlan.defaultLook,
              wardrobe: characterPlan.wardrobe,
            },
            continuity: { revision: 0, referenceStyleMode: 'project' },
            portraitStatus: 'planned',
            status: 'draft',
            createdAt: now,
            updatedAt: now,
          }
          await storyDatabase.characters.add(character)
          referenceCharacterIds.push(characterId)
        }

        const illustrationId = createId('illustration')
        const illustrationMessageId = createId('message')
        const illustration: IllustrationAsset = {
          id: illustrationId,
          projectId,
          chapterId: targetChapter.id,
          messageId: illustrationMessageId,
          title: result.visualPlan.title,
          prompt: result.visualPlan.prompt,
          sceneStylePrompt: result.visualPlan.stylePrompt,
          sceneNegativePrompt: result.visualPlan.negativePrompt,
          action: result.visualPlan.action,
          bodyLanguage: result.visualPlan.bodyLanguage,
          expression: result.visualPlan.expression,
          gaze: result.visualPlan.gaze,
          camera: result.visualPlan.camera,
          motion: result.visualPlan.motion,
          sceneAnchor: result.visualPlan.sceneAnchor,
          referenceCharacterIds,
          status: 'planned',
          createdAt: now,
          updatedAt: now,
        }
        await storyDatabase.illustrations.add(illustration)
        await storyDatabase.messages.add({
          id: illustrationMessageId,
          projectId,
          chapterId: targetChapter.id,
          kind: 'illustration',
          order: nextOrder,
          createdAt: now + 1,
          title: illustration.title,
          illustrationId,
          status: 'ready',
        })
      }

      await storyDatabase.projects.update(projectId, {
        activeChapterId: project.activeChapterId,
        updatedAt: now,
      })
    },
  )
}

export async function failWritingTurn(noticeId: string, message: string, partialProse?: string) {
  const draft = partialProse?.trim()
  await storyDatabase.transaction('rw', storyDatabase.messages, async () => {
    const notice = await storyDatabase.messages.get(noticeId)
    if (!notice) return

    const draftHint = draft ? ' 已保留模型已经返回的未完成草稿，未写入章节正文。' : ''
    await storyDatabase.messages.update(noticeId, {
      text: `写作失败：${message}。${draftHint}没有自动重试，请检查配置后重新发送。`,
      status: 'failed',
    })

    if (!draft) return
    const order = (await getLastMessageOrder(notice.projectId)) + 1
    await storyDatabase.messages.add({
      id: createId('message'),
      projectId: notice.projectId,
      chapterId: notice.chapterId,
      kind: 'prose',
      order,
      createdAt: Date.now(),
      paragraphs: draft.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean),
      status: 'failed',
    })
  })
}

export async function setCharacterPortraitGenerating(characterId: string) {
  await storyDatabase.characters.update(characterId, {
    portraitStatus: 'generating',
    portraitError: undefined,
    updatedAt: Date.now(),
  })
}

export async function setCharacterPortraitReady(characterId: string, referenceImageUrl: string, localUri?: string, referenceStyleMode?: ReferenceStyleMode) {
  const character = await storyDatabase.characters.get(characterId)
  if (!character) throw new Error('角色资产不存在')
  await storyDatabase.characters.update(characterId, {
    continuity: {
      ...character.continuity,
      referenceImageUrl,
      localUri,
      revision: character.continuity.revision + 1,
      referenceStyleMode: referenceStyleMode ?? character.continuity.referenceStyleMode ?? 'project',
    },
    portraitStatus: 'review',
    portraitError: undefined,
    status: 'draft',
    updatedAt: Date.now(),
  })
}

export async function updateCharacterReferenceStyleMode(characterId: string, referenceStyleMode: ReferenceStyleMode) {
  const character = await storyDatabase.characters.get(characterId)
  if (!character) throw new Error('角色资产不存在')
  await storyDatabase.characters.update(characterId, {
    continuity: {
      ...character.continuity,
      referenceStyleMode,
    },
    updatedAt: Date.now(),
  })
}

export async function updateCharacterProfile(
  characterId: string,
  profile: {
    ageAndBuild?: string
    fixedTraits?: string[]
    defaultLook?: string
    wardrobe?: string
    narrativePronoun?: CharacterAsset['narrativePronoun']
  },
) {
  const character = await storyDatabase.characters.get(characterId)
  if (!character) throw new Error('角色资产不存在')
  const normalized = {
    ageAndBuild: profile.ageAndBuild?.trim() ?? '',
    fixedTraits: (profile.fixedTraits ?? []).map((trait) => trait.trim()).filter(Boolean),
    defaultLook: profile.defaultLook?.trim() ?? '',
    wardrobe: profile.wardrobe?.trim() ?? '',
  }
  await storyDatabase.characters.update(characterId, {
    identity: {
      ...character.identity,
      ageAndBuild: normalized.ageAndBuild,
      fixedTraits: normalized.fixedTraits,
    },
    appearance: {
      ...character.appearance,
      defaultLook: normalized.defaultLook,
      wardrobe: normalized.wardrobe,
    },
    narrativePronoun: profile.narrativePronoun ?? character.narrativePronoun,
    updatedAt: Date.now(),
  })
}

export async function setCharacterPortraitFailed(characterId: string, message: string) {
  await storyDatabase.characters.update(characterId, {
    portraitStatus: 'failed',
    portraitError: message,
    updatedAt: Date.now(),
  })
}

/** Apply user-reviewed or model-suggested appearance facts and require review again. */
export async function applyReferenceAppearanceAnalysis(
  characterId: string,
  profile: {
    narrativePronoun: NonNullable<CharacterAsset['narrativePronoun']>
    ageAndBuild: string
    fixedTraits: string[]
    defaultLook: string
    wardrobe: string
  },
) {
  await storyDatabase.transaction('rw', storyDatabase.characters, async () => {
    const character = await storyDatabase.characters.get(characterId)
    if (!character) throw new Error('角色资产不存在')
    await storyDatabase.characters.update(characterId, {
      narrativePronoun: profile.narrativePronoun,
      identity: {
        ...character.identity,
        ageAndBuild: profile.ageAndBuild.trim(),
        fixedTraits: profile.fixedTraits.map((trait) => trait.trim()).filter(Boolean),
      },
      appearance: {
        ...character.appearance,
        defaultLook: profile.defaultLook.trim(),
        wardrobe: profile.wardrobe.trim(),
      },
      status: 'draft',
      portraitStatus: 'review',
      portraitError: undefined,
      updatedAt: Date.now(),
    })
  })
}

export async function confirmCharacterPortrait(characterId: string) {
  const character = await storyDatabase.characters.get(characterId)
  if (!character) throw new Error('角色资产不存在')
  if (!character.narrativePronoun) throw new Error('请先在角色档案中选择叙事代词，再确认参考图')
  await storyDatabase.characters.update(characterId, {
    status: 'confirmed',
    portraitStatus: 'confirmed',
    portraitError: undefined,
    updatedAt: Date.now(),
  })
}

export async function setIllustrationGenerating(illustrationId: string) {
  await storyDatabase.illustrations.update(illustrationId, {
    status: 'generating',
    errorMessage: undefined,
    updatedAt: Date.now(),
  })
}

export async function setIllustrationReady(illustrationId: string, imageUrl: string, localUri?: string) {
  await storyDatabase.illustrations.update(illustrationId, {
    status: 'ready',
    imageUrl,
    localUri,
    errorMessage: undefined,
    updatedAt: Date.now(),
  })
}

export async function setIllustrationFailed(illustrationId: string, message: string) {
  await storyDatabase.illustrations.update(illustrationId, {
    status: 'failed',
    imageUrl: undefined,
    localUri: undefined,
    errorMessage: message,
    updatedAt: Date.now(),
  })
}

export function getActiveProjectId() {
  return localStorage.getItem(ACTIVE_PROJECT_KEY)
}

export function setActiveProjectId(projectId: string) {
  localStorage.setItem(ACTIVE_PROJECT_KEY, projectId)
}
