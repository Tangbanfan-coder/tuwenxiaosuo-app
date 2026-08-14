export type ThemePresetId = 'neutral' | 'warm' | 'rainy-mystery' | 'dark-horror'
export type AppearanceMode = 'dark' | 'light'
export type IllustrationStylePresetId = 'unconstrained' | 'realistic-cinematic' | 'anime' | 'manga' | 'watercolor' | 'oil-painting' | 'pixel-art' | 'custom'
export type ReferenceStyleMode = 'project' | 'reference'
export type ContextBudget = 'standard' | 'long' | 'full'
export type RewriteStrength = 'light' | 'balanced' | 'strong'

export type ProseEvaluationEventType =
  | 'prose_analyzed' | 'rewrite_opened' | 'rewrite_requested' | 'rewrite_succeeded' | 'rewrite_failed'
  | 'rewrite_kept_original' | 'rewrite_applied' | 'rewrite_apply_failed' | 'writing_turn_completed'
  | 'style_corpus_retrieved' | 'style_corpus_imported' | 'style_corpus_deleted'

/** Local-only, deliberately text-free event used for prose workflow evaluation. */
export interface ProseEvaluationEvent {
  id: string
  eventType: ProseEvaluationEventType
  occurredAt: number
  schemaVersion: 1
  appVersion: '0.1.0'
  databaseVersion: 11
  proseRuleVersion: number
  projectId?: string
  messageId?: string
  paragraphId?: string
  ruleIds?: string[]
  severities?: ProseStyleSeverity[]
  beforeRuleIds?: string[]
  afterRuleIds?: string[]
  paragraphLengthBucket?: '0-100' | '101-300' | '301-800' | '801+'
  suggestionLengthBucket?: '0-100' | '101-300' | '301-800' | '801+'
  lengthChangeBucket?: 'shorter-30+' | 'shorter-10-29' | 'similar' | 'longer-10-29' | 'longer-30+'
  rewriteStrength?: RewriteStrength
  durationBucket?: 'under-1s' | '1-5s' | '5-15s' | '15-60s' | '60s+'
  corpusFragmentCount?: number
  contextBudget?: ContextBudget
  failureKind?: 'configuration' | 'provider' | 'parse' | 'storage' | 'validation' | 'unknown'
  factProtection?: 'not_checked'
}

export type ProseStyleRuleCategory =
  | 'template-simile'
  | 'contrast'
  | 'animal-simile'
  | 'emotion-telling'
  | 'stock-reaction'
  | 'dialogue-explanation'
  | 'repetition'
  | 'mechanical-list'
  | 'elevated-ending'

export type ProseStyleSeverity = 'hint' | 'warning' | 'strong'

export interface ProseStyleIssue {
  ruleId: string
  category: ProseStyleRuleCategory
  severity: ProseStyleSeverity
  explanation: string
  rewriteGoal: string
  matchedText?: string
}

export interface StyleCorpusLabels {
  genres: string[]
  sceneTypes: string[]
  pov?: string
  narrativeDistance?: string
  pace: string[]
  techniques: string[]
  emotionalTone: string[]
  imitate: string[]
  avoid: string[]
  confidence?: number
}

export interface StyleCorpusSource {
  id: string
  title: string
  rawText: string
  fingerprint: string
  createdAt: number
  updatedAt: number
}

export interface StyleCorpusFragment {
  id: string
  sourceId: string
  paragraphIds: string[]
  text: string
  fingerprint: string
  suggestedLabels?: StyleCorpusLabels
  labels: StyleCorpusLabels
  confirmed: boolean
  usageCount: number
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}

export interface StyleCorpusBinding {
  id: string
  fragmentId: string
  scope: 'global' | 'project'
  projectId?: string
  state: 'enabled' | 'excluded'
  weight: number
  createdAt: number
  updatedAt: number
}

export interface WritingInstructionSection {
  id: string
  title: string
  content: string
  tags: string[]
  priority: number
}

export interface WritingStyleSample {
  sceneType: string
  content: string
}

export interface WritingInstructionsStructure {
  core: string
  sections: WritingInstructionSection[]
  styleSamples: WritingStyleSample[]
}

