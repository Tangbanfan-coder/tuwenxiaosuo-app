import { describe, expect, it } from 'vitest'
import { buildProjectContext } from '../writing'
import type { ProjectWorkspace } from '../../domain/models'

describe('reference character writing context', () => {
  it('includes confirmed pronoun and appearance as immutable writing facts', () => {
    const workspace: ProjectWorkspace = {
      project: { id: 'project-1', title: '测试', themeId: 'neutral', autoIllustrate: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 },
      messages: [], chapters: [], illustrations: [], style: undefined,
      characters: [{
        id: 'character-1', projectId: 'project-1', name: '林昭', role: '主角', narrativePronoun: 'she',
        identity: { ageAndBuild: '青年，身形修长', fixedTraits: ['左眼下有痣'] },
        appearance: { defaultLook: '齐肩黑发', wardrobe: '深色风衣' },
        continuity: { revision: 1, referenceImageUrl: 'data:image/png;base64,AA==' }, portraitStatus: 'confirmed', status: 'confirmed', createdAt: 1, updatedAt: 1,
      }],
    }
    const context = buildProjectContext(workspace, [], 50_000, '继续写')
    expect(context.context).toContain('不得自行改写其叙事代词')
    expect(context.context).toContain('narrativePronoun')
    expect(context.context).toContain('青年，身形修长')
  })

  it('forces legacy confirmed characters without a pronoun to use their name only', () => {
    const workspace: ProjectWorkspace = {
      project: { id: 'project-1', title: '测试', themeId: 'neutral', autoIllustrate: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 1 },
      messages: [], chapters: [], illustrations: [], style: undefined,
      characters: [{
        id: 'character-1', projectId: 'project-1', name: '林染', role: '主角',
        identity: { ageAndBuild: '', fixedTraits: [] }, appearance: { defaultLook: '', wardrobe: '' },
        continuity: { revision: 1, referenceImageUrl: 'data:image/png;base64,AA==' }, portraitStatus: 'confirmed', status: 'confirmed', createdAt: 1, updatedAt: 1,
      }],
    }
    const context = buildProjectContext(workspace, [], 50_000, '继续写')
    expect(context.context).toContain('正文只能使用角色姓名')
    expect(context.context).toContain('不得猜测“他”“她”或“TA”')
  })
})
