import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach } from 'vitest'
import {
  storyDatabase,
  updateWritingInstructions,
  updateWritingStructure,
  loadProjectWorkspace,
  listProjects,
} from '../../data/storyDatabase'
import { buildProjectContext, buildProjectContextForTokenBudget, parseChapterOrder, parseWritingStructure, structureWritingInstructions } from '../writing'
import type { StoredScene } from '../../data/storyDatabase'
import type { ProjectWorkspace } from '../../domain/models'
import type { HttpTransport, ProviderConfig, TransportRequest } from '../types'
import { resolveTokenEstimator } from '../tokenEstimator'

beforeEach(async () => {
  await Promise.all([
    storyDatabase.projects.clear(),
    storyDatabase.scenes.clear(),
    storyDatabase.chapters.clear(),
    storyDatabase.messages.clear(),
  ])
  await storyDatabase.projects.add({
    id: 'project-1',
    title: '测试作品',
    themeId: 'neutral',
    autoIllustrate: false,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
  })
})

function makeWorkspace(overrides: Partial<ProjectWorkspace['project']> = {}): ProjectWorkspace {
  return {
    project: {
      id: 'project-1',
      title: '测试作品',
      themeId: 'neutral',
      autoIllustrate: false,
      createdAt: 0,
      updatedAt: 0,
      lastOpenedAt: 0,
      ...overrides,
    },
    messages: [],
    chapters: [],
    characters: [],
    illustrations: [],
    style: undefined,
  }
}

