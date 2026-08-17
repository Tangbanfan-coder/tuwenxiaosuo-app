import Dexie, { type Table, type Transaction } from 'dexie'
import {
  resolveIllustrationMode,
} from '../domain/models'
import type {
  Chapter,
  CharacterAsset,
  ContextBudget,
  ConversationMessage,
  Feedback,
  PreferenceSignal,
  WritingCandidate,
  PreferenceDimension,
  FeedbackBatchInput,
  FeedbackScope,
  FeedbackTargetInput,
  Foreshadowing,
  IllustrationStylePresetId,
  IllustrationAsset,
  IllustrationMode,
  ProjectStyle,
  ProseEvaluationEvent,
  ProjectWorkspace,
  ReferenceStyleMode,
  SceneNotes,
  StyleCorpusBinding,
  StyleCorpusFragment,
  StyleCorpusLabels,
  StyleCorpusSource,
  StoryProject,
  StoredParagraph,
  SummaryVersion,
  ThemePresetId,
  UpsertFeedbackInput,
  VisualPlan,
  WritingProseResult,
  WritingTurnResult,
} from '../domain/models'
import { DEFAULT_ILLUSTRATION_STYLE_ID, getIllustrationStylePreset } from '../domain/illustrationStyles'
import { resolveIllustrationReferences } from '../domain/illustrationReferences'
import { materializeWritingSceneNotes, reconcileForeshadowing } from '../domain/foreshadowing'
import { createParagraphFingerprint, hashText as hashTextImpl, normalizeText as normalizeParagraphText } from '../domain/paragraphs'
import { loadGlobalWritingInstructions } from '../providers/config'
import { detectProseStyleIssues, PROSE_STYLE_RULE_VERSION } from '../domain/proseStyle'

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
  preferenceSignals!: Table<PreferenceSignal, string>
  writingCandidates!: Table<WritingCandidate, string>
  styleCorpusSources!: Table<StyleCorpusSource, string>
  styleCorpusFragments!: Table<StyleCorpusFragment, string>
  styleCorpusBindings!: Table<StyleCorpusBinding, string>
  evaluationEvents!: Table<ProseEvaluationEvent, string>

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
    this.version(9).stores({
      projects: 'id, updatedAt, lastOpenedAt',
      messages: 'id, projectId, [projectId+order], createdAt, backgroundTaskId',
      chapters: 'id, projectId, [projectId+order], updatedAt',
      characters: 'id, projectId, [projectId+createdAt], status',
      illustrations: 'id, projectId, [projectId+createdAt], status',
      styles: 'id, &projectId, updatedAt',
      scenes: 'id, projectId, [projectId+order], createdAt',
      paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt',
      feedback: 'id, projectId, messageId, [projectId+messageId], &targetKey, [projectId+updatedAt], updatedAt',
    })
    this.version(10)
      .stores({
        projects: 'id, updatedAt, lastOpenedAt',
        messages: 'id, projectId, [projectId+order], createdAt, backgroundTaskId',
        chapters: 'id, projectId, [projectId+order], updatedAt',
        characters: 'id, projectId, [projectId+createdAt], status',
        illustrations: 'id, projectId, [projectId+createdAt], status',
        styles: 'id, &projectId, updatedAt',
        scenes: 'id, projectId, [projectId+order], createdAt',
        paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
        summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt',
        feedback: 'id, projectId, messageId, [projectId+messageId], &targetKey, [projectId+updatedAt], updatedAt',
        styleCorpusSources: 'id, &fingerprint, createdAt, updatedAt',
        styleCorpusFragments: 'id, sourceId, fingerprint, confirmed, usageCount, updatedAt',
        styleCorpusBindings: 'id, fragmentId, scope, projectId, state, [scope+state], [projectId+state], updatedAt',
      })
      .upgrade(async (transaction) => {
        await backfillStyleIssuesFromV9(transaction)
      })
    this.version(11).stores({
      projects: 'id, updatedAt, lastOpenedAt', messages: 'id, projectId, [projectId+order], createdAt, backgroundTaskId',
      chapters: 'id, projectId, [projectId+order], updatedAt', characters: 'id, projectId, [projectId+createdAt], status',
      illustrations: 'id, projectId, [projectId+createdAt], status', styles: 'id, &projectId, updatedAt',
      scenes: 'id, projectId, [projectId+order], createdAt',
      paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt',
      feedback: 'id, projectId, messageId, [projectId+messageId], &targetKey, [projectId+updatedAt], updatedAt',
      styleCorpusSources: 'id, &fingerprint, createdAt, updatedAt', styleCorpusFragments: 'id, sourceId, fingerprint, confirmed, usageCount, updatedAt',
      styleCorpusBindings: 'id, fragmentId, scope, projectId, state, [scope+state], [projectId+state], updatedAt',
      evaluationEvents: 'id, eventType, occurredAt, projectId, [projectId+occurredAt]',
    })
    this.version(12)
      .stores({
        projects: 'id, updatedAt, lastOpenedAt', messages: 'id, projectId, [projectId+order], createdAt, backgroundTaskId',
        chapters: 'id, projectId, [projectId+order], updatedAt', characters: 'id, projectId, [projectId+createdAt], status',
        illustrations: 'id, projectId, [projectId+createdAt], status', styles: 'id, &projectId, updatedAt',
        scenes: 'id, projectId, [projectId+order], createdAt',
        paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
        summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt',
        feedback: 'id, projectId, messageId, [projectId+messageId], &targetKey, [projectId+updatedAt], updatedAt',
        styleCorpusSources: 'id, &fingerprint, createdAt, updatedAt', styleCorpusFragments: 'id, sourceId, fingerprint, confirmed, usageCount, updatedAt',
        styleCorpusBindings: 'id, fragmentId, scope, projectId, state, [scope+state], [projectId+state], updatedAt',
        evaluationEvents: 'id, eventType, occurredAt, projectId, [projectId+occurredAt]',
      })
      .upgrade(async (transaction) => {
        await upgradeIllustrationModesFromV11(transaction)
      })
    // Optional fields on legacy records deliberately remain absent. New
    // preference signals are separate from feedback so old targets are never
    // mistaken for writing instructions.
    this.version(13).stores({
      projects: 'id, updatedAt, lastOpenedAt', messages: 'id, projectId, [projectId+order], createdAt, backgroundTaskId, turnId',
      chapters: 'id, projectId, [projectId+order], updatedAt', characters: 'id, projectId, [projectId+createdAt], status',
      illustrations: 'id, projectId, [projectId+createdAt], status, turnId', styles: 'id, &projectId, updatedAt',
      scenes: 'id, projectId, [projectId+order], createdAt, turnId',
      paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt',
      summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt',
      feedback: 'id, projectId, messageId, [projectId+messageId], &targetKey, [projectId+updatedAt], updatedAt',
      preferenceSignals: 'id, projectId, feedbackId, fingerprint, [projectId+updatedAt], updatedAt',
      styleCorpusSources: 'id, &fingerprint, createdAt, updatedAt', styleCorpusFragments: 'id, sourceId, fingerprint, confirmed, usageCount, updatedAt',
      styleCorpusBindings: 'id, fragmentId, scope, projectId, state, [scope+state], [projectId+state], updatedAt',
      evaluationEvents: 'id, eventType, occurredAt, projectId, [projectId+occurredAt]',
    })
    this.version(14).stores({
      projects: 'id, updatedAt, lastOpenedAt', messages: 'id, projectId, [projectId+order], createdAt, backgroundTaskId, turnId',
      chapters: 'id, projectId, [projectId+order], updatedAt', characters: 'id, projectId, [projectId+createdAt], status', illustrations: 'id, projectId, [projectId+createdAt], status, turnId', styles: 'id, &projectId, updatedAt', scenes: 'id, projectId, [projectId+order], createdAt, turnId', paragraphs: 'id, projectId, sourceType, [projectId+sourceType], [projectId+chapterId], [projectId+messageId], fingerprint, createdAt', summaryVersions: 'id, projectId, chapterId, [projectId+chapterId], &[projectId+chapterId+version], createdAt', feedback: 'id, projectId, messageId, [projectId+messageId], &targetKey, [projectId+updatedAt], updatedAt', preferenceSignals: 'id, projectId, feedbackId, fingerprint, [projectId+updatedAt], updatedAt', writingCandidates: 'id, projectId, turnId, proseMessageId, [projectId+turnId], [projectId+updatedAt], updatedAt', styleCorpusSources: 'id, &fingerprint, createdAt, updatedAt', styleCorpusFragments: 'id, sourceId, fingerprint, confirmed, usageCount, updatedAt', styleCorpusBindings: 'id, fragmentId, scope, projectId, state, [scope+state], [projectId+state], updatedAt', evaluationEvents: 'id, eventType, occurredAt, projectId, [projectId+occurredAt]',
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
  turnId?: string
}

export const storyDatabase = new StoryDatabase()

async function upgradeIllustrationModesFromV11(transaction: Transaction) {
  const projects = transaction.table('projects') as Table<StoryProject, string>
  const illustrations = transaction.table('illustrations') as Table<IllustrationAsset, string>
  const legacyProjects = await projects.toArray()
  const modes = new Map(legacyProjects.map((project) => [project.id, resolveIllustrationMode(project)]))
  await Promise.all(legacyProjects.map((project) => (
    projects.where('id').equals(project.id).modify((record) => {
      record.illustrationMode = modes.get(project.id) ?? 'auto'
      delete record.autoIllustrate
    })
  )))
  const legacyIllustrations = await illustrations.toArray()
  await Promise.all(legacyIllustrations.map((illustration) => {
    if (illustration.generationMode) return undefined
    return illustrations.update(illustration.id, {
      generationMode: modes.get(illustration.projectId) === 'manual' ? 'manual' : 'auto',
    })
  }))
}

const EVALUATION_MAX_EVENTS = 5000
const EVALUATION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export async function recordProseEvaluationEvent(event: Omit<ProseEvaluationEvent, 'id' | 'occurredAt' | 'schemaVersion' | 'appVersion' | 'databaseVersion'> & Partial<Pick<ProseEvaluationEvent, 'occurredAt'>>) {
  const occurredAt = event.occurredAt ?? Date.now()
  await storyDatabase.transaction('rw', storyDatabase.evaluationEvents, async () => {
    if (event.eventType === 'prose_analyzed' && event.paragraphId) {
      const duplicate = await storyDatabase.evaluationEvents.filter((item) => (
        item.eventType === 'prose_analyzed' && item.paragraphId === event.paragraphId && item.proseRuleVersion === event.proseRuleVersion
      )).first()
      if (duplicate) return
    }
    await storyDatabase.evaluationEvents.add({ ...event, id: createId('evaluation'), occurredAt, schemaVersion: 1, appVersion: '0.1.0', databaseVersion: 14, proseRuleVersion: event.proseRuleVersion ?? PROSE_RULE_VERSION_FALLBACK })
    await storyDatabase.evaluationEvents.where('occurredAt').below(occurredAt - EVALUATION_MAX_AGE_MS).delete()
    const count = await storyDatabase.evaluationEvents.count()
    if (count > EVALUATION_MAX_EVENTS) {
      const overflow = await storyDatabase.evaluationEvents.orderBy('occurredAt').limit(count - EVALUATION_MAX_EVENTS).primaryKeys()
      await storyDatabase.evaluationEvents.bulkDelete(overflow)
    }
  })
}

const PROSE_RULE_VERSION_FALLBACK = 1

export async function listProseEvaluationEvents() { return storyDatabase.evaluationEvents.orderBy('occurredAt').toArray() }
export async function clearProseEvaluationEvents() { await storyDatabase.evaluationEvents.clear() }
export async function clearProseEvaluationEventsByIds(ids: readonly string[]) { if (ids.length) await storyDatabase.evaluationEvents.bulkDelete([...ids]) }

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

  const issues = detectProseStyleIssues(message.paragraphs)

  return message.paragraphs.map((text, index) => ({
    id: `paragraph-message-${message.id}-${index}`,
    projectId: message.projectId,
    sourceType: 'message',
    messageId: message.id,
    chapterId: message.chapterId!,
    index,
    text,
    fingerprint: createParagraphFingerprint(text),
    styleIssues: issues[index],
    styleRuleVersion: PROSE_STYLE_RULE_VERSION,
    createdAt,
  }))
}

