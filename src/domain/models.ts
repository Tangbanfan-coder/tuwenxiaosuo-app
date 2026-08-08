export type ThemePresetId = 'neutral' | 'warm' | 'rainy-mystery' | 'dark-horror'
export type AppearanceMode = 'dark' | 'light'
export type IllustrationStylePresetId = 'unconstrained' | 'realistic-cinematic' | 'anime' | 'manga' | 'watercolor' | 'oil-painting' | 'pixel-art' | 'custom'
export type ReferenceStyleMode = 'project' | 'reference'
export type ContextBudget = 'standard' | 'long' | 'full'

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
  status?: 'ready' | 'pending' | 'failed'
}

export interface WritingCharacterPlan {
  name: string
  role: string
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
  characters: WritingCharacterPlan[]
}

export interface SceneNotes {
  time?: string
  location?: string
  povCharacter?: string
  charactersPresent: string[]
  events: string[]
  stateChanges: Array<{ character: string; aspect: string; state: string }>
  relationshipChanges: string[]
  knowledgeChanges: Array<{ character: string; nowKnows: string }>
  cluesPlanted: string[]
  cluesResolved: string[]
  unresolvedThreads: string[]
}

export interface WritingTurnResult {
  assistantNote: string
  chapterAction: 'continue' | 'new'
  chapterTitle?: string
  paragraphs: string[]
  chapterSummary?: string
  sceneNotes?: SceneNotes
  visualPlan?: VisualPlan
}

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

export interface CharacterAsset {
  id: string
  projectId: string
  name: string
  role: string
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

export interface IllustrationAsset {
  id: string
  projectId: string
  chapterId?: string
  messageId?: string
  title: string
  prompt: string
  sceneStylePrompt?: string
  sceneNegativePrompt?: string
  referenceCharacterIds: string[]
  imageUrl?: string
  localUri?: string
  status: 'planned' | 'generating' | 'ready' | 'failed'
  errorMessage?: string
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
  messages: ConversationMessage[]
  chapters: Chapter[]
  characters: CharacterAsset[]
  illustrations: IllustrationAsset[]
  style?: ProjectStyle
}