describe('局部创作设定三层结构', () => {
  it('全局创作设定作为低优先级默认并与作品设定同时注入', () => {
    const workspace = makeWorkspace({ writingInstructions: '作品规则' })
    workspace.globalWritingInstructions = '通用规则'
    const context = buildProjectContextForTokenBudget(workspace, [], 20_000, '继续写', resolveTokenEstimator({ protocol: 'openai-compatible', providerId: 'test', model: 'test' }))
    expect(context.context).toContain('全局创作设定（低优先级默认）')
    expect(context.context).toContain('当前作品局部创作设定（优先覆盖全局设定）')
  })
  it('原文更新后旧结构必须失效（含 sourceHash 绑定）', async () => {
    await updateWritingInstructions('project-1', '原文第一版')
    await updateWritingStructure('project-1', JSON.stringify({
      core: '旧核心规则',
      sections: [],
      styleSamples: [],
    }))

    const project = await loadProjectWorkspace('project-1')
    expect(project?.project.writingStructure).toBeTruthy()

    await updateWritingInstructions('project-1', '原文第二版，改了很多')

    const after = await loadProjectWorkspace('project-1')
    expect(after?.project.writingStructure).toBeFalsy()
  })

  it('绕过对话框直接改原文时，旧结构的 sourceHash 不匹配即失效', async () => {
    await updateWritingInstructions('project-1', '原文第一版')
    await updateWritingStructure('project-1', JSON.stringify({
      core: '旧核心规则',
      sections: [],
      styleSamples: [],
    }))

    await storyDatabase.projects.update('project-1', { writingInstructions: '被外部直接改过的原文' })
    const project = await loadProjectWorkspace('project-1')
    expect(project?.project.writingStructure).toBeTruthy()

    const result = buildProjectContext(project!, [], 50_000, '继续写')
    expect(result.context).toContain('被外部直接改过的原文')
    expect(result.context).not.toContain('旧核心规则')
    expect(parseWritingStructure(project!.project)).toBeUndefined()
  })

  it('新结构保存后下一轮立即生效（数据库层）', async () => {
    await updateWritingInstructions('project-1', '核心设定：第三人称；禁止跳视角。分类：世界历史。')
    const structureJson = JSON.stringify({
      core: '每轮必须：第三人称有限视角；禁止跳视角。',
      sections: [
        { id: 's1', title: '世界历史', content: '北境曾是被遗忘的王国。', tags: ['北境', '历史'], priority: 5 },
        { id: 's2', title: '魔法体系', content: '蓝火魔法来自海神。', tags: ['魔法'], priority: 3 },
        { id: 's3', title: '皇城设定', content: '皇城的礼仪与阴谋。', tags: ['皇城'], priority: 3 },
        { id: 's4', title: '天界设定', content: '天界的秩序与审判。', tags: ['天界'], priority: 1 },
      ],
      styleSamples: [
        { sceneType: '景物', content: '风从冻土上刮过。' },
      ],
    })
    await updateWritingStructure('project-1', structureJson)

    const project = await loadProjectWorkspace('project-1')
    const scenes: StoredScene[] = []
    const context = buildProjectContext(
      project!,
      scenes,
      50_000,
      '继续写北境的场景',
    )

    expect(context.context).toContain('第三人称有限视角')
    expect(context.context).toContain('北境曾是被遗忘的王国')
    expect(context.context).not.toContain('天界的秩序与审判')
    expect(context.rulesTruncated).toBe(false)
  })

  it('损坏或旧版本的结构 JSON 不能导致崩溃', async () => {
    const withStructure = (structure: string) => makeWorkspace({
      writingInstructions: '原文设定在这里',
      writingStructure: structure,
    })
    for (const broken of ['not-json', '{"core": 123}', '{"sections": "oops"}']) {
      expect(() => buildProjectContext(withStructure(broken), [], 50_000, '继续写')).not.toThrow()
    }

    const fallback = buildProjectContext(withStructure('not-json'), [], 50_000, '继续写')
    expect(fallback.context).toContain('原文设定在这里')
    expect(fallback.rulesTruncated).toBe(false)
    expect(parseWritingStructure(withStructure('not-json').project)).toBeUndefined()

    const partial = buildProjectContext(
      withStructure('{"core": "可用核心规则", "sections": [{"title": "缺内容的分类"}], "styleSamples": [{"sceneType": "x"}]}'),
      [],
      50_000,
      '继续写',
    )
    expect(partial.context).toContain('可用核心规则')
    const parsed = parseWritingStructure(withStructure('{"core": "c", "sections": [{"title": "无内容"}], "styleSamples": [{"sceneType": "x"}]}').project)
    expect(parsed?.sections).toHaveLength(0)
    expect(parsed?.styleSamples).toHaveLength(0)
  })

  it('核心规则超过预算时截断并阻止（不静默继续）', async () => {
    const hugeCore = '核心规则。'.repeat(3_000)
    const workspace = makeWorkspace({
      writingInstructions: hugeCore,
    })
    const result = buildProjectContext(workspace, [], 2_000, '继续写')
    expect(result.rulesTruncated).toBe(true)
    expect(result.context.length).toBeLessThan(2_000)
  })

  it('损坏结构存在时不使用其内容，回退原文', async () => {
    const workspace = makeWorkspace({
      writingInstructions: '回退原文规则：禁止剧透结局。',
      writingStructure: 'garbage{{{',
    })
    const result = buildProjectContext(workspace, [], 50_000, '继续写')
    expect(result.context).toContain('禁止剧透结局')
    expect(result.rulesTruncated).toBe(false)
  })

  it('结构化分类按当前场景选择，不全部携带', async () => {
    const workspace = makeWorkspace({
      writingInstructions: '设定原文',
      writingStructure: JSON.stringify({
        core: '核心规则：第三人称。',
        sections: [
          { id: 's1', title: '北境设定', content: '北境的冻土与蓝火。', tags: ['北境'], priority: 5 },
          { id: 's2', title: '皇城设定', content: '皇城的礼仪与阴谋。', tags: ['皇城'], priority: 3 },
          { id: 's3', title: '魔法体系', content: '蓝火魔法来自海神。', tags: ['魔法'], priority: 3 },
          { id: 's4', title: '天界设定', content: '天界的秩序。', tags: ['天界'], priority: 1 },
        ],
        styleSamples: [],
      }),
    })
    const scenes: StoredScene[] = [{
      id: 'scene-1',
      projectId: 'project-1',
      order: 1,
      createdAt: 1,
      notes: {
        time: undefined, location: '北境', povCharacter: '林昭', charactersPresent: ['林昭'],
        events: [], stateChanges: [], relationshipChanges: [], knowledgeChanges: [],
        foreshadowingPlanted: [], resolvedForeshadowingIds: [], unresolvedThreads: [],
      },
      excerpt: '',
    }]
    const result = buildProjectContext(workspace, scenes, 50_000, '继续写北境的场景')
    expect(result.context).toContain('北境的冻土与蓝火')
    expect(result.context).not.toContain('天界的秩序')
  })

  it('列表刷新后结构立即可见（作品列表→工作区链路）', async () => {
    await updateWritingInstructions('project-1', '设定')
    await updateWritingStructure('project-1', JSON.stringify({ core: '新核心', sections: [], styleSamples: [] }))
    const projects = await listProjects()
    expect(projects[0]?.writingStructure).toBeTruthy()
  })
})