export interface StoryProject {
  id: string
  title: string
  themeId: ThemePresetId
  activeChapterId?: string
  autoIllustrate: boolean
  writingInstructions?: string
  writingStructure?: string
  contextBudget?: ContextBudget
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
}

export type MessageKind = 'user' | 'notice' | 'prose' | 'illustration'

export interface ConversationMessage {
  id: string
  projectId: string
  chapterId?: string
  kind: MessageKind
  order: number
  createdAt: number
  text?: string
  paragraphs?: string[]
  title?: string
  illustrationId?: string
  status?: 'ready' | 'pending' | 'failed' | 'cancelled'
  /** Native foreground task linked while this writing result is pending. */
  backgroundTaskId?: string
  /** For notices, links back to the user message that started this turn. */
  userMessageId?: string
}

export type ParagraphSourceType = 'message' | 'chapter'

/**
 * A stable storage record for a paragraph. Message rendering intentionally
 * continues to use ConversationMessage.paragraphs for backward compatibility.
 */
export interface StoredParagraph {
  id: string
  projectId: string
  sourceType: ParagraphSourceType
  messageId?: string
  chapterId: string
  index: number
  text: string
  fingerprint: string
  /** Local editorial diagnostics for this exact paragraph version. */
  styleIssues?: ProseStyleIssue[]
  styleRuleVersion?: number
  createdAt: number
}

export type FeedbackScope = 'message' | 'paragraph'
export type FeedbackVerdict = 'up' | 'down'

/**
 * A durable reader judgement bound to one prose message or one exact stored
 * message paragraph. `targetKey` is a canonical, unique storage key and is
 * generated by the database API rather than supplied by callers.
 */
export interface Feedback {
  id: string
  projectId: string
  messageId: string
  chapterId: string
  scope: FeedbackScope
  paragraphId?: string
  paragraphIndex?: number
  paragraphFingerprint?: string
  targetKey: string
  verdict: FeedbackVerdict
  reason?: string
  customNote?: string
  createdAt: number
  updatedAt: number
}

/** Identifies a feedback target with the current paragraph anchor when needed. */
export interface FeedbackTargetInput {
  projectId: string
  messageId: string
  chapterId: string
  scope: FeedbackScope
  paragraphId?: string
  paragraphIndex?: number
  paragraphFingerprint?: string
}

export interface FeedbackInput extends FeedbackTargetInput {
  verdict: FeedbackVerdict
  reason?: string
  customNote?: string
}

export interface FeedbackBatchInput {
  targets: FeedbackTargetInput[]
  verdict: FeedbackVerdict
  reason?: string
  customNote?: string
}

export type UpsertFeedbackInput = FeedbackInput

export interface WritingCharacterPlan {
  name: string
  role: string
  /** Only set when this turn's prose or explicit setup makes it unambiguous. */
  narrativePronoun?: NarrativePronoun
  ageAndBuild: string
  fixedTraits: string[]
  defaultLook: string
  wardrobe: string
}

export interface VisualPlan {
  title: string
  prompt: string
  stylePrompt: string
  negativePrompt: string
  /** A concrete, visible beat for the illustration instead of a static pose. */
  action?: string
  bodyLanguage?: string
  expression?: string
  gaze?: string
  camera?: string
  motion?: string
  sceneAnchor?: SceneContinuityAnchor
  characters: WritingCharacterPlan[]
}

export interface SceneContinuityAnchor {
  /** Stable model-authored identity, reused only for the same continuous set. */
  key: string
  location: string
  timePeriod: string
  fixedElements: string[]
  lighting: string
  palette: string
}

/** A durable foreshadowing record. Its id is generated by the application, never by the model. */
export interface Foreshadowing {
  id: string
  text: string
  aliases?: string[]
}

interface SceneNoteFacts {
  time?: string
  location?: string
  povCharacter?: string
  charactersPresent: string[]
  events: string[]
  stateChanges: Array<{ character: string; aspect: string; state: string }>
  relationshipChanges: string[]
  knowledgeChanges: Array<{ character: string; nowKnows: string }>
  unresolvedThreads: string[]
}