async function backfillStyleIssuesFromV9(transaction: Transaction) {
  const messageTable = transaction.table('messages') as Table<ConversationMessage, string>
  const paragraphTable = transaction.table('paragraphs') as Table<StoredParagraph, string>
  await messageTable.toCollection().each(async (message) => {
    if (message.kind !== 'prose') return
    const expected = createMessageParagraphRecords(message)
    if (!expected.length) return
    const stored = await paragraphTable.bulkGet(expected.map((paragraph) => paragraph.id))
    await paragraphTable.bulkPut(expected.map((paragraph, index) => ({
      ...(stored[index] ?? paragraph),
      styleIssues: paragraph.styleIssues,
      styleRuleVersion: paragraph.styleRuleVersion,
    })))
  })
}

function emptyStyleCorpusLabels(): StyleCorpusLabels {
  return {
    genres: [], sceneTypes: [], pace: [], techniques: [], emotionalTone: [], imitate: [], avoid: [],
  }
}

function normalizeStyleCorpusLabels(labels: Partial<StyleCorpusLabels> | undefined): StyleCorpusLabels {
  const confidence = typeof labels?.confidence === 'number' && Number.isFinite(labels.confidence)
    ? Math.max(0, Math.min(1, labels.confidence))
    : undefined
  return {
    genres: stringArray(labels?.genres),
    sceneTypes: stringArray(labels?.sceneTypes),
    pov: optionalString(labels?.pov),
    narrativeDistance: optionalString(labels?.narrativeDistance),
    pace: stringArray(labels?.pace),
    techniques: stringArray(labels?.techniques),
    emotionalTone: stringArray(labels?.emotionalTone),
    imitate: stringArray(labels?.imitate),
    avoid: stringArray(labels?.avoid),
    confidence,
  }
}

export interface StyleCorpusDraftParagraph {
  id: string
  text: string
  fingerprint: string
}

export interface StyleCorpusDraftFragment {
  id: string
  paragraphIds: string[]
  text: string
  fingerprint: string
  labels: StyleCorpusLabels
}

/** Deterministic import boundary: headings and blank lines only, never model-authored text. */
export function splitStyleCorpusText(rawText: string) {
  const normalized = rawText.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const blocks = normalized.split(/\n\s*\n+/).flatMap((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    return lines.length > 1 && lines.every((line) => line.length >= 20) ? lines : [lines.join('\n')]
  }).filter((text) => text && !/^(?:第[一二三四五六七八九十百千0-9]+[章节回卷]|chapter\s+\d+)/i.test(text))
  return blocks.map((text, index): StyleCorpusDraftParagraph => ({
    id: `import-paragraph-${hashTextImpl(`${index}:${text}`)}`,
    text,
    fingerprint: createParagraphFingerprint(text),
  }))
}