const structureProvider: ProviderConfig = {
  id: 'structure-test',
  name: 'Structure Test',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  protocol: 'openai-compatible',
  secretRef: 'provider:text',
  manualContextLength: 128_000,
  manualMaxOutputTokens: 4_096,
}

function structureResponse(content: string) {
  return { choices: [{ message: { content } }] }
}

function createStructureTransport(handler: (request: TransportRequest) => string): HttpTransport {
  return {
    async request<T>(request: TransportRequest) {
      return { status: 200, data: structureResponse(handler(request)) as T }
    },
    async stream() {
      throw new Error('not used')
    },
  }
}

describe('长期设定分块整理', () => {
  it('大窗口模型也会遵守每段最多 8000 字', async () => {
    const chunks: string[] = []
    const transport = createStructureTransport((request) => {
      const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> }
      chunks.push(body.messages[1].content)
      return JSON.stringify({
        core_fragments: [],
        sections: [{ title: '设定', content: `已提取第 ${chunks.length} 段`, tags: ['设定'], priority: 2 }],
        style_samples: [],
      })
    })

    await structureWritingInstructions('这是一段需要保留的设定。\n'.repeat(1_200), structureProvider, transport)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 8_000)).toBe(true)
  })

  it('分块连续失败两次后终止整次整理', async () => {
    let requests = 0
    const transport = createStructureTransport(() => {
      requests += 1
      return '不是 JSON'
    })

    await expect(structureWritingInstructions('需要整理的长期设定。'.repeat(30), structureProvider, transport))
      .rejects.toThrow(/第 1\/1 段设定整理失败/)
    expect(requests).toBe(2)
  })

  it('合并时保留超过 2000 字的核心规则供用户人工精简', async () => {
    const longCore = '必须遵守。'.repeat(500)
    const transport = createStructureTransport(() => JSON.stringify({
      core_fragments: [longCore],
      sections: [],
      style_samples: [],
    }))

    const result = await structureWritingInstructions('原始长期设定。'.repeat(30), structureProvider, transport)
    expect(result.core).toBe(longCore)
    expect(result.core.length).toBeGreaterThan(2_000)
  })
})

describe('章节号解析', () => {
  it.each([
    ['3', 3],
    ['三', 3],
    ['十二', 12],
    ['二十三', 23],
    ['一百零三', 103],
    ['二〇二', 202],
  ])('将 %s 解析为第 %i 章', (input, expected) => {
    expect(parseChapterOrder(input)).toBe(expected)
  })

  it('零和无效内容不产生章节号', () => {
    expect(parseChapterOrder('零')).toBeUndefined()
    expect(parseChapterOrder('第三')).toBeUndefined()
  })
})

describe('重试上下文去重', () => {
  it('excludeUserMessageId 从近期对话排除本轮原用户消息，避免重试重复注入', () => {
    const workspace = makeWorkspace()
    workspace.messages = [
      { id: 'user-0', projectId: 'project-1', kind: 'user', text: '旧的要求', order: 0, createdAt: 1 },
      { id: 'user-retry', projectId: 'project-1', kind: 'user', text: '本轮重试的要求', order: 1, createdAt: 2 },
      { id: 'notice-1', projectId: 'project-1', kind: 'notice', text: '生成中', order: 2, createdAt: 3, status: 'pending' },
    ]
    const estimator = resolveTokenEstimator({ protocol: 'openai-compatible', providerId: 'test', model: 'test' })

    const excluded = buildProjectContextForTokenBudget(workspace, [], 20_000, '本轮重试的要求', estimator, [], { excludeUserMessageId: 'user-retry' })
    expect(excluded.contextSections.recentMessages).toContain('旧的要求')
    expect(excluded.contextSections.recentMessages).not.toContain('本轮重试的要求')

    const included = buildProjectContextForTokenBudget(workspace, [], 20_000, '本轮重试的要求', estimator)
    expect(included.contextSections.recentMessages).toContain('本轮重试的要求')
  })
})
