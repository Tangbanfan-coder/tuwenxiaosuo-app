import Dexie, { type Table } from 'dexie'
import type {
  Chapter,
  CharacterAsset,
  ConversationMessage,
  IllustrationStylePresetId,
  IllustrationAsset,
  ProjectStyle,
  ProjectWorkspace,
  ReferenceStyleMode,
  StoryProject,
  ThemePresetId,
  WritingTurnResult,
} from '../domain/models'
import { DEFAULT_ILLUSTRATION_STYLE_ID, getIllustrationStylePreset } from '../domain/illustrationStyles'

class StoryDatabase extends Dexie {
  projects!: Table<StoryProject, string>
  messages!: Table<ConversationMessage, string>
  chapters!: Table<Chapter, string>
  characters!: Table<CharacterAsset, string>
  illustrations!: Table<IllustrationAsset, string>
  styles!: Table<ProjectStyle, string>

  constructor() {
    super('illustrated-story-chat')
    this.version(1).stores({
      projects: 'id, updatedAt, lastOpenedAt',
      messages: 'id, projectId, [projectId+order], createdAt',
      chapters: 'id, projectId, [projectId+order], updatedAt',
      characters: 'id, projectId, [projectId+createdAt], status',
      illustrations: 'id, projectId, [projectId+createdAt], status',
      styles: 'id, &projectId, updatedAt',
    })
  }
}

export const storyDatabase = new StoryDatabase()

const ACTIVE_PROJECT_KEY = 'illustrated-story-chat.active-project.v1'

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

export async function initializeStoryDatabase() {
  if (await storyDatabase.projects.count()) return
  await createProject('未命名作品')
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

  return { project, messages, chapters, characters, illustrations, style }
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
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.characters, storyDatabase.illustrations, storyDatabase.styles],
    async () => {
      await Promise.all([
        storyDatabase.messages.where('projectId').equals(projectId).delete(),
        storyDatabase.chapters.where('projectId').equals(projectId).delete(),
        storyDatabase.characters.where('projectId').equals(projectId).delete(),
        storyDatabase.illustrations.where('projectId').equals(projectId).delete(),
        storyDatabase.styles.where('projectId').equals(projectId).delete(),
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
  if (normalized.length > 4000) throw new Error('长期创作设定不能超过 4000 个字')
  await storyDatabase.projects.update(projectId, {
    writingInstructions: normalized,
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
  await storyDatabase.transaction(
    'rw',
    [storyDatabase.projects, storyDatabase.messages, storyDatabase.chapters, storyDatabase.characters, storyDatabase.illustrations],
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
          updatedAt: now,
        })
        targetChapter = { ...activeChapter, title, content, updatedAt: now }
        project.activeChapterId = activeChapter.id
      }

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

      if (autoIllustrate && result.visualPlan) {
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

export async function failWritingTurn(noticeId: string, message: string) {
  await storyDatabase.messages.update(noticeId, {
    text: `写作失败：${message}。没有自动重试，请检查配置后重新发送。`,
    status: 'failed',
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

export async function setCharacterPortraitFailed(characterId: string, message: string) {
  await storyDatabase.characters.update(characterId, {
    portraitStatus: 'failed',
    portraitError: message,
    updatedAt: Date.now(),
  })
}

export async function confirmCharacterPortrait(characterId: string) {
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