export function createStyleCorpusDraftFragments(rawText: string): StyleCorpusDraftFragment[] {
  return splitStyleCorpusText(rawText).map((paragraph) => ({
    id: `import-fragment-${paragraph.fingerprint}`,
    paragraphIds: [paragraph.id],
    text: paragraph.text,
    fingerprint: paragraph.fingerprint,
    labels: emptyStyleCorpusLabels(),
  }))
}

export async function saveStyleCorpusImport(input: {
  title: string
  rawText: string
  fragments: Array<Pick<StyleCorpusDraftFragment, 'paragraphIds' | 'text' | 'fingerprint'> & {
    suggestedLabels?: Partial<StyleCorpusLabels>
    labels?: Partial<StyleCorpusLabels>
  }>
}) {
  const title = input.title.trim() || '未命名语料'
  const rawText = input.rawText.replace(/\r\n?/g, '\n').trim()
  if (!rawText) throw new Error('请先导入语料文本')
  if (!input.fragments.length) throw new Error('没有可保存的语料片段')
  const now = Date.now()
  const sourceFingerprint = hashTextImpl(rawText)
  const existing = await storyDatabase.styleCorpusSources.where('fingerprint').equals(sourceFingerprint).first()
  if (existing) throw new Error('这份语料已经导入')
  const source: StyleCorpusSource = {
    id: createId('style-source'), title, rawText, fingerprint: sourceFingerprint, createdAt: now, updatedAt: now,
  }
  const sourceParagraphs = splitStyleCorpusText(rawText)
  const sourceParagraphById = new Map(sourceParagraphs.map((paragraph) => [paragraph.id, paragraph]))
  const usedParagraphIds = new Set<string>()
  const fragments = input.fragments.map((draft, index): StyleCorpusFragment => {
    const paragraphIds = Array.from(new Set(draft.paragraphIds))
    const selected = paragraphIds.map((id) => sourceParagraphById.get(id))
    if (!selected.length || selected.some((paragraph) => !paragraph)) throw new Error(`第 ${index + 1} 个片段引用了无效原文段落`)
    if (paragraphIds.some((id) => usedParagraphIds.has(id))) throw new Error('同一原文段落不能重复保存到多个片段')
    const sourceIndexes = paragraphIds.map((id) => sourceParagraphs.findIndex((paragraph) => paragraph.id === id))
    if (sourceIndexes.some((value, itemIndex) => itemIndex > 0 && value !== sourceIndexes[itemIndex - 1] + 1)) throw new Error('一个语料片段只能组合相邻的原文段落')
    paragraphIds.forEach((id) => usedParagraphIds.add(id))
    const text = selected.map((paragraph) => paragraph!.text).join('\n\n')
    return {
      id: createId('style-fragment'), sourceId: source.id,
      paragraphIds, text,
      fingerprint: createParagraphFingerprint(text),
      suggestedLabels: draft.suggestedLabels ? normalizeStyleCorpusLabels(draft.suggestedLabels) : undefined,
      labels: normalizeStyleCorpusLabels(draft.labels ?? draft.suggestedLabels),
      confirmed: true, usageCount: 0, createdAt: now, updatedAt: now,
    }
  })
  if (usedParagraphIds.size !== sourceParagraphs.length) throw new Error('保存分组必须覆盖全部原文段落')
  const bindings = fragments.map((fragment): StyleCorpusBinding => ({
    id: createId('style-binding'), fragmentId: fragment.id, scope: 'global', state: 'enabled', weight: 1, createdAt: now, updatedAt: now,
  }))
  await storyDatabase.transaction('rw', [storyDatabase.styleCorpusSources, storyDatabase.styleCorpusFragments, storyDatabase.styleCorpusBindings], async () => {
    await storyDatabase.styleCorpusSources.add(source)
    await storyDatabase.styleCorpusFragments.bulkAdd(fragments)
    await storyDatabase.styleCorpusBindings.bulkAdd(bindings)
  })
  return { source, fragments, bindings }
}

export async function listStyleCorpusSources() {
  return storyDatabase.styleCorpusSources.orderBy('updatedAt').reverse().toArray()
}

export async function listStyleCorpusFragments() {
  return storyDatabase.styleCorpusFragments.orderBy('updatedAt').reverse().toArray()
}

export async function getStyleCorpusSummary() {
  const [sourceCount, fragmentCount] = await Promise.all([
    storyDatabase.styleCorpusSources.count(),
    storyDatabase.styleCorpusFragments.filter((fragment) => fragment.confirmed).count(),
  ])
  return { sourceCount, fragmentCount }
}

export async function deleteStyleCorpusSource(sourceId: string) {
  await storyDatabase.transaction('rw', [storyDatabase.styleCorpusSources, storyDatabase.styleCorpusFragments, storyDatabase.styleCorpusBindings], async () => {
    const fragmentIds = await storyDatabase.styleCorpusFragments.where('sourceId').equals(sourceId).primaryKeys()
    if (fragmentIds.length) {
      await storyDatabase.styleCorpusBindings.where('fragmentId').anyOf(fragmentIds).delete()
      await storyDatabase.styleCorpusFragments.bulkDelete(fragmentIds)
    }
    await storyDatabase.styleCorpusSources.delete(sourceId)
  })
}

export async function updateStyleCorpusFragment(fragmentId: string, labels: Partial<StyleCorpusLabels>) {
  const existing = await storyDatabase.styleCorpusFragments.get(fragmentId)
  if (!existing) throw new Error('语料片段不存在')
  await storyDatabase.styleCorpusFragments.update(fragmentId, {
    labels: normalizeStyleCorpusLabels(labels), confirmed: true, updatedAt: Date.now(),
  })
}

