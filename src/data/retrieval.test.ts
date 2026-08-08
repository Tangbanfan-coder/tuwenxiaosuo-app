import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Chapter, StoryProject, StoredParagraph } from '../domain/models'
import { createParagraphFingerprint } from '../domain/paragraphs'
import {
  hashText,
  listRetrievableProjectParagraphs,
  storyDatabase,
  upsertChapterParagraphs,
} from './storyDatabase'

const project: StoryProject = {
  id: 'retrieval-project',
  title: '检索测试作品',
  themeId: 'neutral',
  autoIllustrate: false,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
}

async function clearStoryDatabase() {
  await Promise.all([
    storyDatabase.paragraphs.clear(),
    storyDatabase.projects.clear(),
    storyDatabase.messages.clear(),
    storyDatabase.chapters.clear(),
    storyDatabase.characters.clear(),
    storyDatabase.illustrations.clear(),
    storyDatabase.styles.clear(),
    storyDatabase.scenes.clear(),
  ])
}

function messageParagraph(id: string, chapterId: string, text: string, fingerprint = createParagraphFingerprint(text)): StoredParagraph {
  return {
    id,
    projectId: project.id,
    sourceType: 'message',
    messageId: `message-${id}`,
    chapterId,
    index: 0,
    text,
    fingerprint,
    createdAt: 20,
  }
}

beforeEach(async () => {
  await clearStoryDatabase()
  await storyDatabase.projects.add({ ...project })
})

describe('retrievable project paragraphs', () => {
  it('filters stale versions and fingerprint drift, deduplicates same-chapter copies, and keeps identical text in separate chapters', async () => {
    const firstVersion: Chapter = {
      id: 'chapter-a',
      projectId: project.id,
      title: '第一章',
      order: 1,
      content: '旧版本的秘密。',
      status: 'draft',
      createdAt: 1,
      updatedAt: 1,
    }
    await storyDatabase.chapters.add(firstVersion)
    await upsertChapterParagraphs(firstVersion)

    const currentText = '银色钥匙藏在旧钟塔。'
    const currentVersion = { ...firstVersion, content: currentText, updatedAt: 2 }
    await storyDatabase.chapters.update(currentVersion.id, { content: currentVersion.content, updatedAt: currentVersion.updatedAt })
    await upsertChapterParagraphs(currentVersion)

    const sameTextDifferentChapter: Chapter = {
      id: 'chapter-b',
      projectId: project.id,
      title: '第二章',
      order: 2,
      content: currentText,
      status: 'draft',
      createdAt: 3,
      updatedAt: 3,
    }
    await storyDatabase.chapters.add(sameTextDifferentChapter)
    await upsertChapterParagraphs(sameTextDifferentChapter)

    await storyDatabase.paragraphs.bulkAdd([
      // This is the usual message/chapter duplicate and must lose to chapter-a.
      messageParagraph('paragraph-message-duplicate-a-0', 'chapter-a', currentText),
      // A valid message without a current chapter copy remains searchable.
      messageParagraph('paragraph-message-only-0', 'chapter-a', '只有消息保存的旁白。'),
      // Corrupted text/fingerprint pairs must never reach prompt retrieval.
      messageParagraph('paragraph-message-drift-0', 'chapter-a', '指纹已漂移的段落。', 'incorrect-fingerprint'),
    ])

    const paragraphs = await listRetrievableProjectParagraphs(project.id)
    const ids = paragraphs.map((paragraph) => paragraph.id)
    const oldVersionId = `paragraph-chapter-${firstVersion.id}-${hashText(firstVersion.content)}-0`
    const currentVersionId = `paragraph-chapter-${currentVersion.id}-${hashText(currentVersion.content)}-0`
    const otherChapterId = `paragraph-chapter-${sameTextDifferentChapter.id}-${hashText(sameTextDifferentChapter.content)}-0`

    expect(ids).not.toContain(oldVersionId)
    expect(ids).toContain(currentVersionId)
    expect(ids).toContain(otherChapterId)
    expect(ids).not.toContain('paragraph-message-duplicate-a-0')
    expect(ids).toContain('paragraph-message-only-0')
    expect(ids).not.toContain('paragraph-message-drift-0')

    const chapterCopies = paragraphs.filter((paragraph) => paragraph.sourceType === 'chapter' && paragraph.text === currentText)
    expect(chapterCopies.map((paragraph) => paragraph.chapterId)).toEqual(['chapter-a', 'chapter-b'])
    expect(chapterCopies.every((paragraph) => paragraph.index === 0)).toBe(true)
  })
})