/** Persisted scene memory. Resolutions are stable ids, never matching prose. */
export interface SceneNotes extends SceneNoteFacts {
  foreshadowingPlanted: Foreshadowing[]
  resolvedForeshadowingIds: string[]
  /** Old text-only resolutions that could not be safely bound to one open record. */
  legacyUnmatchedResolvedForeshadowingTexts?: string[]
}

/** Parsed model output before persistence. New foreshadowings intentionally have no model-supplied id. */
export interface WritingSceneNotes extends SceneNoteFacts {
  newForeshadowingTexts: string[]
  resolvedForeshadowingIds: string[]
  /** Compatibility input from the obsolete text-only `clues_resolved` response field. */
  legacyResolvedForeshadowingTexts?: string[]
}

/**
 * A prose turn advances the story: it always carries non-empty paragraphs and
 * may create a chapter, scene notes, a summary and a visual plan.
 */
export interface WritingProseResult {
  kind: 'prose'
  assistantNote: string
  chapterAction: 'continue' | 'new'
  chapterTitle?: string
  paragraphs: string[]
  chapterSummary?: string
  sceneNotes?: WritingSceneNotes
  visualPlan?: VisualPlan
}

/**
 * A collaboration-only turn responds without advancing the plot. It must not
 * create chapters, scenes, prose messages, summaries or visual plans.
 */
export interface WritingAssistantOnlyResult {
  kind: 'assistant-only'
  assistantNote: string
}

export type WritingTurnResult = WritingProseResult | WritingAssistantOnlyResult

export interface Chapter {
  id: string
  projectId: string
  title: string
  order: number
  content: string
  status: 'draft' | 'final'
  summary?: string
  createdAt: number
  updatedAt: number
}

export type SummaryVersionReason = 'generation' | 'migration' | 'restore'

/**
 * Immutable provenance for a chapter summary. A restore always creates a new
 * record so earlier versions remain auditable.
 */
export interface SummaryVersion {
  id: string
  projectId: string
  chapterId: string
  version: number
  summary: string
  sourceContentHash: string
  sourceParagraphIds: string[]
  reason: SummaryVersionReason
  restoredFromId?: string
  createdAt: number
}

export interface CharacterAsset {
  id: string
  projectId: string
  name: string
  role: string
  /** Narrative reference is intentionally independent from free-form appearance text. */
  narrativePronoun?: NarrativePronoun
  identity: {
    ageAndBuild: string
    fixedTraits: string[]
  }
  appearance: {
    defaultLook: string
    wardrobe: string
  }
  continuity: {
    referenceImageUrl?: string
    localUri?: string
    revision: number
    referenceStyleMode?: ReferenceStyleMode
  }
  portraitStatus: 'planned' | 'generating' | 'review' | 'failed' | 'confirmed'
  portraitError?: string
  status: 'draft' | 'confirmed'
  createdAt: number
  updatedAt: number
}

export type NarrativePronoun = 'she' | 'he' | 'ta' | 'name'

export interface IllustrationAsset {
  id: string
  projectId: string
  chapterId?: string
  messageId?: string
  title: string
  prompt: string
  sceneStylePrompt?: string
  sceneNegativePrompt?: string
  action?: string
  bodyLanguage?: string
  expression?: string
  gaze?: string
  camera?: string
  motion?: string
  sceneAnchor?: SceneContinuityAnchor
  referenceCharacterIds: string[]
  imageUrl?: string
  localUri?: string
  status: 'planned' | 'generating' | 'ready' | 'failed'
  errorMessage?: string
  /** A recoverable prerequisite failure, distinct from an image request failure. */
  failureKind?: 'reference-unavailable'
  createdAt: number
  updatedAt: number
}

export interface ProjectStyle {
  id: string
  projectId: string
  presetId: ThemePresetId
  illustrationStyleId: IllustrationStylePresetId
  customVisualPrompt?: string
  visualPrompt: string
  negativePrompt: string
  updatedAt: number
}

export interface ProjectWorkspace {
  project: StoryProject
  /** App-level defaults applied before the current project's own rules. */
  globalWritingInstructions?: string
  messages: ConversationMessage[]
  chapters: Chapter[]
  characters: CharacterAsset[]
  illustrations: IllustrationAsset[]
  style?: ProjectStyle
}