export async function listMessageParagraphsWithCurrentStyleIssues(projectId: string, messageId: string) {
  return storyDatabase.transaction('rw', [storyDatabase.messages, storyDatabase.paragraphs], async () => {
    const message = await storyDatabase.messages.get(messageId)
    if (!message || message.projectId !== projectId || message.kind !== 'prose') return []
    const expected = createMessageParagraphRecords(message)
    if (!expected.length) return []
    const stored = await storyDatabase.paragraphs.bulkGet(expected.map((paragraph) => paragraph.id))
    const rows = expected.map((paragraph, index) => {
      const current = stored[index]
      const exact = current
        && current.projectId === paragraph.projectId
        && current.messageId === paragraph.messageId
        && current.chapterId === paragraph.chapterId
        && current.index === paragraph.index
        && current.text === paragraph.text
        && current.fingerprint === paragraph.fingerprint
      return exact && current.styleRuleVersion === PROSE_STYLE_RULE_VERSION
        ? current
        : { ...paragraph, createdAt: exact ? current.createdAt : paragraph.createdAt }
    })
    const staleRows = rows.filter((row, index) => row !== stored[index])
    if (staleRows.length) await storyDatabase.paragraphs.bulkPut(staleRows)
    return rows
  })
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

async function appendGeneratedChapterSummaryVersion(chapter: Chapter, summary: string, createdAt: number, turnId?: string) {
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
    turnId,
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
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.paragraphs, storyDatabase.feedback, storyDatabase.preferenceSignals],
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
      await storyDatabase.preferenceSignals.where('feedbackId').equals(existing.id).delete()
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
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.paragraphs, storyDatabase.feedback, storyDatabase.preferenceSignals],
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
        await storyDatabase.preferenceSignals.where('feedbackId').equals(existing.id).delete()
        return null
      }

      const updated = updateFeedbackRecord(existing, payload, now)
      await storyDatabase.feedback.put(updated)
      await storyDatabase.preferenceSignals.where('feedbackId').equals(existing.id).delete()
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
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.paragraphs, storyDatabase.feedback, storyDatabase.preferenceSignals],
    async () => {
      const changed: Feedback[] = []
      for (const targetInput of input.targets) {
        const target = await resolveFeedbackTarget(targetInput)
        const existing = await findFeedbackForTarget(target)
        if (existing?.verdict === payload.verdict) {
          await storyDatabase.feedback.delete(existing.id)
          await storyDatabase.preferenceSignals.where('feedbackId').equals(existing.id).delete()
          continue
        }
        if (existing) {
          const updated = updateFeedbackRecord(existing, payload, now)
          await storyDatabase.feedback.put(updated)
          await storyDatabase.preferenceSignals.where('feedbackId').equals(existing.id).delete()
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
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.paragraphs, storyDatabase.feedback, storyDatabase.preferenceSignals],
    async () => {
      const target = await resolveFeedbackTarget(input)
      const existing = await findFeedbackForTarget(target)
      if (!existing) return false
      await storyDatabase.feedback.delete(existing.id)
      await storyDatabase.preferenceSignals.where('feedbackId').equals(existing.id).delete()
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

export async function listRecentPreferenceSignals(projectIdValue: string, limit = 8) {
  const projectId = requiredFeedbackString(projectIdValue, '作品 ID')
  const ordered = (await storyDatabase.preferenceSignals.where('projectId').equals(projectId).toArray())
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  const fingerprints = new Set<string>()
  return ordered.filter((signal) => {
    if (fingerprints.has(signal.fingerprint)) return false
    fingerprints.add(signal.fingerprint)
    return true
  }).slice(0, limit)
}

export async function getLatestRegenerableWritingTurn(projectId: string) {
  const prose = await storyDatabase.messages.where('projectId').equals(projectId).filter((item) => item.kind === 'prose' && Boolean(item.turnId) && Boolean(item.chapterId) && Boolean(item.paragraphs?.length)).sortBy('order')
  const target = prose.at(-1)
  if (!target?.turnId || !target.chapterId) return undefined
  const all = await storyDatabase.messages.where('projectId').equals(projectId).sortBy('order')
  const laterMessages = all.filter((item) => item.order > target.order)
  if (laterMessages.some((item) => item.turnId !== target.turnId || item.kind !== 'illustration')) return undefined
  const chapter = await storyDatabase.chapters.get(target.chapterId)
  const user = all.find((item) => item.turnId === target.turnId && item.kind === 'user')
  const notice = all.find((item) => item.turnId === target.turnId && item.kind === 'notice' && item.status === 'ready')
  const proseText = (target.paragraphs ?? []).join('\n\n')
  if (!chapter || !user?.text || !notice || !chapter.content.endsWith(proseText)) return undefined
  const baseChapterContent = chapter.content.slice(0, chapter.content.length - proseText.length).trimEnd()
  const baseChapterSummary = (await readChapterSummaryVersions(projectId, chapter.id))
    .filter((version) => version.turnId !== target.turnId)
    .at(-1)?.summary
  return {
    prose: target,
    chapter,
    user,
    notice,
    baseChapterHash: hashTextImpl(chapter.content),
    baseChapterContent,
    baseChapterSummary,
    baseParagraphCount: splitChapterContent(baseChapterContent).length,
  }
}

export async function saveWritingCandidate(input: Omit<WritingCandidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>) {
  const now = Date.now()
  const candidate: WritingCandidate = { ...input, id: createId('candidate'), status: 'ready', createdAt: now, updatedAt: now }
  await storyDatabase.writingCandidates.where('[projectId+turnId]').equals([input.projectId, input.turnId]).delete()
  await storyDatabase.writingCandidates.add(candidate)
  return candidate
}

export async function getWritingCandidate(projectId: string, turnId: string) {
  return storyDatabase.writingCandidates.where('[projectId+turnId]').equals([projectId, turnId]).filter((item) => item.status === 'ready').first()
}

export async function discardWritingCandidate(projectId: string, turnId: string) {
  await storyDatabase.writingCandidates.where('[projectId+turnId]').equals([projectId, turnId]).delete()
}

/**
 * Stores a future-facing preference separately from its reviewed prose. This
 * deliberately never accepts source prose, paragraph ids, or names: those
 * belong to the feedback target and must not leak into the next prompt.
 */
export async function upsertPreferenceSignal(input: {
  feedbackId: string
  projectId: string
  verdict: Feedback['verdict']
  dimension: PreferenceDimension
  instruction: string
  source: PreferenceSignal['source']
}) {
  const instruction = input.instruction.trim().replace(/\s+/g, ' ').slice(0, 180)
  if (!instruction) throw new Error('偏好说明不能为空')
  if (!/^(?:后续|继续|避免|少用|多用|保持|让)/.test(instruction)) throw new Error('偏好说明需要描述后续写作方式')
  const now = Date.now()
  return storyDatabase.transaction('rw', [storyDatabase.feedback, storyDatabase.preferenceSignals], async () => {
    const feedback = await storyDatabase.feedback.get(input.feedbackId)
    if (!feedback || feedback.projectId !== input.projectId || feedback.verdict !== input.verdict) throw new Error('反馈已变化，请重新提交')
    const fingerprint = hashTextImpl(`${input.verdict}:${input.dimension}:${instruction}`)
    const existing = await storyDatabase.preferenceSignals.where('feedbackId').equals(input.feedbackId)
      .filter((signal) => signal.fingerprint === fingerprint).first()
    const signal: PreferenceSignal = {
      id: existing?.id ?? createId('preference'), projectId: input.projectId, feedbackId: feedback.id,
      verdict: input.verdict, dimension: input.dimension, instruction, source: input.source,
      fingerprint, createdAt: existing?.createdAt ?? now, updatedAt: now,
    }
    await storyDatabase.preferenceSignals.put(signal)
    return signal
  })
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
    illustrationMode: 'auto',
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
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.characters, storyDatabase.illustrations, storyDatabase.styles, storyDatabase.scenes, storyDatabase.paragraphs, storyDatabase.summaryVersions, storyDatabase.feedback, storyDatabase.preferenceSignals, storyDatabase.writingCandidates, storyDatabase.styleCorpusBindings],
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
        storyDatabase.preferenceSignals.where('projectId').equals(projectId).delete(),
        storyDatabase.writingCandidates.where('projectId').equals(projectId).delete(),
        storyDatabase.styleCorpusBindings.where('projectId').equals(projectId).delete(),
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

export async function updateIllustrationMode(projectId: string, illustrationMode: IllustrationMode) {
  await storyDatabase.projects.update(projectId, { illustrationMode, updatedAt: Date.now() })
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

function writingNoticeText(mode: IllustrationMode, retry = false) {
  const prefix = retry ? '正在重新生成正文' : '正在创作正文'
  return mode === 'none' ? `${prefix}…` : `${prefix}并整理视觉计划…`
}

function illustrationModeInput(mode: IllustrationMode | boolean): IllustrationMode {
  return typeof mode === 'boolean' ? (mode ? 'auto' : 'manual') : mode
}

export async function beginWritingTurn(projectId: string, text: string, mode: IllustrationMode | boolean, chapterId?: string) {
  const illustrationMode = illustrationModeInput(mode)
  const now = Date.now()
  const nextOrder = (await getLastMessageOrder(projectId)) + 1
  const userMessageId = createId('message')
  const turnId = createId('turn')
  const messages: ConversationMessage[] = [
    {
      id: userMessageId,
      projectId,
      chapterId,
      kind: 'user',
      order: nextOrder,
      createdAt: now,
      text,
      turnId,
    },
    {
      id: createId('message'),
      projectId,
      chapterId,
      kind: 'notice',
      order: nextOrder + 1,
      createdAt: now + 1,
      text: writingNoticeText(illustrationMode),
      status: 'pending',
      userMessageId,
      turnId,
    },
  ]

  await storyDatabase.transaction('rw', [storyDatabase.messages, storyDatabase.projects], async () => {
    await storyDatabase.messages.bulkAdd(messages)
    await storyDatabase.projects.update(projectId, { illustrationMode, updatedAt: now })
  })
  return messages
}

export async function applyParagraphRewrite(input: {
  projectId: string
  messageId: string
  paragraphId: string
  paragraphIndex: number
  originalFingerprint: string
  rewrittenText: string
}) {
  const rewrittenText = input.rewrittenText.trim()
  if (!rewrittenText) throw new Error('建议稿不能为空')
  const now = Date.now()
  return storyDatabase.transaction(
    'rw',
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.paragraphs],
    async () => {
      const message = await storyDatabase.messages.get(input.messageId)
      if (!message || message.projectId !== input.projectId || message.kind !== 'prose' || !message.chapterId || !message.paragraphs) {
        throw new Error('正文消息不存在或不属于当前作品')
      }
      const paragraph = await storyDatabase.paragraphs.get(input.paragraphId)
      const currentText = message.paragraphs[input.paragraphIndex]
      if (
        !paragraph
        || paragraph.projectId !== input.projectId
        || paragraph.messageId !== input.messageId
        || paragraph.chapterId !== message.chapterId
        || paragraph.index !== input.paragraphIndex
        || paragraph.text !== currentText
        || paragraph.fingerprint !== input.originalFingerprint
        || createParagraphFingerprint(currentText) !== input.originalFingerprint
      ) throw new Error('正文已发生变化，请重新生成建议稿')

      const chapter = await storyDatabase.chapters.get(message.chapterId)
      if (!chapter || chapter.projectId !== input.projectId) throw new Error('正文所属章节不存在')
      const chapterMessages = await storyDatabase.messages
        .where('projectId').equals(input.projectId)
        .filter((item) => item.chapterId === chapter.id && item.kind === 'prose' && Array.isArray(item.paragraphs))
        .sortBy('order')
      const indexedMessageParagraphCount = chapterMessages.reduce((count, item) => count + (item.paragraphs?.length ?? 0), 0)
      const chapterParagraphs = splitChapterContent(chapter.content)
      const unindexedChapterPrefixCount = chapterParagraphs.length - indexedMessageParagraphCount
      if (unindexedChapterPrefixCount < 0) throw new Error('章节正文与消息段落数量不一致，未应用建议稿')
      const priorParagraphCount = chapterMessages
        .filter((item) => item.order < message.order)
        .reduce((count, item) => count + (item.paragraphs?.length ?? 0), 0)
      const chapterParagraphIndex = unindexedChapterPrefixCount + priorParagraphCount + input.paragraphIndex
      if (chapterParagraphs[chapterParagraphIndex] !== currentText) throw new Error('章节正文与段落索引不一致，未应用建议稿')

      const nextMessageParagraphs = message.paragraphs.slice()
      nextMessageParagraphs[input.paragraphIndex] = rewrittenText
      chapterParagraphs[chapterParagraphIndex] = rewrittenText
      const nextChapter: Chapter = { ...chapter, content: chapterParagraphs.join('\n\n'), updatedAt: now }
      const messageIssues = detectProseStyleIssues(nextMessageParagraphs)
      await storyDatabase.messages.update(message.id, { paragraphs: nextMessageParagraphs })
      const messageParagraphs = createMessageParagraphRecords({ ...message, paragraphs: nextMessageParagraphs }, message.createdAt)
        .map((row, index) => ({ ...row, styleIssues: messageIssues[index] }))
      await storyDatabase.paragraphs.bulkPut(messageParagraphs)
      await storyDatabase.chapters.put(nextChapter)
      await upsertChapterParagraphs(nextChapter)
      await storyDatabase.projects.update(input.projectId, { updatedAt: now })
      return { message: { ...message, paragraphs: nextMessageParagraphs }, chapter: nextChapter }
    },
  )
}

export async function setWritingTurnBackgroundTask(noticeId: string, taskId: string) {
  const notice = await storyDatabase.messages.get(noticeId)
  if (!notice || notice.kind !== 'notice' || notice.status !== 'pending') return false
  await storyDatabase.messages.update(noticeId, { backgroundTaskId: taskId })
  return true
}

export async function listPendingWritingBackgroundTasks() {
  return storyDatabase.messages.where('backgroundTaskId').notEqual('').filter((message) => (
    message.kind === 'notice' && message.status === 'pending' && Boolean(message.backgroundTaskId)
  )).toArray()
}

/** Native metadata recovery must also see notices whose task link never made it to IndexedDB. */
export async function getWritingNotice(noticeId: string) {
  const notice = await storyDatabase.messages.get(noticeId)
  return notice?.kind === 'notice' ? notice : undefined
}

function materializeSceneNotesForResult(result: WritingProseResult, priorScenes: readonly StoredScene[]) {
  const sceneNotes = result.sceneNotes
    ? materializeWritingSceneNotes(result.sceneNotes, priorScenes.map((scene) => scene.notes))
    : emptySceneNotes()
  const validPriorSceneIds = new Set(priorScenes.map((scene) => scene.id))
  const evidenceIds = result.sceneNotes?.priorSceneEvidenceIds ?? []
  if (evidenceIds.some((id) => !validPriorSceneIds.has(id))) throw new Error('前史引用证据不属于当前作品，未保存本轮正文')
  const hasPriorHistoryMarker = /(?:上次|以前|又一次|再次|还记得|像从前|当年|那一次|那回|曾经)/.test(result.paragraphs.join('\n\n'))
  if (hasPriorHistoryMarker && evidenceIds.length === 0) {
    sceneNotes.unresolvedThreads = [...sceneNotes.unresolvedThreads, '需核对：本轮出现了未提供场景证据的既往事件引用。']
  }
  return sceneNotes
}

async function materializeVisualPlanForTurn(input: {
  projectId: string
  targetChapter: Chapter
  visualPlan: VisualPlan | undefined
  illustrationMode: IllustrationMode
  turnId: string | undefined
  messageOrder: number
  now: number
}) {
  const { projectId, targetChapter, visualPlan, illustrationMode, turnId, messageOrder, now } = input
  if (illustrationMode === 'none' || !visualPlan) return undefined

  const referenceCharacterIds: string[] = []
  for (const characterPlan of visualPlan.characters) {
    const existingCharacters = await storyDatabase.characters.where('projectId').equals(projectId).toArray()
    const existing = existingCharacters.find((character) => character.name.toLocaleLowerCase() === characterPlan.name.toLocaleLowerCase())
    if (existing) {
      referenceCharacterIds.push(existing.id)
      if (existing.status === 'draft') {
        const nextRole = existing.role || characterPlan.role
        const nextNarrativePronoun = existing.narrativePronoun ?? characterPlan.narrativePronoun
        const nextAgeAndBuild = existing.identity.ageAndBuild || characterPlan.ageAndBuild
        const nextFixedTraits = existing.identity.fixedTraits.length ? existing.identity.fixedTraits : characterPlan.fixedTraits
        const nextDefaultLook = existing.appearance.defaultLook || characterPlan.defaultLook
        const nextWardrobe = existing.appearance.wardrobe || characterPlan.wardrobe
        if (
          nextRole !== existing.role
          || nextNarrativePronoun !== existing.narrativePronoun
          || nextAgeAndBuild !== existing.identity.ageAndBuild
          || nextFixedTraits !== existing.identity.fixedTraits
          || nextDefaultLook !== existing.appearance.defaultLook
          || nextWardrobe !== existing.appearance.wardrobe
        ) {
          await storyDatabase.characters.update(existing.id, {
            role: nextRole,
            narrativePronoun: nextNarrativePronoun,
            identity: { ageAndBuild: nextAgeAndBuild, fixedTraits: nextFixedTraits },
            appearance: { defaultLook: nextDefaultLook, wardrobe: nextWardrobe },
            updatedAt: now,
          })
        }
      }
      continue
    }
    const characterId = createId('character')
    await storyDatabase.characters.add({
      id: characterId,
      projectId,
      name: characterPlan.name,
      role: characterPlan.role,
      narrativePronoun: characterPlan.narrativePronoun,
      identity: { ageAndBuild: characterPlan.ageAndBuild, fixedTraits: characterPlan.fixedTraits },
      appearance: { defaultLook: characterPlan.defaultLook, wardrobe: characterPlan.wardrobe },
      continuity: { revision: 0, referenceStyleMode: 'project' },
      portraitStatus: 'planned',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      turnId,
    })
    referenceCharacterIds.push(characterId)
  }

  const illustrationId = createId('illustration')
  const illustrationMessageId = createId('message')
  const illustration: IllustrationAsset = {
    id: illustrationId,
    projectId,
    chapterId: targetChapter.id,
    messageId: illustrationMessageId,
    title: visualPlan.title,
    prompt: visualPlan.prompt,
    sceneStylePrompt: visualPlan.stylePrompt,
    sceneNegativePrompt: visualPlan.negativePrompt,
    action: visualPlan.action,
    bodyLanguage: visualPlan.bodyLanguage,
    expression: visualPlan.expression,
    gaze: visualPlan.gaze,
    camera: visualPlan.camera,
    motion: visualPlan.motion,
    sceneAnchor: visualPlan.sceneAnchor,
    referenceCharacterIds,
    generationMode: illustrationMode,
    status: 'planned',
    createdAt: now,
    updatedAt: now,
    turnId,
  }
  const allProjectCharacters = await storyDatabase.characters.where('projectId').equals(projectId).toArray()
  const referenceResolution = resolveIllustrationReferences(illustration, allProjectCharacters)
  if (!referenceResolution.ready) {
    illustration.status = 'failed'
    illustration.errorMessage = referenceResolution.reason
    illustration.failureKind = 'reference-unavailable'
  }
  await storyDatabase.illustrations.add(illustration)
  await storyDatabase.messages.add({
    id: illustrationMessageId,
    projectId,
    chapterId: targetChapter.id,
    kind: 'illustration',
    order: messageOrder,
    createdAt: now + 1,
    title: illustration.title,
    illustrationId,
    status: 'ready',
    turnId,
  })
  return illustration
}

export async function completeWritingTurn(
  projectId: string,
  userMessageId: string,
  noticeId: string,
  result: WritingTurnResult,
  mode: IllustrationMode | boolean,
  forceNewChapter = false,
  expectedBackgroundTaskId?: string,
) {
  const illustrationMode = illustrationModeInput(mode)
  const now = Date.now()
  if (result.kind === 'assistant-only') {
    // A collaboration-only turn never creates chapters, scenes, prose,
    // summaries or visual plans. It only resolves the notice.
    await storyDatabase.transaction('rw', [storyDatabase.messages, storyDatabase.projects], async () => {
      const notice = await storyDatabase.messages.get(noticeId)
      if (!notice || notice.projectId !== projectId || notice.kind !== 'notice') throw new Error('写作任务不存在')
      if (notice.status === 'ready') return
      if (notice.status !== 'pending') throw new Error('写作任务已经结束，不能重复消费结果')
      if (expectedBackgroundTaskId && notice.backgroundTaskId !== expectedBackgroundTaskId) throw new Error('后台写作结果不属于当前任务')
      await storyDatabase.messages.update(noticeId, { text: result.assistantNote, status: 'ready' })
      await storyDatabase.projects.update(projectId, { updatedAt: now })
    })
    return
  }
      const generatedSummary = result.chapterSummary?.trim() || undefined
  await storyDatabase.transaction(
    'rw',
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.characters, storyDatabase.illustrations, storyDatabase.scenes, storyDatabase.paragraphs, storyDatabase.summaryVersions],
    async () => {
      const project = await storyDatabase.projects.get(projectId)
      if (!project) throw new Error('当前作品不存在')
      const notice = await storyDatabase.messages.get(noticeId)
      // A native response can survive a process death after this transaction
      // commits but before it is acknowledged. The ready notice is the stable,
      // transactionally committed consumption marker.
      if (!notice || notice.projectId !== projectId || notice.kind !== 'notice') throw new Error('写作任务不存在')
      if (notice.status === 'ready') return
      if (notice.status !== 'pending') throw new Error('写作任务已经结束，不能重复消费结果')
      if (expectedBackgroundTaskId && notice.backgroundTaskId !== expectedBackgroundTaskId) throw new Error('后台写作结果不属于当前任务')
      let nextOrder = (await getLastMessageOrder(projectId)) + 1

      const chapters = await storyDatabase.chapters.where('projectId').equals(projectId).sortBy('order')
      const activeChapter = project.activeChapterId
        ? chapters.find((chapter) => chapter.id === project.activeChapterId)
        : chapters[chapters.length - 1]
      let targetChapter: Chapter

      // A continuation should advance the story, not append a regenerated
      // copy of its tail. Exact paragraph and long normalized suffix matches
      // are rejected before any side effect in this transaction.
      if (!forceNewChapter && result.chapterAction === 'continue' && activeChapter?.content) {
        const existing = normalizeParagraphText(activeChapter.content)
        const generated = normalizeParagraphText(result.paragraphs.join('\n\n'))
        const tail = existing.slice(-Math.min(existing.length, 1_200))
        if (generated.length >= 80 && (existing.includes(generated) || tail.length >= 80 && generated.includes(tail))) {
          throw new Error('生成内容与已有正文高度重合，未追加。请调整要求后重试。')
        }
      }

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
      const sceneNotes = materializeSceneNotesForResult(result, priorScenes)
      await storyDatabase.scenes.add({
        id: createId('scene'),
        projectId,
        chapterId: targetChapter.id,
        order: nextSceneOrder,
        createdAt: now,
        notes: sceneNotes,
        excerpt: result.paragraphs.join('\n\n').slice(-6_000),
        turnId: notice.turnId,
      })

      await storyDatabase.messages.update(userMessageId, { chapterId: targetChapter.id })
      await storyDatabase.messages.update(noticeId, {
        chapterId: targetChapter.id,
        text: result.assistantNote,
        status: 'ready',
        turnId: notice.turnId,
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
        turnId: notice.turnId,
      }
      await storyDatabase.messages.add(proseMessage)
      await upsertMessageParagraphs(proseMessage)
      await upsertChapterParagraphs(targetChapter)
      if (generatedSummary) await appendGeneratedChapterSummaryVersion(targetChapter, generatedSummary, now, notice.turnId)

      // Text-only mode must remain robust even if a non-conforming provider
      // returns a visual plan despite receiving the text-only prompt.
      await materializeVisualPlanForTurn({
        projectId,
        targetChapter,
        visualPlan: result.visualPlan,
        illustrationMode,
        turnId: notice.turnId,
        messageOrder: nextOrder,
        now,
      })

      await storyDatabase.projects.update(projectId, {
        activeChapterId: project.activeChapterId,
        updatedAt: now,
      })
    },
  )
}

/**
 * Replaces only the latest successful prose turn. The candidate is guarded by
 * the exact chapter hash captured before generation, so edits made while the
 * comparison is open can never be overwritten.
 */
export async function adoptWritingCandidate(projectId: string, turnId: string) {
  const now = Date.now()
  return storyDatabase.transaction(
    'rw',
    [
      storyDatabase.projects,
      storyDatabase.messages,
      storyDatabase.chapters,
      storyDatabase.characters,
      storyDatabase.illustrations,
      storyDatabase.scenes,
      storyDatabase.paragraphs,
      storyDatabase.summaryVersions,
      storyDatabase.feedback,
      storyDatabase.preferenceSignals,
      storyDatabase.writingCandidates,
    ],
    async () => {
      const candidate = await storyDatabase.writingCandidates.where('[projectId+turnId]').equals([projectId, turnId])
        .filter((item) => item.status === 'ready').first()
      if (!candidate) throw new Error('候选正文不存在或已经处理')

      const target = await getLatestRegenerableWritingTurn(projectId)
      if (!target || target.prose.id !== candidate.proseMessageId || target.prose.turnId !== turnId || target.chapter.id !== candidate.chapterId) {
        throw new Error('最近一轮正文已经变化，不能采用这份候选稿')
      }
      if (target.baseChapterHash !== candidate.baseChapterHash || target.baseChapterContent !== candidate.baseChapterContent) {
        throw new Error('章节正文已经变化，请保留当前版本并重新生成候选稿')
      }

      const project = await storyDatabase.projects.get(projectId)
      if (!project) throw new Error('当前作品不存在')
      const result = candidate.result
      const generatedSummary = result.chapterSummary?.trim() || undefined
      const chapterTitle = result.chapterTitle || target.chapter.title
      const chapterContent = [candidate.baseChapterContent.trim(), result.paragraphs.join('\n\n')].filter(Boolean).join('\n\n')

      const oldScenes = (await storyDatabase.scenes.where('projectId').equals(projectId).toArray()).filter((scene) => scene.turnId === turnId)
      const priorScenes = (await storyDatabase.scenes.where('projectId').equals(projectId).sortBy('order')).filter((scene) => scene.turnId !== turnId)
      const sceneNotes = materializeSceneNotesForResult(result, priorScenes)
      const stableScene = oldScenes.sort((left, right) => left.order - right.order || left.createdAt - right.createdAt)[0]
      const sceneOrder = stableScene?.order ?? priorScenes.reduce((highest, scene) => Math.max(highest, scene.order), 0) + 1

      const priorSummaryVersions = (await readChapterSummaryVersions(projectId, target.chapter.id)).filter((version) => version.turnId !== turnId)
      const fallbackSummary = priorSummaryVersions.at(-1)?.summary
      const nextChapter: Chapter = {
        ...target.chapter,
        title: chapterTitle,
        content: chapterContent,
        summary: generatedSummary ?? fallbackSummary,
        updatedAt: now,
      }
      await storyDatabase.chapters.put(nextChapter)
      await storyDatabase.messages.update(target.user.id, { chapterId: nextChapter.id })
      await storyDatabase.messages.update(target.notice.id, {
        chapterId: nextChapter.id,
        text: result.assistantNote,
        status: 'ready',
        turnId,
      })
      const nextProseMessage: ConversationMessage = {
        ...target.prose,
        chapterId: nextChapter.id,
        paragraphs: result.paragraphs,
        status: 'ready',
        turnId,
      }
      await storyDatabase.messages.put(nextProseMessage)
      await storyDatabase.paragraphs.where('[projectId+messageId]').equals([projectId, target.prose.id]).delete()
      await upsertMessageParagraphs(nextProseMessage)
      await upsertChapterParagraphs(nextChapter)

      if (oldScenes.length) await storyDatabase.scenes.bulkDelete(oldScenes.map((scene) => scene.id))
      await storyDatabase.scenes.put({
        id: stableScene?.id ?? createId('scene'),
        projectId,
        chapterId: nextChapter.id,
        order: sceneOrder,
        createdAt: stableScene?.createdAt ?? now,
        notes: sceneNotes,
        excerpt: result.paragraphs.join('\n\n').slice(-6_000),
        turnId,
      })

      const turnSummaryVersions = (await storyDatabase.summaryVersions.where('[projectId+chapterId]').equals([projectId, nextChapter.id]).toArray())
        .filter((version) => version.turnId === turnId)
      if (turnSummaryVersions.length) await storyDatabase.summaryVersions.bulkDelete(turnSummaryVersions.map((version) => version.id))
      if (generatedSummary) await appendGeneratedChapterSummaryVersion(nextChapter, generatedSummary, now, turnId)

      const turnIllustrations = (await storyDatabase.illustrations.where('projectId').equals(projectId).toArray())
        .filter((illustration) => illustration.turnId === turnId)
      const disposableIllustrationIds = turnIllustrations
        .filter((illustration) => illustration.status === 'planned' || illustration.status === 'failed')
        .map((illustration) => illustration.id)
      const preservedIllustrations = turnIllustrations.filter((illustration) => illustration.status === 'ready' || illustration.status === 'generating')
      if (disposableIllustrationIds.length) await storyDatabase.illustrations.bulkDelete(disposableIllustrationIds)
      for (const illustration of preservedIllustrations) {
        await storyDatabase.illustrations.update(illustration.id, { messageId: undefined, turnId: undefined, archivedAt: now, updatedAt: now })
      }
      const oldIllustrationMessages = (await storyDatabase.messages.where('projectId').equals(projectId).toArray())
        .filter((message) => message.turnId === turnId && message.kind === 'illustration')
      if (oldIllustrationMessages.length) await storyDatabase.messages.bulkDelete(oldIllustrationMessages.map((message) => message.id))

      const remainingIllustrations = await storyDatabase.illustrations.where('projectId').equals(projectId).toArray()
      const referencedCharacterIds = new Set(remainingIllustrations.flatMap((illustration) => illustration.referenceCharacterIds))
      const disposableCharacters = (await storyDatabase.characters.where('projectId').equals(projectId).toArray()).filter((character) => (
        character.turnId === turnId
        && character.status === 'draft'
        && character.portraitStatus === 'planned'
        && character.createdAt === character.updatedAt
        && !character.continuity.referenceImageUrl
        && !character.continuity.localUri
        && !referencedCharacterIds.has(character.id)
      ))
      if (disposableCharacters.length) await storyDatabase.characters.bulkDelete(disposableCharacters.map((character) => character.id))

      const oldFeedback = await storyDatabase.feedback.where('[projectId+messageId]').equals([projectId, target.prose.id]).toArray()
      if (oldFeedback.length) {
        const feedbackIds = oldFeedback.map((feedback) => feedback.id)
        await storyDatabase.preferenceSignals.where('feedbackId').anyOf(feedbackIds).delete()
        await storyDatabase.feedback.bulkDelete(feedbackIds)
      }

      await materializeVisualPlanForTurn({
        projectId,
        targetChapter: nextChapter,
        visualPlan: result.visualPlan,
        illustrationMode: resolveIllustrationMode(project),
        turnId,
        messageOrder: target.prose.order + 1,
        now,
      })
      await storyDatabase.projects.update(projectId, { activeChapterId: nextChapter.id, updatedAt: now })
      await storyDatabase.writingCandidates.update(candidate.id, { status: 'adopted', updatedAt: now })
      return { chapter: nextChapter, prose: nextProseMessage, result }
    },
  )
}

export async function failWritingTurn(noticeId: string, message: string, partialProse?: string) {
  const draft = partialProse?.trim()
  await storyDatabase.transaction('rw', storyDatabase.messages, async () => {
    const notice = await storyDatabase.messages.get(noticeId)
    if (!notice) return
    if (notice.status !== 'pending') return

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

/**
 * Marks a pending turn as cancelled without writing any prose. The user
 * message is kept; the notice becomes a stable, non-failed `cancelled` state.
 */
export async function cancelWritingTurn(noticeId: string) {
  await storyDatabase.transaction('rw', storyDatabase.messages, async () => {
    const notice = await storyDatabase.messages.get(noticeId)
    if (!notice) return
    if (notice.status !== 'pending') return
    await storyDatabase.messages.update(noticeId, {
      text: '已停止生成，未写入正文。',
      status: 'cancelled',
    })
  })
}

/**
 * Updates the newest retryable user request. The database, not the UI, owns
 * the guard so a stale screen cannot edit a completed or superseded turn.
 */
export async function updateLatestRetryableWritingUserMessage(projectId: string, userMessageId: string, text: string) {
  const userText = text.trim()
  if (!userText) throw new Error('已发送内容不能为空')
  const now = Date.now()
  return storyDatabase.transaction('rw', [storyDatabase.messages, storyDatabase.projects], async () => {
    const messages = await storyDatabase.messages.where('projectId').equals(projectId).sortBy('order')
    const userMessage = messages.find((message) => message.id === userMessageId)
    if (!userMessage || userMessage.kind !== 'user') throw new Error('用户消息不存在或不属于当前作品')
    if (messages.filter((message) => message.kind === 'user').at(-1)?.id !== userMessageId) {
      throw new Error('只能编辑最新一轮已发送内容')
    }
    const notice = messages.find((message) => message.kind === 'notice' && message.userMessageId === userMessageId)
    if (!notice || (notice.status !== 'failed' && notice.status !== 'cancelled')) {
      throw new Error('只有失败或已停止的最新回合才能编辑')
    }
    const hasSuccessfulProse = Boolean(notice.turnId) && messages.some((message) => (
      message.kind === 'prose'
      && message.turnId === notice.turnId
      && message.status !== 'failed'
    ))
    if (hasSuccessfulProse) throw new Error('已完成正文的回合不能再编辑')
    await storyDatabase.messages.update(userMessageId, { text: userText })
    await storyDatabase.projects.update(projectId, { updatedAt: now })
    return userText
  })
}

/** Returns the one user message currently eligible for retry-before-editing. */
export async function getLatestRetryableWritingUserMessage(projectId: string) {
  const messages = await storyDatabase.messages.where('projectId').equals(projectId).sortBy('order')
  const user = messages.filter((message) => message.kind === 'user').at(-1)
  if (!user) return undefined
  const notice = messages.find((message) => message.kind === 'notice' && message.userMessageId === user.id)
  if (!notice || (notice.status !== 'failed' && notice.status !== 'cancelled')) return undefined
  const hasSuccessfulProse = Boolean(notice.turnId) && messages.some((message) => message.kind === 'prose' && message.turnId === notice.turnId && message.status !== 'failed')
  return hasSuccessfulProse ? undefined : user
}

/**
 * Re-opens a failed or cancelled turn for regeneration. It reuses the original
 * user message and its existing notice, so no duplicate user bubble is created.
 * Returns the original user text and the project's current illustration mode.
 */
export async function retryWritingTurn(projectId: string, noticeId: string): Promise<{ userText: string; illustrationMode: IllustrationMode }> {
  const now = Date.now()
  return storyDatabase.transaction('rw', [storyDatabase.messages, storyDatabase.projects], async () => {
    const notice = await storyDatabase.messages.get(noticeId)
    if (!notice || notice.projectId !== projectId || notice.kind !== 'notice') throw new Error('写作任务不存在')
    if (notice.status !== 'failed' && notice.status !== 'cancelled') throw new Error('只有失败或已停止的回合才能重新生成')
    const userMessage = notice.userMessageId ? await storyDatabase.messages.get(notice.userMessageId) : undefined
    if (!userMessage || userMessage.projectId !== projectId || userMessage.kind !== 'user') throw new Error('原用户消息不存在或不属于当前作品')
    const userText = userMessage.text?.trim()
    if (!userText) throw new Error('原用户消息没有可用文本')
    const project = await storyDatabase.projects.get(projectId)
    if (!project) throw new Error('当前作品不存在')
    await storyDatabase.messages.update(noticeId, {
      text: writingNoticeText(resolveIllustrationMode(project), true),
      status: 'pending',
      backgroundTaskId: '',
    })
    await storyDatabase.projects.update(projectId, { updatedAt: now })
    return { userText, illustrationMode: resolveIllustrationMode(project) }
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
    narrativePronoun: profile.narrativePronoun,
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
    failureKind: undefined,
    updatedAt: Date.now(),
  })
}

export async function setIllustrationReady(illustrationId: string, imageUrl: string, localUri?: string) {
  await storyDatabase.illustrations.update(illustrationId, {
    status: 'ready',
    imageUrl,
    localUri,
    errorMessage: undefined,
    failureKind: undefined,
    updatedAt: Date.now(),
  })
}

export async function setIllustrationFailed(illustrationId: string, message: string) {
  await storyDatabase.illustrations.update(illustrationId, {
    status: 'failed',
    imageUrl: undefined,
    localUri: undefined,
    errorMessage: message,
    failureKind: undefined,
    updatedAt: Date.now(),
  })
}

/** Record an unmet reference prerequisite without treating it as an image request failure. */
export async function setIllustrationBlockedByReference(illustrationId: string, message: string) {
  await storyDatabase.illustrations.update(illustrationId, {
    status: 'failed',
    imageUrl: undefined,
    localUri: undefined,
    errorMessage: message,
    failureKind: 'reference-unavailable',
    updatedAt: Date.now(),
  })
}

/** Only explicit reference blockers may be returned to the normal generation queue. */
export async function restoreIllustrationsBlockedByReference(projectId: string, illustrationIds: readonly string[]) {
  if (!illustrationIds.length) return 0
  const now = Date.now()
  return storyDatabase.transaction('rw', storyDatabase.illustrations, async () => {
    const blocked = await storyDatabase.illustrations
      .where('projectId')
      .equals(projectId)
      .filter((illustration) => illustrationIds.includes(illustration.id) && illustration.failureKind === 'reference-unavailable')
      .toArray()
    await Promise.all(blocked.map((illustration) => storyDatabase.illustrations.update(illustration.id, {
      status: 'planned',
      errorMessage: undefined,
      failureKind: undefined,
      updatedAt: now,
    })))
    return blocked.length
  })
}

export function getActiveProjectId() {
  return localStorage.getItem(ACTIVE_PROJECT_KEY)
}

export function setActiveProjectId(projectId: string) {
  localStorage.setItem(ACTIVE_PROJECT_KEY, projectId)
}
